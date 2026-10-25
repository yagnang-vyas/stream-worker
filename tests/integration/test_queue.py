from __future__ import annotations

import asyncio
import json
import time
from datetime import timedelta
from typing import Any

import pytest
import redis.asyncio as aioredis

from streamworker import ConfigError, Queue, SerializationError
from streamworker.errors import PayloadTooLargeError


async def test_enqueue_writes_job_fields(queue: Queue, redis: Any) -> None:
    job_id = await queue.enqueue("send", {"user_id": 42}, max_attempts=3)
    entries = await redis.xrange(queue.keys.stream)
    assert len(entries) == 1
    fields = entries[0][1]
    assert fields["id"] == job_id
    assert fields["task"] == "send"
    assert json.loads(fields["payload"]) == {"user_id": 42}
    assert fields["attempt"] == "1"
    assert fields["max_attempts"] == "3"
    assert abs(int(fields["enqueued_at"]) - time.time() * 1000) < 5000
    assert "idempotency_key" not in fields


async def test_enqueue_rejects_bad_input(queue: Queue) -> None:
    with pytest.raises(SerializationError):
        await queue.enqueue("t", object())
    with pytest.raises(PayloadTooLargeError):
        await Queue(queue.redis, "small", max_payload_bytes=5).enqueue("t", "123456")
    with pytest.raises(ConfigError):
        await queue.enqueue("", 1)
    with pytest.raises(ConfigError):
        await queue.enqueue("t", 1, max_attempts=0)
    with pytest.raises(ConfigError):
        await queue.enqueue("t", 1, delay=timedelta(seconds=-1))
    assert await queue.redis.xlen(queue.keys.stream) == 0


async def test_idempotency_key_dedupes_sequential(queue: Queue, redis: Any) -> None:
    first = await queue.enqueue("t", 1, idempotency_key="k")
    second = await queue.enqueue("t", 2, idempotency_key="k")
    assert first == second
    assert await redis.xlen(queue.keys.stream) == 1
    assert await redis.get(queue.keys.idempotency("k")) == first
    entry = (await redis.xrange(queue.keys.stream))[0][1]
    assert entry["idempotency_key"] == "k"


async def test_idempotency_concurrent_enqueue_creates_one_job(queue: Queue, redis: Any) -> None:
    ids = await asyncio.gather(
        *(queue.enqueue("t", {"n": i}, idempotency_key="welcome:42") for i in range(20))
    )
    assert len(set(ids)) == 1
    assert await redis.xlen(queue.keys.stream) == 1


async def test_idempotency_key_expires(redis: Any, queue_name: str) -> None:
    queue = Queue(redis, queue_name, idempotency_ttl=timedelta(milliseconds=50))
    first = await queue.enqueue("t", 1, idempotency_key="k")
    await asyncio.sleep(0.2)
    second = await queue.enqueue("t", 1, idempotency_key="k")
    assert first != second
    assert await redis.xlen(queue.keys.stream) == 2


async def test_idempotency_applies_to_delayed_jobs(queue: Queue, redis: Any) -> None:
    a = await queue.enqueue("t", 1, idempotency_key="k", delay=timedelta(seconds=30))
    b = await queue.enqueue("t", 1, idempotency_key="k")
    assert a == b
    assert await redis.zcard(queue.keys.delayed) == 1
    assert await redis.xlen(queue.keys.stream) == 0


async def test_delay_uses_server_time(queue: Queue, redis: Any) -> None:
    job_id = await queue.enqueue("t", 1, delay=timedelta(seconds=30))
    assert await redis.xlen(queue.keys.stream) == 0
    [(member, score)] = await redis.zrange(queue.keys.delayed, 0, -1, withscores=True)
    seconds, micros = await redis.time()
    now_ms = int(seconds) * 1000 + int(micros) // 1000
    assert 29_000 < score - now_ms <= 30_000
    decoded = json.loads(member)
    assert decoded["id"] == job_id
    assert decoded["attempt"] == "1"


async def test_max_len_trims_stream(redis: Any, queue_name: str) -> None:
    queue = Queue(redis, queue_name, max_len=10)
    for i in range(200):
        await queue.enqueue("t", i)
    assert await redis.xlen(queue.keys.stream) < 200


async def test_stats(queue: Queue, redis: Any) -> None:
    empty = await queue.stats()
    assert empty.to_dict() == {
        "length": 0,
        "pending": 0,
        "consumers": 0,
        "delayed": 0,
        "dead": 0,
        "oldest_pending_age_ms": None,
    }
    await queue.enqueue("t", 1)
    await queue.enqueue("t", 2)
    await queue.enqueue("t", 3, delay=timedelta(minutes=5))
    await redis.xgroup_create(queue.keys.stream, queue.group, id="0")
    await redis.xreadgroup(queue.group, "c1", {queue.keys.stream: ">"}, count=1)
    await asyncio.sleep(0.05)
    stats = await queue.stats()
    assert (stats.length, stats.pending, stats.consumers, stats.delayed, stats.dead) == (
        2,
        1,
        1,
        1,
        0,
    )
    assert stats.oldest_pending_age_ms is not None
    assert stats.oldest_pending_age_ms >= 50


async def test_dead_letter_management(queue: Queue, redis: Any) -> None:
    ids = []
    for i in range(3):
        ids.append(
            await redis.xadd(
                queue.keys.dead,
                {
                    "id": f"job{i}",
                    "task": "t",
                    "payload": "1",
                    "attempt": "5",
                    "max_attempts": "5",
                    "enqueued_at": "1",
                    "error_type": "Boom",
                    "error_message": "x",
                    "failed_at": "2",
                },
            )
        )
    page1 = await queue.dead_list(limit=2)
    assert [d.entry_id for d in page1] == ids[:2]
    page2 = await queue.dead_list(limit=2, after=page1[-1].entry_id)
    assert [d.entry_id for d in page2] == ids[2:]
    got = await queue.dead_get(ids[0])
    assert got is not None and got.fields["error_type"] == "Boom"
    assert await queue.dead_get("0-1") is None

    new_id = await queue.dead_requeue(ids[0])
    assert new_id is not None
    [(_, fields)] = await redis.xrange(queue.keys.stream)
    assert fields["attempt"] == "1" and fields["id"] == "job0"
    assert "error_type" not in fields and "failed_at" not in fields
    assert await queue.dead_get(ids[0]) is None
    assert await queue.dead_requeue(ids[0]) is None

    assert await queue.dead_purge(ids[1]) == 1
    assert await queue.dead_purge() == 1
    assert await redis.xlen(queue.keys.dead) == 0


async def test_requeue_respects_max_len(redis: Any, queue_name: str) -> None:
    queue = Queue(redis, queue_name, max_len=5)
    entry = await redis.xadd(queue.keys.dead, {"id": "a", "task": "t", "attempt": "9"})
    assert await queue.dead_requeue(entry) is not None


async def test_requires_decode_responses(queue_name: str) -> None:
    from tests.conftest import REDIS_URL

    raw = aioredis.from_url(REDIS_URL)
    try:
        with pytest.raises(ConfigError, match="decode_responses"):
            Queue(raw, queue_name)
    finally:
        await raw.aclose()


async def test_queue_config_validation(redis: Any) -> None:
    with pytest.raises(ConfigError):
        Queue(redis, "q", max_len=0)
    with pytest.raises(ConfigError):
        Queue(redis, "q", max_payload_bytes=0)
    with pytest.raises(ConfigError):
        Queue(redis, "q", idempotency_ttl=timedelta(0))
