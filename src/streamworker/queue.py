"""Producer-side API: enqueue jobs, inspect and manage the dead-letter stream."""

from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass
from datetime import timedelta
from typing import Any, cast

from redis.asyncio import Redis
from redis.exceptions import ResponseError

from streamworker import scripts
from streamworker.errors import ConfigError
from streamworker.job import DeadJob, Job
from streamworker.keys import DEFAULT_GROUP, Keys
from streamworker.serialization import DEFAULT_MAX_PAYLOAD_BYTES, dumps_payload

DEFAULT_MAX_ATTEMPTS = 5
DEFAULT_IDEMPOTENCY_TTL = timedelta(days=1)
MAX_ERROR_MESSAGE_CHARS = 1000


@dataclass(frozen=True, slots=True)
class QueueStats:
    """A point-in-time snapshot of a queue."""

    length: int
    pending: int
    consumers: int
    delayed: int
    dead: int
    oldest_pending_age_ms: int | None

    def to_dict(self) -> dict[str, int | None]:
        return asdict(self)


def _ms(td: timedelta) -> int:
    return int(td.total_seconds() * 1000)


class Queue:
    """A named job queue backed by one Redis stream.

    ``redis`` must be created with ``decode_responses=True``.
    """

    def __init__(
        self,
        redis: Redis,
        name: str,
        *,
        max_len: int | None = None,
        max_payload_bytes: int = DEFAULT_MAX_PAYLOAD_BYTES,
        idempotency_ttl: timedelta = DEFAULT_IDEMPOTENCY_TTL,
        group: str = DEFAULT_GROUP,
    ) -> None:
        kwargs: dict[str, Any] = redis.get_connection_kwargs()  # type: ignore[no-untyped-call]
        if not kwargs.get("decode_responses"):
            raise ConfigError("the Redis client must be created with decode_responses=True")
        if str(kwargs.get("protocol", 2)) != "2":
            raise ConfigError("only the RESP2 protocol (the redis-py default) is supported")
        if max_len is not None and max_len < 1:
            raise ConfigError("max_len must be positive")
        if max_payload_bytes < 1:
            raise ConfigError("max_payload_bytes must be positive")
        if _ms(idempotency_ttl) < 1:
            raise ConfigError("idempotency_ttl must be at least 1 ms")
        self.redis = redis
        self.name = name
        self.keys = Keys(name)
        self.max_len = max_len
        self.max_payload_bytes = max_payload_bytes
        self.idempotency_ttl = idempotency_ttl
        self.group = group
        self._enqueue = redis.register_script(scripts.ENQUEUE)
        self._promote = redis.register_script(scripts.PROMOTE)
        self._retry = redis.register_script(scripts.RETRY)
        self._dead = redis.register_script(scripts.DEAD)
        self._requeue = redis.register_script(scripts.REQUEUE)

    @property
    def _maxlen_arg(self) -> str:
        return str(self.max_len or 0)

    async def enqueue(
        self,
        task: str,
        payload: Any = None,
        *,
        idempotency_key: str | None = None,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        delay: timedelta | None = None,
    ) -> str:
        """Add a job and return its id.

        With ``idempotency_key``, a repeat call within ``idempotency_ttl`` enqueues
        nothing and returns the original job's id. Raises ``SerializationError`` if
        the payload is not JSON-serialisable or exceeds the size limit.
        """
        if not task:
            raise ConfigError("task name must be non-empty")
        if max_attempts < 1:
            raise ConfigError("max_attempts must be at least 1")
        delay_ms = _ms(delay) if delay is not None else 0
        if delay_ms < 0:
            raise ConfigError("delay must not be negative")
        job = Job(
            id=str(uuid.uuid4()),
            task=task,
            payload=dumps_payload(payload, self.max_payload_bytes),
            attempt=1,
            max_attempts=max_attempts,
            enqueued_at=int(time.time() * 1000),
            idempotency_key=idempotency_key,
        )
        keys = [self.keys.stream, self.keys.delayed]
        if idempotency_key is not None:
            keys.append(self.keys.idempotency(idempotency_key))
        args: list[str | int] = [job.id, self._maxlen_arg, delay_ms, _ms(self.idempotency_ttl)]
        for field, value in job.to_fields().items():
            args += [field, value]
        result: str = await self._enqueue(keys=keys, args=args)
        return result

    async def stats(self) -> QueueStats:
        """Return queue depth, in-flight, consumer and dead-letter counts."""
        redis = self.redis
        length = await redis.xlen(self.keys.stream)
        delayed = await redis.zcard(self.keys.delayed)
        dead = await redis.xlen(self.keys.dead)
        pending = consumers = 0
        oldest: int | None = None
        try:
            groups = await redis.xinfo_groups(self.keys.stream)
        except ResponseError:  # stream does not exist yet
            groups = []
        for info in groups:
            if info["name"] == self.group:
                pending = int(info["pending"])
                consumers = int(info["consumers"])
        if pending:
            summary = await redis.xpending(self.keys.stream, self.group)
            if summary.get("min"):
                seconds, micros = await redis.time()
                now_ms = int(seconds) * 1000 + int(micros) // 1000
                oldest = max(0, now_ms - int(str(summary["min"]).split("-")[0]))
        return QueueStats(length, pending, consumers, delayed, dead, oldest)

    async def dead_list(self, *, limit: int = 50, after: str | None = None) -> list[DeadJob]:
        """List dead-letter entries oldest first, optionally after an entry id."""
        start = f"({after}" if after else "-"
        rows = cast(
            "list[tuple[str, dict[str, str]]]",
            await self.redis.xrange(self.keys.dead, min=start, max="+", count=limit),
        )
        return [DeadJob(entry_id, dict(fields)) for entry_id, fields in rows]

    async def dead_get(self, entry_id: str) -> DeadJob | None:
        rows = cast(
            "list[tuple[str, dict[str, str]]]",
            await self.redis.xrange(self.keys.dead, min=entry_id, max=entry_id),
        )
        return DeadJob(rows[0][0], dict(rows[0][1])) if rows else None

    async def dead_requeue(self, entry_id: str) -> str | None:
        """Move a dead job back to the stream with ``attempt`` reset to 1.

        Returns the new stream entry id, or ``None`` if there is no such entry.
        """
        new_id: str | None = await self._requeue(
            keys=[self.keys.dead, self.keys.stream], args=[entry_id, self._maxlen_arg]
        )
        return new_id

    async def dead_purge(self, entry_id: str | None = None) -> int:
        """Delete one dead entry, or all of them. Returns how many were deleted."""
        if entry_id is not None:
            return int(await self.redis.xdel(self.keys.dead, entry_id))
        count = int(await self.redis.xlen(self.keys.dead))
        await self.redis.delete(self.keys.dead)
        return count

    # -- worker-facing operations -------------------------------------------------

    async def ensure_group(self) -> None:
        """Create the consumer group (and stream) if missing."""
        try:
            await self.redis.xgroup_create(self.keys.stream, self.group, id="0", mkstream=True)
        except ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    async def promote_due(self, limit: int = 100) -> int:
        """Move up to ``limit`` due delayed jobs into the stream. Safe to run concurrently."""
        moved: int = await self._promote(
            keys=[self.keys.delayed, self.keys.stream, self.keys.dead],
            args=[limit, self._maxlen_arg],
        )
        return moved

    async def schedule_retry(self, entry_id: str, next_job: Job, delay: timedelta) -> bool:
        """Atomically ack ``entry_id`` and schedule ``next_job`` after ``delay``.

        Returns False (and does nothing) if the entry was no longer pending.
        """
        done: int = await self._retry(
            keys=[self.keys.stream, self.keys.delayed],
            args=[self.group, entry_id, _ms(delay), next_job.to_member()],
        )
        return bool(done)

    async def move_to_dead(
        self, entry_id: str, job_fields: dict[str, str], error_type: str, error_message: str
    ) -> bool:
        """Atomically ack ``entry_id`` and append the job plus error info to the dead stream.

        Returns False (and does nothing) if the entry was no longer pending.
        """
        fields = {
            **job_fields,
            "error_type": error_type,
            "error_message": error_message[:MAX_ERROR_MESSAGE_CHARS],
            "failed_at": str(int(time.time() * 1000)),
        }
        args: list[str] = [self.group, entry_id]
        for key, value in fields.items():
            args += [key, value]
        done: int = await self._dead(keys=[self.keys.stream, self.keys.dead], args=args)
        return bool(done)

    async def ack(self, entry_id: str) -> None:
        """Acknowledge and delete a successfully processed entry."""
        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.xack(self.keys.stream, self.group, entry_id)
            pipe.xdel(self.keys.stream, entry_id)
            await pipe.execute()
