from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import timedelta
from typing import Any

import pytest

from streamworker import ConfigError, ExponentialBackoff, JobContext, Queue, Worker
from tests.helpers import is_drained, make_worker, running, wait_until


async def test_happy_path_processes_exactly_once(queue: Queue) -> None:
    seen: list[Any] = []

    async def handler(payload: Any) -> None:
        seen.append(payload)

    await queue.enqueue("echo", {"n": 1})
    async with running(make_worker(queue, {"echo": handler})):
        await wait_until(lambda: is_drained(queue))
    assert seen == [{"n": 1}]
    stats = await queue.stats()
    assert (stats.length, stats.pending, stats.delayed, stats.dead) == (0, 0, 0, 0)


async def test_handler_receives_context(queue: Queue) -> None:
    contexts: list[JobContext] = []

    async def handler(payload: Any, ctx: JobContext) -> None:
        contexts.append(ctx)

    job_id = await queue.enqueue("t", 1, max_attempts=4)
    async with running(make_worker(queue, {"t": handler})):
        await wait_until(lambda: contexts)
    [ctx] = contexts
    assert (ctx.job_id, ctx.task, ctx.attempt, ctx.max_attempts) == (job_id, "t", 1, 4)
    assert abs(ctx.enqueued_at.timestamp() - time.time()) < 10


async def test_jobs_enqueued_before_group_exists_are_processed(queue: Queue) -> None:
    done: list[int] = []

    async def handler(payload: int) -> None:
        done.append(payload)

    for i in range(3):
        await queue.enqueue("t", i)
    async with running(make_worker(queue, {"t": handler})):
        await wait_until(lambda: len(done) == 3)
    assert sorted(done) == [0, 1, 2]


async def test_retry_then_success_with_backoff(queue: Queue) -> None:
    attempts: list[tuple[int, float]] = []

    async def flaky(payload: Any, ctx: JobContext) -> None:
        attempts.append((ctx.attempt, time.monotonic()))
        if ctx.attempt < 3:
            raise RuntimeError("transient")

    backoff = ExponentialBackoff(base=0.15, cap=1.0, jitter="none")
    await queue.enqueue("flaky", 1, max_attempts=5)
    async with running(make_worker(queue, {"flaky": flaky}, backoff=backoff)):
        await wait_until(lambda: len(attempts) == 3 and is_drained(queue))
    assert [a for a, _ in attempts] == [1, 2, 3]
    gap1 = attempts[1][1] - attempts[0][1]
    gap2 = attempts[2][1] - attempts[1][1]
    assert 0.15 <= gap1 < 0.15 + 1.0
    assert 0.30 <= gap2 < 0.30 + 1.0
    assert (await queue.stats()).dead == 0


async def test_dead_letter_after_max_attempts(queue: Queue, redis: Any) -> None:
    calls = 0

    async def always_fails(payload: Any) -> None:
        nonlocal calls
        calls += 1
        raise ValueError("x" * 2000)

    job_id = await queue.enqueue("bad", {"k": "v"}, max_attempts=3)
    backoff = ExponentialBackoff(base=0.01, cap=0.05, jitter="none")
    async with running(make_worker(queue, {"bad": always_fails}, backoff=backoff)):
        await wait_until(lambda: queue.dead_list())
        await wait_until(lambda: is_drained(queue))
    assert calls == 3
    [dead] = await queue.dead_list()
    assert dead.fields["id"] == job_id
    assert dead.fields["task"] == "bad"
    assert dead.fields["attempt"] == "3"
    assert dead.fields["max_attempts"] == "3"
    assert dead.fields["error_type"] == "ValueError"
    assert dead.fields["error_message"] == "x" * 1000
    assert abs(int(dead.fields["failed_at"]) - time.time() * 1000) < 10_000
    assert json.loads(dead.fields["payload"]) == {"k": "v"}


async def test_unknown_task_goes_straight_to_dead(queue: Queue) -> None:
    async def other(payload: Any) -> None: ...

    await queue.enqueue("mystery", 1, max_attempts=5)
    async with running(make_worker(queue, {"other": other})):
        await wait_until(lambda: queue.dead_list())
    [dead] = await queue.dead_list()
    assert dead.fields["error_type"] == "UnknownTask"
    assert dead.fields["attempt"] == "1"
    assert await is_drained(queue)


async def test_handler_timeout_counts_as_failure(queue: Queue) -> None:
    async def slow(payload: Any) -> None:
        await asyncio.sleep(30)

    await queue.enqueue("slow", 1, max_attempts=1)
    worker = make_worker(
        queue,
        {"slow": slow},
        handler_timeout=timedelta(milliseconds=100),
        visibility_timeout=timedelta(seconds=1),
    )
    async with running(worker):
        await wait_until(lambda: queue.dead_list())
    [dead] = await queue.dead_list()
    assert dead.fields["error_type"] == "TimeoutError"


@pytest.mark.parametrize(
    "fields",
    [
        {"task": "t"},
        {
            "id": "x",
            "task": "t",
            "payload": "{not json",
            "attempt": "1",
            "max_attempts": "1",
            "enqueued_at": "1",
        },
    ],
)
async def test_malformed_entries_are_dead_lettered(
    queue: Queue, redis: Any, fields: dict[str, str]
) -> None:
    async def handler(payload: Any) -> None:
        raise AssertionError("must not run")

    await redis.xadd(queue.keys.stream, fields)
    async with running(make_worker(queue, {"t": handler})):
        await wait_until(lambda: queue.dead_list())
    [dead] = await queue.dead_list()
    assert dead.fields["error_type"] == "MalformedJob"


async def test_delayed_job_runs_after_delay(queue: Queue) -> None:
    ran: list[float] = []

    async def handler(payload: Any) -> None:
        ran.append(time.monotonic())

    start = time.monotonic()
    await queue.enqueue("t", 1, delay=timedelta(milliseconds=400))
    async with running(make_worker(queue, {"t": handler})):
        await asyncio.sleep(0.2)
        assert not ran
        await wait_until(lambda: ran)
    assert ran[0] - start >= 0.4


async def test_concurrency_limit_is_respected(queue: Queue) -> None:
    active = peak = done = 0

    async def handler(payload: Any) -> None:
        nonlocal active, peak, done
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.05)
        active -= 1
        done += 1

    for i in range(24):
        await queue.enqueue("t", i)
    worker = make_worker(queue, {"t": handler}, concurrency=3)
    async with running(worker):
        await wait_until(lambda: done == 24)
    assert peak == 3


async def test_many_jobs_three_workers_all_acknowledged(queue: Queue) -> None:
    processed: dict[int, int] = {}

    async def handler(payload: int) -> None:
        processed[payload] = processed.get(payload, 0) + 1
        await asyncio.sleep(0)

    total = 500
    for i in range(total):
        await queue.enqueue("t", i)
    workers = [make_worker(queue, {"t": handler}, concurrency=10) for _ in range(3)]
    async with running(*workers):
        await wait_until(lambda: is_drained(queue), within=60)
    assert set(processed) == set(range(total))
    duplicates = {k: v for k, v in processed.items() if v > 1}
    assert duplicates == {}
    assert (await queue.stats()).dead == 0


async def test_promoter_race_never_duplicates(queue: Queue, redis: Any) -> None:
    total = 300
    for i in range(total):
        await queue.enqueue("t", i, delay=timedelta(milliseconds=50))
    await asyncio.sleep(0.2)

    async def promoter() -> None:
        while await redis.zcard(queue.keys.delayed):
            await queue.promote_due(7)

    await asyncio.gather(*(promoter() for _ in range(4)))
    entries = await redis.xrange(queue.keys.stream)
    ids = [fields["id"] for _, fields in entries]
    assert len(ids) == total
    assert len(set(ids)) == total


async def test_promote_malformed_member_goes_to_dead(queue: Queue, redis: Any) -> None:
    await redis.zadd(queue.keys.delayed, {"not json": 0})
    assert await queue.promote_due() == 1
    [dead] = await queue.dead_list()
    assert dead.fields["error_type"] == "MalformedJob"
    assert dead.fields["payload"] == "not json"
    assert await redis.zcard(queue.keys.delayed) == 0


async def test_stale_entry_operations_are_noops(queue: Queue) -> None:
    await queue.ensure_group()
    await queue.ensure_group()  # idempotent (BUSYGROUP ignored)
    job = (await _make_job(queue)).next_attempt()
    assert not await queue.schedule_retry("1-1", job, timedelta(seconds=1))
    assert not await queue.move_to_dead("1-1", job.to_fields(), "X", "y")
    assert await queue.stats() is not None


async def _make_job(queue: Queue) -> Any:
    from streamworker.job import Job

    return Job("a", "t", "1", 1, 3, 0)


async def test_ack_failure_leaves_job_pending_and_logs_type_only(
    queue: Queue, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    ran = 0

    async def handler(payload: Any) -> None:
        nonlocal ran
        ran += 1

    async def broken_ack(entry_id: str) -> None:
        raise ConnectionError("secret-host-detail")

    monkeypatch.setattr(queue, "ack", broken_ack)
    await queue.enqueue("t", {"email": "alice@example.com"})
    caplog.set_level(logging.DEBUG, logger="streamworker")
    async with running(make_worker(queue, {"t": handler})):
        await wait_until(lambda: ran == 1)
        await wait_until(lambda: "processing failed" in caplog.text)
    assert (await queue.stats()).pending == 1
    assert "ConnectionError" in caplog.text
    assert "secret-host-detail" not in caplog.text
    assert "alice@example.com" not in caplog.text


async def test_loop_survives_transient_errors(
    queue: Queue, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    calls = 0
    real = queue.promote_due

    async def flaky_promote(limit: int = 100) -> int:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ConnectionError("down")
        return await real(limit)

    monkeypatch.setattr(queue, "promote_due", flaky_promote)
    done: list[int] = []

    async def handler(payload: int) -> None:
        done.append(payload)

    await queue.enqueue("t", 1, delay=timedelta(milliseconds=10))
    caplog.set_level(logging.ERROR, logger="streamworker")
    async with running(make_worker(queue, {"t": handler})):
        await wait_until(lambda: done, within=10)
    assert "ConnectionError" in caplog.text


async def test_cancelling_run_cancels_inflight_jobs_and_reraises(queue: Queue) -> None:
    started = asyncio.Event()

    async def handler(payload: Any) -> None:
        started.set()
        await asyncio.sleep(60)

    await queue.enqueue("t", 1)
    worker = make_worker(queue, {"t": handler})
    task = asyncio.create_task(worker.run())
    await asyncio.wait_for(started.wait(), 10)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert worker.inflight == 0
    assert (await queue.stats()).pending == 1


async def test_run_twice_is_rejected(queue: Queue) -> None:
    worker = make_worker(queue, {})
    async with running(worker):
        await asyncio.sleep(0.05)
        with pytest.raises(RuntimeError):
            await worker.run()


async def test_sync_handler_and_varargs_context(queue: Queue) -> None:
    got: list[Any] = []

    def sync_handler(payload: Any) -> None:
        got.append(("sync", payload))

    async def varargs(*args: Any) -> None:
        got.append(("varargs", len(args)))

    await queue.enqueue("a", 1)
    await queue.enqueue("b", 2)
    async with running(make_worker(queue, {"a": sync_handler, "b": varargs})):
        await wait_until(lambda: len(got) == 2)
    assert sorted(got) == [("sync", 1), ("varargs", 2)]


@pytest.mark.parametrize(
    "kwargs",
    [
        {"concurrency": 0},
        {"handler_timeout": timedelta(0)},
        {"visibility_timeout": timedelta(seconds=2), "handler_timeout": timedelta(seconds=2)},
        {"shutdown_grace": timedelta(seconds=-1)},
        {"poll_interval": timedelta(0)},
    ],
)
async def test_worker_config_validation(queue: Queue, kwargs: dict[str, Any]) -> None:
    with pytest.raises(ConfigError):
        Worker(queue, {}, **kwargs)


async def test_uninspectable_and_noncallable_handlers(queue: Queue) -> None:
    with pytest.raises(ConfigError):
        Worker(queue, {"t": "nope"})  # type: ignore[dict-item]
    Worker(queue, {"t": print})  # builtin with a signature; just constructs


async def test_small_connection_pool_is_warned_about(
    redis: Any, queue_name: str, caplog: pytest.LogCaptureFixture
) -> None:
    import redis.asyncio as aioredis

    from tests.conftest import REDIS_URL

    small = aioredis.from_url(REDIS_URL, decode_responses=True, max_connections=5)
    try:
        caplog.set_level(logging.WARNING, logger="streamworker")
        Worker(Queue(small, queue_name), {}, concurrency=10)
        assert "raise max_connections" in caplog.text
    finally:
        await small.aclose()
