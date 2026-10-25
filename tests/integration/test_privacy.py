"""Logs must never contain job payloads (or exception text that may echo them)."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

import pytest

from streamworker import ExponentialBackoff, Queue
from tests.helpers import is_drained, make_worker, running, wait_until

EMAIL = "jane.doe@example.com"


async def test_failing_job_logs_do_not_leak_payload(
    queue: Queue, caplog: pytest.LogCaptureFixture
) -> None:
    async def leaky_failure(payload: dict[str, str]) -> None:
        raise ValueError(f"could not send to {payload['email']}")

    caplog.set_level(logging.DEBUG)  # root logger: capture every library
    await queue.enqueue("send", {"email": EMAIL}, max_attempts=2)
    await queue.enqueue("nobody-handles-this", {"email": EMAIL})
    worker = make_worker(
        queue,
        {"send": leaky_failure},
        backoff=ExponentialBackoff(base=0.01, cap=0.02, jitter="none"),
    )
    async with running(worker):
        await wait_until(lambda: _two_dead(queue))
        await wait_until(lambda: is_drained(queue))
    assert caplog.records, "expected the worker to log something"
    assert EMAIL not in caplog.text
    assert "example.com" not in caplog.text
    assert "ValueError" in caplog.text  # the error *type* is logged
    assert "send" in caplog.text  # and the task name


async def _two_dead(queue: Queue) -> bool:
    return len(await queue.dead_list()) == 2


async def test_poison_and_timeout_logs_do_not_leak_payload(
    queue: Queue, redis: Any, caplog: pytest.LogCaptureFixture
) -> None:
    async def slow(payload: Any) -> None:
        import asyncio

        await asyncio.sleep(10)

    caplog.set_level(logging.DEBUG)
    await queue.enqueue("slow", {"email": EMAIL}, max_attempts=1)
    await queue.enqueue("slow", {"email": EMAIL}, max_attempts=1)
    await queue.ensure_group()
    await redis.xreadgroup(queue.group, "gone", {queue.keys.stream: ">"}, count=1)
    [(entry_id, _), *_] = await redis.xrange(queue.keys.stream)
    await redis.xclaim(queue.keys.stream, queue.group, "gone", 0, [entry_id])
    worker = make_worker(
        queue,
        {"slow": slow},
        handler_timeout=timedelta(seconds=0.1),
        visibility_timeout=timedelta(seconds=0.4),
    )
    async with running(worker):
        await wait_until(lambda: _two_dead(queue))
    assert EMAIL not in caplog.text
    errors = {d.fields["error_type"] for d in await queue.dead_list()}
    assert errors == {"MaxDeliveriesExceeded", "TimeoutError"}
