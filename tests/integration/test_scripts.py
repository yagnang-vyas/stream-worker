"""Failure injection for the Lua scripts.

Redis does not roll back a script that errors part-way. We make the *second* write of
each script fail (by planting a wrong-typed key) and assert nothing was lost.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from redis.exceptions import ResponseError

from streamworker import Queue
from streamworker.job import Job


async def _pending_entry(queue: Queue, redis: Any) -> tuple[str, Job]:
    await queue.enqueue("t", {"n": 1}, max_attempts=3)
    await queue.ensure_group()
    await redis.xreadgroup(queue.group, "c", {queue.keys.stream: ">"}, count=1)
    [(entry_id, fields)] = await redis.xrange(queue.keys.stream)
    return entry_id, Job.from_fields(fields)


async def test_enqueue_failure_does_not_leave_idempotency_marker(queue: Queue, redis: Any) -> None:
    await redis.set(queue.keys.stream, "not a stream")
    with pytest.raises(ResponseError):
        await queue.enqueue("t", 1, idempotency_key="k")
    assert await redis.exists(queue.keys.idempotency("k")) == 0
    await redis.delete(queue.keys.stream)
    job_id = await queue.enqueue("t", 1, idempotency_key="k")  # not swallowed as a duplicate
    assert await redis.xlen(queue.keys.stream) == 1
    assert await redis.get(queue.keys.idempotency("k")) == job_id


async def test_promote_failure_keeps_job_in_delayed_set(queue: Queue, redis: Any) -> None:
    await queue.enqueue("t", 1, delay=timedelta(milliseconds=1))
    await redis.set(queue.keys.stream, "not a stream")
    import asyncio

    await asyncio.sleep(0.05)
    with pytest.raises(ResponseError):
        await queue.promote_due()
    assert await redis.zcard(queue.keys.delayed) == 1
    await redis.delete(queue.keys.stream)
    assert await queue.promote_due() == 1
    assert await redis.zcard(queue.keys.delayed) == 0
    assert await redis.xlen(queue.keys.stream) == 1


async def test_retry_failure_keeps_entry_pending(queue: Queue, redis: Any) -> None:
    entry_id, job = await _pending_entry(queue, redis)
    await redis.set(queue.keys.delayed, "not a zset")
    with pytest.raises(ResponseError):
        await queue.schedule_retry(entry_id, job.next_attempt(), timedelta(seconds=1))
    assert (await redis.xpending(queue.keys.stream, queue.group))["pending"] == 1
    assert await redis.xlen(queue.keys.stream) == 1


async def test_dead_failure_keeps_entry_pending(queue: Queue, redis: Any) -> None:
    entry_id, job = await _pending_entry(queue, redis)
    await redis.set(queue.keys.dead, "not a stream")
    with pytest.raises(ResponseError):
        await queue.move_to_dead(entry_id, job.to_fields(), "X", "y")
    assert (await redis.xpending(queue.keys.stream, queue.group))["pending"] == 1
    assert await redis.xlen(queue.keys.stream) == 1


async def test_retry_and_dead_are_noops_once_entry_is_no_longer_pending(
    queue: Queue, redis: Any
) -> None:
    entry_id, job = await _pending_entry(queue, redis)
    await queue.ack(entry_id)
    assert not await queue.schedule_retry(entry_id, job.next_attempt(), timedelta(seconds=1))
    assert not await queue.move_to_dead(entry_id, job.to_fields(), "X", "y")
    assert await redis.zcard(queue.keys.delayed) == 0
    assert await redis.xlen(queue.keys.dead) == 0


async def test_only_one_of_two_racing_retries_wins(queue: Queue, redis: Any) -> None:
    import asyncio

    entry_id, job = await _pending_entry(queue, redis)
    results = await asyncio.gather(
        *(
            queue.schedule_retry(entry_id, job.next_attempt(), timedelta(seconds=1))
            for _ in range(8)
        )
    )
    assert results.count(True) == 1
    assert await redis.zcard(queue.keys.delayed) == 1


@pytest.mark.parametrize("member", ['["a","b"]', '{"a":{"nested":1}}', "{}", '{"a":1}', "42"])
async def test_promote_rejects_structurally_invalid_members(
    queue: Queue, redis: Any, member: str
) -> None:
    await redis.zadd(queue.keys.delayed, {member: 0})
    assert await queue.promote_due() == 1
    [dead] = await queue.dead_list()
    assert dead.fields["error_type"] == "MalformedJob"
    assert dead.fields["payload"] == member
    assert await redis.zcard(queue.keys.delayed) == 0
    assert await redis.xlen(queue.keys.stream) == 0
