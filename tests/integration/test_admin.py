from __future__ import annotations

import hmac
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from streamworker import ConfigError, Queue
from streamworker.admin import create_admin_app

KEY = "s3cret-key"
AUTH = {"X-API-Key": KEY}


@pytest.fixture
async def client(redis: Any, queue_name: str) -> AsyncIterator[httpx.AsyncClient]:
    app = create_admin_app(redis, queues=[queue_name], api_key=KEY)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def _seed_dead(redis: Any, queue: Queue, n: int = 3) -> list[str]:
    return [
        await redis.xadd(
            queue.keys.dead,
            {
                "id": f"job{i}",
                "task": "t",
                "payload": '{"email":"a@example.com"}',
                "attempt": "3",
                "max_attempts": "3",
                "enqueued_at": "1",
                "error_type": "Boom",
                "error_message": "m",
                "failed_at": "2",
            },
        )
        for i in range(n)
    ]


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/queues"),
        ("GET", "/queues/q"),
        ("GET", "/queues/q/dead"),
        ("POST", "/queues/q/dead/1-0/requeue"),
        ("DELETE", "/queues/q/dead/1-0"),
    ],
)
async def test_every_route_requires_the_api_key(
    client: httpx.AsyncClient, method: str, path: str
) -> None:
    assert (await client.request(method, path)).status_code == 401
    bad = await client.request(method, path, headers={"X-API-Key": "nope"})
    assert bad.status_code == 401
    assert (await client.request(method, path, headers={"X-API-Key": ""})).status_code == 401


async def test_key_comparison_is_constant_time(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[bytes, bytes]] = []
    real = hmac.compare_digest

    def spy(a: Any, b: Any) -> bool:
        calls.append((a, b))
        return bool(real(a, b))

    monkeypatch.setattr(hmac, "compare_digest", spy)
    await client.get("/queues", headers={"X-API-Key": "wrong"})
    await client.get("/queues", headers=AUTH)
    assert len(calls) == 2


async def test_non_ascii_key_does_not_crash(client: httpx.AsyncClient) -> None:
    r = await client.get("/queues", headers={b"X-API-Key": "ключ".encode()})
    assert r.status_code == 401


async def test_list_and_detail(client: httpx.AsyncClient, queue: Queue) -> None:
    await queue.enqueue("t", 1)
    listing = (await client.get("/queues", headers=AUTH)).json()
    assert listing["queues"][0]["name"] == queue.name
    assert listing["queues"][0]["length"] == 1
    detail = (await client.get(f"/queues/{queue.name}", headers=AUTH)).json()
    assert detail["length"] == 1 and detail["dead"] == 0 and detail["name"] == queue.name
    assert (await client.get("/queues/unknown", headers=AUTH)).status_code == 404


async def test_dead_listing_hides_payload_by_default(
    client: httpx.AsyncClient, queue: Queue, redis: Any
) -> None:
    ids = await _seed_dead(redis, queue)
    r = await client.get(f"/queues/{queue.name}/dead", headers=AUTH)
    body = r.json()
    assert [i["entry_id"] for i in body["items"]] == ids
    assert all("payload" not in i for i in body["items"])
    assert "a@example.com" not in r.text
    assert body["items"][0]["error_type"] == "Boom"
    assert body["next_cursor"] is None
    full = (
        await client.get(
            f"/queues/{queue.name}/dead", params={"include_payload": "true"}, headers=AUTH
        )
    ).json()
    assert "a@example.com" in full["items"][0]["payload"]


async def test_dead_pagination(client: httpx.AsyncClient, queue: Queue, redis: Any) -> None:
    ids = await _seed_dead(redis, queue, n=5)
    url = f"/queues/{queue.name}/dead"
    seen: list[str] = []
    cursor: str | None = None
    for _ in range(5):
        params: dict[str, Any] = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        body = (await client.get(url, params=params, headers=AUTH)).json()
        seen += [i["entry_id"] for i in body["items"]]
        cursor = body["next_cursor"]
        if cursor is None:
            break
    assert seen == ids
    assert (await client.get(url, params={"cursor": "junk"}, headers=AUTH)).status_code == 422
    assert (await client.get(url, params={"limit": 0}, headers=AUTH)).status_code == 422
    assert (await client.get("/queues/nope/dead", headers=AUTH)).status_code == 404


async def test_requeue_resets_attempt(client: httpx.AsyncClient, queue: Queue, redis: Any) -> None:
    [entry_id, *_] = await _seed_dead(redis, queue)
    url = f"/queues/{queue.name}/dead/{entry_id}/requeue"
    r = await client.post(url, headers=AUTH)
    assert r.status_code == 200
    [(new_id, fields)] = await redis.xrange(queue.keys.stream)
    assert r.json() == {"entry_id": new_id}
    assert fields["attempt"] == "1" and fields["id"] == "job0"
    assert (await client.post(url, headers=AUTH)).status_code == 404
    bad = await client.post(f"/queues/{queue.name}/dead/not-an-id/requeue", headers=AUTH)
    assert bad.status_code == 422
    assert (await client.post("/queues/nope/dead/1-0/requeue", headers=AUTH)).status_code == 404


async def test_delete_dead(client: httpx.AsyncClient, queue: Queue, redis: Any) -> None:
    [entry_id, *_] = await _seed_dead(redis, queue)
    url = f"/queues/{queue.name}/dead/{entry_id}"
    assert (await client.delete(url, headers=AUTH)).status_code == 204
    assert (await client.delete(url, headers=AUTH)).status_code == 404
    assert await redis.xlen(queue.keys.dead) == 2
    assert (await client.delete(f"/queues/{queue.name}/dead/x", headers=AUTH)).status_code == 422


async def test_accepts_queue_objects_and_rejects_empty_key(redis: Any, queue: Queue) -> None:
    app = create_admin_app(redis, queues=[queue], api_key=KEY)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        assert (await c.get("/queues", headers=AUTH)).status_code == 200
    with pytest.raises(ConfigError):
        create_admin_app(redis, queues=[], api_key="")
