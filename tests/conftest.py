from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
import redis.asyncio as aioredis
from redis.exceptions import RedisError

from streamworker import Queue

REDIS_URL = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/15")
REQUIRE_REDIS = os.environ.get("STREAMWORKER_REQUIRE_REDIS") == "1"


def pytest_configure(config: pytest.Config) -> None:
    os.environ.setdefault("REDIS_URL", REDIS_URL)


@pytest.fixture
async def redis() -> AsyncIterator[Any]:
    client = aioredis.from_url(REDIS_URL, decode_responses=True)
    try:
        await client.ping()
    except (RedisError, OSError) as exc:
        await client.aclose()
        message = (
            f"Redis is unreachable at the configured REDIS_URL ({type(exc).__name__}). "
            "Start one with `make redis-up` or set REDIS_URL."
        )
        if REQUIRE_REDIS:
            pytest.fail(message)
        pytest.skip(message)
    await client.flushdb()
    try:
        yield client
    finally:
        await client.flushdb()
        await client.aclose()


@pytest.fixture
def queue_name() -> str:
    return f"t-{uuid.uuid4().hex[:8]}"


@pytest.fixture
def queue(redis: Any, queue_name: str) -> Queue:
    return Queue(redis, queue_name)
