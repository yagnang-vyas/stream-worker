"""A worker in its own process, for crash/shutdown tests. Not a test module."""

from __future__ import annotations

import argparse
import asyncio
import os
from datetime import timedelta
from typing import Any

import redis.asyncio as aioredis

from streamworker import JobContext, Queue, Worker


def log_line(path: str, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, (text + "\n").encode())
    finally:
        os.close(fd)


async def amain(args: argparse.Namespace) -> None:
    client = aioredis.from_url(os.environ["REDIS_URL"], decode_responses=True)
    queue = Queue(client, args.queue)

    async def work(payload: Any, ctx: JobContext) -> None:
        log_line(args.log, f"start {ctx.job_id} {ctx.attempt} {os.getpid()}")
        if args.die:
            os._exit(1)
        await asyncio.sleep(args.sleep)
        log_line(args.log, f"done {ctx.job_id} {ctx.attempt} {os.getpid()}")

    worker = Worker(
        queue,
        {"work": work},
        concurrency=2,
        visibility_timeout=timedelta(seconds=args.visibility),
        handler_timeout=timedelta(seconds=args.handler_timeout),
        shutdown_grace=timedelta(seconds=args.grace),
        poll_interval=timedelta(milliseconds=50),
        promote_interval=timedelta(milliseconds=20),
    )
    print("ready", flush=True)
    await worker.run(handle_signals=True)
    await client.aclose()
    print("stopped", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", required=True)
    parser.add_argument("--log", required=True)
    parser.add_argument("--sleep", type=float, default=0.0)
    parser.add_argument("--die", action="store_true")
    parser.add_argument("--visibility", type=float, default=60.0)
    parser.add_argument("--handler-timeout", type=float, default=30.0)
    parser.add_argument("--grace", type=float, default=10.0)
    asyncio.run(amain(parser.parse_args()))


if __name__ == "__main__":
    main()
