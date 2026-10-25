from __future__ import annotations

import asyncio
import contextlib
import inspect
import time
from collections.abc import AsyncIterator, Callable, Mapping
from datetime import timedelta
from typing import Any

from streamworker import Queue, Worker


async def wait_until(
    predicate: Callable[[], Any], within: float = 15.0, interval: float = 0.02
) -> None:
    """Poll ``predicate`` (sync or async) until truthy, failing with a clear message."""
    deadline = time.monotonic() + within
    while True:
        value = predicate()
        if inspect.isawaitable(value):
            value = await value
        if value:
            return
        if time.monotonic() > deadline:
            raise AssertionError(f"condition not met within {within}s: {predicate!r}")
        await asyncio.sleep(interval)


def make_worker(queue: Queue, handlers: Mapping[str, Callable[..., Any]], **kwargs: Any) -> Worker:
    defaults: dict[str, Any] = {
        "concurrency": 5,
        "visibility_timeout": timedelta(seconds=5),
        "handler_timeout": timedelta(seconds=2),
        "poll_interval": timedelta(milliseconds=50),
        "promote_interval": timedelta(milliseconds=20),
        "shutdown_grace": timedelta(seconds=5),
    }
    defaults.update(kwargs)
    return Worker(queue, handlers, **defaults)


@contextlib.asynccontextmanager
async def running(*workers: Worker) -> AsyncIterator[None]:
    """Run workers for the duration of the block, then shut them down gracefully."""
    tasks = [asyncio.create_task(w.run()) for w in workers]
    try:
        yield
    finally:
        for w in workers:
            w.stop()
        await asyncio.wait_for(asyncio.gather(*tasks), timeout=20)


async def is_drained(queue: Queue) -> bool:
    stats = await queue.stats()
    return stats.length == 0 and stats.pending == 0 and stats.delayed == 0
