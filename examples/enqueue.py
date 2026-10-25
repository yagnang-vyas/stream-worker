"""Enqueue a few example jobs. Run with: python examples/enqueue.py"""

from __future__ import annotations

import asyncio
import os
from datetime import timedelta

import redis.asyncio as aioredis

from streamworker import Queue


async def main() -> None:
    redis = aioredis.from_url(
        os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0"), decode_responses=True
    )
    queue = Queue(redis, "emails", max_len=100_000)
    first = await queue.enqueue(
        "send_welcome", {"user_id": 42}, idempotency_key="welcome:42", max_attempts=5
    )
    again = await queue.enqueue("send_welcome", {"user_id": 42}, idempotency_key="welcome:42")
    print(f"enqueued {first}; duplicate call returned the same id: {first == again}")
    await queue.enqueue("flaky", {"n": 1}, max_attempts=5)
    await queue.enqueue("always_fails", {"n": 2}, max_attempts=3)
    await queue.enqueue("send_welcome", {"user_id": 43}, delay=timedelta(seconds=5))
    print(await queue.stats())
    await redis.aclose()


if __name__ == "__main__":
    asyncio.run(main())
