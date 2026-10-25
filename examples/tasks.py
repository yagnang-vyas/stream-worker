"""Example handlers and a worker. Run with:

REDIS_URL=redis://127.0.0.1:6379/0 streamworker run examples.tasks:worker
"""

from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
from datetime import timedelta
from typing import Any

import redis.asyncio as aioredis

from streamworker import ExponentialBackoff, JobContext, Queue, Worker

logger = logging.getLogger("examples.tasks")

REDIS_URL = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0")
DB_PATH = os.environ.get("EXAMPLE_DB", "example.sqlite3")


def _insert_once(job_id: str, user_id: int) -> bool:
    """Record that a welcome email was sent. A UNIQUE constraint makes this idempotent."""
    with sqlite3.connect(DB_PATH) as db:
        db.execute("CREATE TABLE IF NOT EXISTS sent (job_id TEXT PRIMARY KEY, user_id INTEGER)")
        cursor = db.execute(
            "INSERT INTO sent (job_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
            (job_id, user_id),
        )
        return cursor.rowcount == 1


async def send_welcome(payload: dict[str, Any], ctx: JobContext) -> None:
    # At-least-once delivery: this may run twice for one job, so the side effect is
    # guarded by a unique key (the job id) instead of being repeated blindly.
    first_time = await asyncio.to_thread(_insert_once, ctx.job_id, int(payload["user_id"]))
    if not first_time:
        logger.info("job %s already processed; skipping", ctx.job_id)
        return
    logger.info("sent welcome email for job %s (attempt %d)", ctx.job_id, ctx.attempt)


async def flaky(payload: dict[str, Any], ctx: JobContext) -> None:
    """Fails on early attempts to show retries with backoff."""
    if ctx.attempt < 3:
        raise RuntimeError("temporary failure")
    logger.info("job %s succeeded on attempt %d", ctx.job_id, ctx.attempt)


async def always_fails(payload: dict[str, Any]) -> None:
    """Ends up in the dead-letter stream after max_attempts."""
    raise ValueError("this job can never succeed")


queue = Queue(aioredis.from_url(REDIS_URL, decode_responses=True), "emails")
worker = Worker(
    queue,
    {"send_welcome": send_welcome, "flaky": flaky, "always_fails": always_fails},
    concurrency=10,
    visibility_timeout=timedelta(seconds=60),
    handler_timeout=timedelta(seconds=30),
    backoff=ExponentialBackoff(base=1.0, cap=300.0, jitter="full"),
)
