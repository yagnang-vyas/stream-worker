"""Consumer side: reads jobs, runs handlers, retries, dead-letters."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import logging
import os
import secrets
import signal
import socket
from collections.abc import Callable, Mapping
from datetime import timedelta
from typing import Any, cast

from streamworker.backoff import ExponentialBackoff
from streamworker.errors import ConfigError
from streamworker.job import Job
from streamworker.queue import Queue

logger = logging.getLogger("streamworker")

_ERROR_PAUSE = 1.0
_PROMOTE_BATCH = 100
_RECOVER_BATCH = 10
_CONNECTIONS_OVERHEAD = 4  # blocked reader, promoter, recovery, spare
_MAX_RECOVERY_INTERVAL = 5.0


def _seconds(td: timedelta) -> float:
    return td.total_seconds()


def _accepts_context(handler: Callable[..., Any]) -> bool:
    try:
        params = inspect.signature(handler).parameters.values()
    except (TypeError, ValueError):
        return False
    positional = [
        p
        for p in params
        if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    ]
    return len(positional) >= 2 or any(p.kind is inspect.Parameter.VAR_POSITIONAL for p in params)


class Worker:
    """Runs handlers for jobs from one :class:`Queue` with at-least-once delivery.

    Handlers are ``async def handler(payload)`` or ``async def handler(payload, ctx)``
    where ``ctx`` is a :class:`~streamworker.JobContext`. They must be idempotent.
    """

    def __init__(
        self,
        queue: Queue,
        handlers: Mapping[str, Callable[..., Any]],
        *,
        concurrency: int = 10,
        visibility_timeout: timedelta = timedelta(seconds=60),
        handler_timeout: timedelta = timedelta(seconds=30),
        backoff: Callable[[int], float] | None = None,
        shutdown_grace: timedelta = timedelta(seconds=30),
        poll_interval: timedelta = timedelta(seconds=1),
        promote_interval: timedelta = timedelta(seconds=1),
        recovery_interval: timedelta | None = None,
    ) -> None:
        if concurrency < 1:
            raise ConfigError("concurrency must be at least 1")
        if _seconds(handler_timeout) <= 0:
            raise ConfigError("handler_timeout must be positive")
        if _seconds(visibility_timeout) <= _seconds(handler_timeout):
            raise ConfigError("visibility_timeout must be greater than handler_timeout")
        if _seconds(shutdown_grace) < 0:
            raise ConfigError("shutdown_grace must not be negative")
        if _seconds(poll_interval) <= 0 or _seconds(promote_interval) <= 0:
            raise ConfigError("poll_interval and promote_interval must be positive")
        if recovery_interval is not None and _seconds(recovery_interval) <= 0:
            raise ConfigError("recovery_interval must be positive")
        for name, handler in handlers.items():
            if not callable(handler):
                raise ConfigError(f"handler for {name!r} is not callable")
        pool_size = getattr(queue.redis.connection_pool, "max_connections", None)
        if isinstance(pool_size, int) and pool_size < concurrency + _CONNECTIONS_OVERHEAD:
            logger.warning(
                "Redis pool allows %d connections but concurrency=%d needs about %d; "
                "raise max_connections to avoid MaxConnectionsError",
                pool_size,
                concurrency,
                concurrency + _CONNECTIONS_OVERHEAD,
            )
        self.queue = queue
        self.handlers = dict(handlers)
        self._wants_ctx = {name: _accepts_context(h) for name, h in self.handlers.items()}
        self.concurrency = concurrency
        self.visibility_timeout = visibility_timeout
        self.handler_timeout = handler_timeout
        self.backoff: Callable[[int], float] = backoff or ExponentialBackoff()
        self.shutdown_grace = shutdown_grace
        self.poll_interval = poll_interval
        self.promote_interval = promote_interval
        self.recovery_interval = recovery_interval or timedelta(
            seconds=min(_seconds(visibility_timeout) / 2, _MAX_RECOVERY_INTERVAL)
        )
        self.consumer = f"{socket.gethostname()}-{os.getpid()}-{secrets.token_hex(2)}"
        self._slots = asyncio.Semaphore(concurrency)
        self._stop = asyncio.Event()
        self._inflight: dict[asyncio.Task[None], str] = {}
        self._running = False

    # -- lifecycle ------------------------------------------------------------

    @property
    def inflight(self) -> int:
        """Number of jobs currently executing."""
        return len(self._inflight)

    @property
    def running(self) -> bool:
        """Whether :meth:`run` is active."""
        return self._running

    def stop(self) -> None:
        """Request a graceful shutdown. Safe to call from signal handlers."""
        self._stop.set()

    async def run(self, *, handle_signals: bool = False) -> None:
        """Process jobs until :meth:`stop` is called, then drain and return.

        With ``handle_signals``, SIGTERM and SIGINT trigger :meth:`stop`.
        On shutdown, in-flight jobs get ``shutdown_grace`` to finish; the rest are
        cancelled and stay pending, to be recovered by a worker later.
        """
        if self._running:
            raise RuntimeError("worker is already running")
        self._running = True
        loops: list[asyncio.Task[None]] = []
        installed = self._install_signal_handlers() if handle_signals else []
        try:
            await self.queue.ensure_group()
            loops = [
                asyncio.create_task(self._supervised(self._read_loop), name="sw-reader"),
                asyncio.create_task(self._supervised(self._promote_loop), name="sw-promoter"),
                asyncio.create_task(self._supervised(self._recovery_loop), name="sw-recovery"),
            ]
            await self._stop.wait()
            await self._drain(loops)
        except asyncio.CancelledError:
            self._stop.set()
            await self._cancel(*loops, *self._inflight)
            raise
        finally:
            loop = asyncio.get_running_loop()
            for sig in installed:
                loop.remove_signal_handler(sig)
            self._running = False

    def _install_signal_handlers(self) -> list[signal.Signals]:
        loop = asyncio.get_running_loop()
        installed: list[signal.Signals] = []
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, self.stop)
            except NotImplementedError:  # pragma: no cover - e.g. Windows
                break
            installed.append(sig)
        return installed

    async def _drain(self, loops: list[asyncio.Task[None]]) -> None:
        deadline = asyncio.get_running_loop().time() + _seconds(self.shutdown_grace)

        def remaining() -> float:
            return max(0.0, deadline - asyncio.get_running_loop().time())

        # Loops stop reading first, so nothing new is started while draining.
        if loops:
            _, stuck = await asyncio.wait(loops, timeout=remaining())
            await self._cancel(*stuck)
        if self._inflight:
            _, unfinished = await asyncio.wait(list(self._inflight), timeout=remaining())
            if unfinished:
                logger.warning(
                    "shutdown grace expired; %d job(s) left pending for recovery", len(unfinished)
                )
                await self._cancel(*unfinished)

    @staticmethod
    async def _cancel(*tasks: asyncio.Task[None]) -> None:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _sleep(self, seconds: float) -> None:
        """Sleep, waking early if a stop was requested."""
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(seconds):
                await self._stop.wait()

    async def _supervised(self, loop_fn: Callable[[], Any]) -> None:
        """Run a loop, surviving transient errors (e.g. Redis connection loss)."""
        while not self._stop.is_set():
            try:
                await loop_fn()
            except Exception as exc:
                logger.error("%s failed: %s; retrying", loop_fn.__name__, type(exc).__name__)
                await self._sleep(_ERROR_PAUSE)

    # -- slot management --------------------------------------------------------

    async def _reserve(self, want: int, wait: float) -> int:
        """Take between 1 and ``want`` slots, waiting up to ``wait`` seconds for the first."""
        try:
            async with asyncio.timeout(wait):
                await self._slots.acquire()
        except TimeoutError:
            return 0
        got = 1
        while got < want and not self._slots.locked():
            await self._slots.acquire()
            got += 1
        return got

    def _release(self, count: int) -> None:
        for _ in range(count):
            self._slots.release()

    def _spawn(self, entry_id: str, fields: dict[str, str]) -> None:
        """Start a job. The caller must hold one slot, released when the job ends."""
        task = asyncio.create_task(self._run_job(entry_id, fields), name=f"sw-job-{entry_id}")
        self._inflight[task] = entry_id
        task.add_done_callback(self._job_done)

    def _job_done(self, task: asyncio.Task[None]) -> None:
        self._inflight.pop(task, None)
        self._slots.release()

    # -- loops -----------------------------------------------------------------

    async def _read_loop(self) -> None:
        block_ms = max(1, int(_seconds(self.poll_interval) * 1000))
        while not self._stop.is_set():
            got = await self._reserve(self.concurrency, _seconds(self.poll_interval))
            if not got:
                continue
            used = 0
            try:
                response = await self.queue.redis.xreadgroup(
                    self.queue.group,
                    self.consumer,
                    {self.queue.keys.stream: ">"},
                    count=got,
                    block=block_ms,
                )
                for _stream, entries in cast("list[Any]", response or []):
                    for entry_id, fields in entries:
                        self._spawn(entry_id, fields)
                        used += 1
            finally:
                self._release(got - used)

    async def _recovery_loop(self) -> None:
        while not self._stop.is_set():
            await self._recover_once()
            await self._sleep(_seconds(self.recovery_interval))

    async def _recover_once(self) -> None:
        """Take over entries pending longer than the visibility timeout (crashed workers)."""
        redis = self.queue.redis
        min_idle_ms = int(_seconds(self.visibility_timeout) * 1000)
        start = "0-0"
        while not self._stop.is_set():
            got = await self._reserve(
                min(self.concurrency, _RECOVER_BATCH), _seconds(self.recovery_interval)
            )
            if not got:
                return
            used = 0
            try:
                result: list[Any] = await redis.xautoclaim(
                    self.queue.keys.stream,
                    self.queue.group,
                    self.consumer,
                    min_idle_time=min_idle_ms,
                    start_id=start,
                    count=got,
                )
                next_start, entries = result[0], result[1]
                deleted = result[2] if len(result) > 2 else []
                if deleted:
                    logger.warning(
                        "recovery: %d pending entr(ies) had been deleted from the stream",
                        len(deleted),
                    )
                for entry_id, fields in entries:
                    if await self._recover_entry(entry_id, fields):
                        used += 1
            finally:
                self._release(got - used)
            if next_start == "0-0":
                return
            start = next_start

    async def _recover_entry(self, entry_id: str, fields: dict[str, str] | None) -> bool:
        """Dead-letter a poison entry or start it again. Returns True if a job was started."""
        queue = self.queue
        if not fields:  # deleted entry (Redis < 7.0 reports these as empty)
            await queue.redis.xack(queue.keys.stream, queue.group, entry_id)
            return False
        if entry_id in self._inflight.values():
            return False
        rows = await queue.redis.xpending_range(
            queue.keys.stream, queue.group, min=entry_id, max=entry_id, count=1
        )
        if not rows:  # acknowledged by someone else in the meantime
            return False
        deliveries = int(rows[0]["times_delivered"])
        try:
            max_attempts = int(fields["max_attempts"])
        except (KeyError, ValueError):
            max_attempts = None  # malformed; _process dead-letters it
        if max_attempts is not None and deliveries > max_attempts:
            logger.warning(
                "job %s: delivered %d times (max %d); dead-lettering as poison",
                fields.get("id", entry_id),
                deliveries,
                max_attempts,
            )
            await queue.move_to_dead(
                entry_id,
                fields,
                "MaxDeliveriesExceeded",
                f"delivered {deliveries} times without being acknowledged",
            )
            return False
        logger.info("job %s: recovered from a stalled worker", fields.get("id", entry_id))
        self._spawn(entry_id, fields)
        return True

    async def _promote_loop(self) -> None:
        while not self._stop.is_set():
            moved = await self.queue.promote_due(_PROMOTE_BATCH)
            if moved < _PROMOTE_BATCH:
                await self._sleep(_seconds(self.promote_interval))

    # -- job execution -----------------------------------------------------------

    async def _run_job(self, entry_id: str, fields: dict[str, str]) -> None:
        try:
            await self._process(entry_id, fields)
        except Exception as exc:
            # The entry stays pending and is recovered after the visibility timeout.
            logger.error(
                "job %s: processing failed: %s", fields.get("id", entry_id), type(exc).__name__
            )

    async def _process(self, entry_id: str, fields: dict[str, str]) -> None:
        try:
            job = Job.from_fields(fields)
            payload = json.loads(job.payload)
        except ValueError:
            logger.warning("entry %s is malformed; dead-lettering", entry_id)
            await self.queue.move_to_dead(entry_id, fields, "MalformedJob", "job is malformed")
            return
        handler = self.handlers.get(job.task)
        if handler is None:
            logger.warning("job %s: no handler for task %s; dead-lettering", job.id, job.task)
            await self.queue.move_to_dead(
                entry_id, job.to_fields(), "UnknownTask", f"no handler registered for {job.task!r}"
            )
            return
        try:
            async with asyncio.timeout(_seconds(self.handler_timeout)):
                if self._wants_ctx[job.task]:
                    result = handler(payload, job.context())
                else:
                    result = handler(payload)
                if inspect.isawaitable(result):
                    await result
        except Exception as exc:
            await self._on_failure(entry_id, job, exc)
        else:
            await self.queue.ack(entry_id)
            logger.debug("job %s (%s) succeeded", job.id, job.task)

    async def _on_failure(self, entry_id: str, job: Job, exc: Exception) -> None:
        error_type = type(exc).__name__
        if job.attempt < job.max_attempts:
            delay = timedelta(seconds=max(0.0, self.backoff(job.attempt)))
            logger.info(
                "job %s (%s) attempt %d/%d failed: %s; retrying in %.3fs",
                job.id,
                job.task,
                job.attempt,
                job.max_attempts,
                error_type,
                delay.total_seconds(),
            )
            await self.queue.schedule_retry(entry_id, job.next_attempt(), delay)
        else:
            logger.warning(
                "job %s (%s) failed permanently after %d attempts: %s",
                job.id,
                job.task,
                job.attempt,
                error_type,
            )
            await self.queue.move_to_dead(entry_id, job.to_fields(), error_type, str(exc))
