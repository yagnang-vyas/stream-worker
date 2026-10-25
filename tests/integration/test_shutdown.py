from __future__ import annotations

import asyncio
import logging
import os
import signal
from datetime import timedelta

import pytest

from streamworker import Queue
from tests.helpers import is_drained, make_worker, wait_until


async def test_stop_waits_for_inflight_jobs(queue: Queue) -> None:
    started = asyncio.Event()
    finished: list[int] = []

    async def handler(payload: int) -> None:
        started.set()
        await asyncio.sleep(0.4)
        finished.append(payload)

    await queue.enqueue("t", 1)
    worker = make_worker(queue, {"t": handler}, shutdown_grace=timedelta(seconds=5))
    task = asyncio.create_task(worker.run())
    await asyncio.wait_for(started.wait(), 10)
    worker.stop()
    await asyncio.wait_for(task, 10)
    assert finished == [1]
    assert await is_drained(queue)
    assert not worker.running


async def test_grace_expiry_cancels_job_and_leaves_it_pending(
    queue: Queue, caplog: pytest.LogCaptureFixture
) -> None:
    started = asyncio.Event()
    cancelled = False

    async def handler(payload: int) -> None:
        nonlocal cancelled
        started.set()
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled = True
            raise

    await queue.enqueue("t", 1)
    caplog.set_level(logging.WARNING, logger="streamworker")
    worker = make_worker(queue, {"t": handler}, shutdown_grace=timedelta(seconds=0.2))
    task = asyncio.create_task(worker.run())
    await asyncio.wait_for(started.wait(), 10)
    worker.stop()
    await asyncio.wait_for(task, 10)
    assert cancelled
    assert (await queue.stats()).pending == 1
    assert "left pending for recovery" in caplog.text

    # A fresh worker recovers it and finishes it exactly once.
    done: list[int] = []

    async def quick(payload: int) -> None:
        done.append(payload)

    second = make_worker(
        queue,
        {"t": quick},
        visibility_timeout=timedelta(seconds=0.4),
        handler_timeout=timedelta(seconds=0.3),
    )
    t2 = asyncio.create_task(second.run())
    try:
        await wait_until(lambda: is_drained(queue))
    finally:
        second.stop()
        await t2
    assert done == [1]


async def test_no_new_jobs_are_read_after_stop(queue: Queue) -> None:
    seen: list[int] = []

    async def handler(payload: int) -> None:
        seen.append(payload)

    worker = make_worker(queue, {"t": handler})
    task = asyncio.create_task(worker.run())
    await wait_until(lambda: worker.running)
    worker.stop()
    await asyncio.wait_for(task, 10)
    await queue.enqueue("t", 1)
    await asyncio.sleep(0.2)
    assert seen == []
    assert (await queue.stats()).length == 1


async def test_signal_handlers_trigger_graceful_stop(queue: Queue) -> None:
    worker = make_worker(queue, {})
    task = asyncio.create_task(worker.run(handle_signals=True))
    await wait_until(lambda: worker.running)
    os.kill(os.getpid(), signal.SIGTERM)
    await asyncio.wait_for(task, 10)
    assert not worker.running
    # Handlers were removed: a second worker can install its own again.
    again = make_worker(queue, {})
    task2 = asyncio.create_task(again.run(handle_signals=True))
    await wait_until(lambda: again.running)
    os.kill(os.getpid(), signal.SIGINT)
    await asyncio.wait_for(task2, 10)


async def test_stop_before_run_exits_immediately(queue: Queue) -> None:
    worker = make_worker(queue, {})
    worker.stop()
    await asyncio.wait_for(worker.run(), 10)


async def test_stuck_loop_is_cancelled_after_grace(
    queue: Queue, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def hang(limit: int = 100) -> int:
        await asyncio.sleep(60)
        return 0

    monkeypatch.setattr(queue, "promote_due", hang)
    worker = make_worker(queue, {}, shutdown_grace=timedelta(seconds=0.2))
    task = asyncio.create_task(worker.run())
    await wait_until(lambda: worker.running)
    await asyncio.sleep(0.1)
    worker.stop()
    await asyncio.wait_for(task, 10)
