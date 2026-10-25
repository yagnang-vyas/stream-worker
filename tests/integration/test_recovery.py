"""In-process recovery tests: stale pending entries, poison messages, deleted entries."""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import Any

import pytest

from streamworker import Queue
from tests.helpers import is_drained, make_worker, running, wait_until

FAST = {"visibility_timeout": timedelta(seconds=0.4), "handler_timeout": timedelta(seconds=0.3)}


async def _strand(queue: Queue, redis: Any, count: int = 1, **enqueue: Any) -> list[str]:
    """Enqueue jobs and leave them pending under a consumer that never acks (a crash)."""
    ids = [await queue.enqueue("t", i, **enqueue) for i in range(count)]
    await queue.ensure_group()
    await redis.xreadgroup(queue.group, "dead-consumer", {queue.keys.stream: ">"}, count=count)
    assert (await queue.stats()).pending == count
    return ids


async def test_stale_pending_entry_is_recovered_and_runs_once(queue: Queue, redis: Any) -> None:
    runs: list[int] = []

    async def handler(payload: int) -> None:
        runs.append(payload)

    await _strand(queue, redis)
    async with running(make_worker(queue, {"t": handler}, **FAST)):
        await wait_until(lambda: is_drained(queue))
    assert runs == [0]


async def test_recovery_waits_for_visibility_timeout(queue: Queue, redis: Any) -> None:
    runs: list[int] = []

    async def handler(payload: int) -> None:
        runs.append(payload)

    await _strand(queue, redis)
    worker = make_worker(
        queue,
        {"t": handler},
        visibility_timeout=timedelta(seconds=3),
        handler_timeout=timedelta(seconds=1),
    )
    async with running(worker):
        await asyncio.sleep(1.0)
        assert runs == []
        assert (await queue.stats()).pending == 1


async def test_many_stale_entries_are_all_recovered(queue: Queue, redis: Any) -> None:
    runs: list[int] = []

    async def handler(payload: int) -> None:
        runs.append(payload)

    await _strand(queue, redis, count=25)
    async with running(make_worker(queue, {"t": handler}, concurrency=5, **FAST)):
        await wait_until(lambda: is_drained(queue))
    assert sorted(runs) == list(range(25))


async def test_poison_entry_is_dead_lettered_without_running(queue: Queue, redis: Any) -> None:
    async def handler(payload: Any) -> None:
        raise AssertionError("poison job must not run")

    [job_id] = await _strand(queue, redis, max_attempts=2)
    [(entry_id, _)] = await redis.xrange(queue.keys.stream)
    for _ in range(2):  # XCLAIM bumps the delivery counter: 1 -> 3, i.e. > max_attempts
        await redis.xclaim(queue.keys.stream, queue.group, "dead-consumer", 0, [entry_id])
    async with running(make_worker(queue, {"t": handler}, **FAST)):
        await wait_until(lambda: queue.dead_list())
        await wait_until(lambda: is_drained(queue))
    [dead] = await queue.dead_list()
    assert dead.fields["id"] == job_id
    assert dead.fields["error_type"] == "MaxDeliveriesExceeded"


async def test_entry_at_exactly_max_deliveries_still_runs(queue: Queue, redis: Any) -> None:
    runs: list[int] = []

    async def handler(payload: int) -> None:
        runs.append(payload)

    await _strand(queue, redis, max_attempts=2)
    # deliveries so far = 1; the recovery claim makes it 2 == max_attempts: allowed.
    async with running(make_worker(queue, {"t": handler}, **FAST)):
        await wait_until(lambda: is_drained(queue))
    assert runs == [0]
    assert (await queue.stats()).dead == 0


async def test_entries_deleted_while_pending_are_reported_and_cleared(
    queue: Queue, redis: Any, caplog: pytest.LogCaptureFixture
) -> None:
    await _strand(queue, redis, count=2)
    entries = await redis.xrange(queue.keys.stream)
    await redis.xdel(queue.keys.stream, entries[0][0])
    runs: list[int] = []

    async def handler(payload: int) -> None:
        runs.append(payload)

    caplog.set_level(logging.WARNING, logger="streamworker")
    async with running(make_worker(queue, {"t": handler}, **FAST)):
        await wait_until(lambda: is_drained(queue))
    assert runs == [1]
    assert "had been deleted" in caplog.text


async def test_recover_entry_edge_cases(queue: Queue, redis: Any) -> None:
    worker = make_worker(queue, {"t": lambda p: None}, **FAST)
    await queue.ensure_group()
    # Empty fields (Redis < 7.0 reports deleted entries like this): acked, not started.
    entry = await redis.xadd(queue.keys.stream, {"a": "b"})
    await redis.xreadgroup(queue.group, "x", {queue.keys.stream: ">"})
    assert await worker._recover_entry(entry, None) is False
    assert (await queue.stats()).pending == 0
    # Not pending any more: skipped.
    assert await worker._recover_entry("1-1", {"id": "z", "max_attempts": "1"}) is False


async def test_recovered_malformed_entry_is_dead_lettered(queue: Queue, redis: Any) -> None:
    await queue.ensure_group()
    await redis.xadd(queue.keys.stream, {"task": "t"})
    await redis.xreadgroup(queue.group, "x", {queue.keys.stream: ">"})
    async with running(make_worker(queue, {"t": lambda p: None}, **FAST)):
        await wait_until(lambda: queue.dead_list())
    [dead] = await queue.dead_list()
    assert dead.fields["error_type"] == "MalformedJob"


async def test_slow_handler_is_not_reclaimed_by_its_own_worker(queue: Queue) -> None:
    runs = 0

    async def handler(payload: Any) -> None:
        nonlocal runs
        runs += 1
        await asyncio.sleep(0.6)

    await queue.enqueue("t", 1)
    worker = make_worker(
        queue,
        {"t": handler},
        visibility_timeout=timedelta(seconds=1),
        handler_timeout=timedelta(seconds=0.9),
        recovery_interval=timedelta(seconds=0.1),
    )
    async with running(worker):
        await wait_until(lambda: is_drained(queue))
    assert runs == 1
