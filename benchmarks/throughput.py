"""A rough throughput measurement you can run against your own Redis.

    python benchmarks/throughput.py --jobs 5000 --concurrency 50

Results depend entirely on your hardware, network and Redis configuration, which is
why none are quoted in the README.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import time
import uuid
from datetime import timedelta
from typing import Any

import redis.asyncio as aioredis

from streamworker import Queue, Worker


async def main(jobs: int, concurrency: int) -> None:
    redis = aioredis.from_url(
        os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0"), decode_responses=True
    )
    queue = Queue(redis, f"bench-{uuid.uuid4().hex[:6]}")
    done = 0
    finished = asyncio.Event()

    async def noop(payload: Any) -> None:
        nonlocal done
        done += 1
        if done == jobs:
            finished.set()

    start = time.perf_counter()
    gate = asyncio.Semaphore(50)  # stay well below the connection pool size

    async def enqueue(n: int) -> None:
        async with gate:
            await queue.enqueue("noop", {"n": n})

    await asyncio.gather(*(enqueue(i) for i in range(jobs)))
    enqueued = time.perf_counter()
    worker = Worker(
        queue,
        {"noop": noop},
        concurrency=concurrency,
        poll_interval=timedelta(milliseconds=100),
    )
    task = asyncio.create_task(worker.run())
    await finished.wait()
    end = time.perf_counter()
    worker.stop()
    await task
    print(f"enqueue: {jobs / (enqueued - start):,.0f} jobs/s")
    print(f"process: {jobs / (end - enqueued):,.0f} jobs/s (concurrency={concurrency})")
    keys = [k async for k in redis.scan_iter(match=f"sw:{queue.name}:*")]
    if keys:
        await redis.delete(*keys)
    await redis.aclose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", type=int, default=2000)
    parser.add_argument("--concurrency", type=int, default=20)
    args = parser.parse_args()
    asyncio.run(main(args.jobs, args.concurrency))
