"""Live demo of crash recovery.

Starts a worker that begins a slow job, kills it with SIGKILL mid-job, then starts a
second worker and shows the job being recovered and completed exactly once.

    python examples/crash_demo.py
"""

from __future__ import annotations

import argparse
import asyncio
import os
import signal
import sys
import uuid
from datetime import timedelta
from typing import Any

import redis.asyncio as aioredis

from streamworker import JobContext, Queue, Worker

REDIS_URL = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0")


async def run_child(queue_name: str, hang: bool) -> None:
    redis = aioredis.from_url(REDIS_URL, decode_responses=True)

    async def work(payload: Any, ctx: JobContext) -> None:
        print(f"STARTED {ctx.job_id} pid={os.getpid()}", flush=True)
        if hang:
            await asyncio.sleep(3600)  # pretend to do slow work; we will be killed
        print(f"DONE {ctx.job_id} pid={os.getpid()}", flush=True)

    worker = Worker(
        Queue(redis, queue_name),
        {"work": work},
        visibility_timeout=timedelta(seconds=300 if hang else 1),
        handler_timeout=timedelta(seconds=200 if hang else 0.5),
        poll_interval=timedelta(milliseconds=100),
    )
    print("READY", flush=True)
    await worker.run(handle_signals=True)
    await redis.aclose()


async def spawn(queue_name: str, hang: bool) -> asyncio.subprocess.Process:
    argv = [sys.executable, __file__, "--child", queue_name]
    if hang:
        argv.append("--hang")
    proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE)
    assert proc.stdout is not None
    assert (await proc.stdout.readline()).strip() == b"READY"
    return proc


async def next_line(proc: asyncio.subprocess.Process, prefix: str) -> str:
    assert proc.stdout is not None
    while True:
        raw = await asyncio.wait_for(proc.stdout.readline(), timeout=30)
        if not raw:
            raise RuntimeError("worker exited unexpectedly")
        line = raw.decode().strip()
        if line.startswith(prefix):
            return line


async def demo() -> None:
    redis = aioredis.from_url(REDIS_URL, decode_responses=True)
    name = f"crash-demo-{uuid.uuid4().hex[:6]}"
    queue = Queue(redis, name)
    job_id = await queue.enqueue("work", {"note": "recover me"})
    print(f"1. enqueued job {job_id}")

    first = await spawn(name, hang=True)
    print(f"2. worker A (pid {first.pid}): {await next_line(first, 'STARTED')}")
    first.send_signal(signal.SIGKILL)
    await first.wait()
    stats = await queue.stats()
    print(f"3. worker A killed with SIGKILL; job is stuck pending (pending={stats.pending})")

    second = await spawn(name, hang=False)
    print(f"4. worker B (pid {second.pid}) started; waiting for the visibility timeout (1s)...")
    print(f"5. worker B: {await next_line(second, 'DONE')}")
    await asyncio.sleep(0.2)
    stats = await queue.stats()
    print(f"6. recovered and finished exactly once (pending={stats.pending}, dead={stats.dead})")

    second.send_signal(signal.SIGTERM)
    await second.wait()
    keys = [k async for k in redis.scan_iter(match=f"sw:{name}:*")]
    if keys:
        await redis.delete(*keys)
    await redis.aclose()
    print("recovered")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--child", metavar="QUEUE")
    parser.add_argument("--hang", action="store_true")
    args = parser.parse_args()
    if args.child:
        asyncio.run(run_child(args.child, args.hang))
    else:
        asyncio.run(demo())


if __name__ == "__main__":
    main()
