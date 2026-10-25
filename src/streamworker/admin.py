"""Optional FastAPI admin API (``pip install streamworker[admin]``)."""

from __future__ import annotations

import hmac
from collections.abc import Sequence
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, Path, Query, Response
from redis.asyncio import Redis

from streamworker.errors import ConfigError
from streamworker.queue import Queue

_ENTRY_ID_PATTERN = r"^\d+-\d+$"
EntryId = Annotated[str, Path(pattern=_ENTRY_ID_PATTERN)]


def create_admin_app(
    redis: Redis,
    queues: Sequence[str | Queue],
    api_key: str,
) -> FastAPI:
    """Build an admin app for the given queues, protected by an ``X-API-Key`` header."""
    if not api_key:
        raise ConfigError("api_key must not be empty")
    expected = api_key.encode("utf-8")
    registry: dict[str, Queue] = {}
    for q in queues:
        queue = q if isinstance(q, Queue) else Queue(redis, q)
        registry[queue.name] = queue

    def require_key(x_api_key: Annotated[str | None, Header()] = None) -> None:
        supplied = (x_api_key or "").encode("utf-8")
        if not hmac.compare_digest(supplied, expected):
            raise HTTPException(status_code=401, detail="invalid or missing API key")

    def get_queue(name: str) -> Queue:
        try:
            return registry[name]
        except KeyError:
            raise HTTPException(status_code=404, detail="unknown queue") from None

    app = FastAPI(title="StreamWorker admin", dependencies=[Depends(require_key)])

    @app.get("/queues")
    async def list_queues() -> dict[str, Any]:
        out = []
        for name, queue in registry.items():
            out.append({"name": name, **(await queue.stats()).to_dict()})
        return {"queues": out}

    @app.get("/queues/{name}")
    async def queue_detail(name: str) -> dict[str, Any]:
        queue = get_queue(name)
        return {"name": name, **(await queue.stats()).to_dict()}

    @app.get("/queues/{name}/dead")
    async def list_dead(
        name: str,
        limit: Annotated[int, Query(ge=1, le=500)] = 50,
        cursor: Annotated[str | None, Query(pattern=_ENTRY_ID_PATTERN)] = None,
        include_payload: bool = False,
    ) -> dict[str, Any]:
        jobs = await get_queue(name).dead_list(limit=limit, after=cursor)
        return {
            "items": [j.to_dict(include_payload=include_payload) for j in jobs],
            "next_cursor": jobs[-1].entry_id if len(jobs) == limit else None,
        }

    @app.post("/queues/{name}/dead/{entry_id}/requeue")
    async def requeue(name: str, entry_id: EntryId) -> dict[str, str]:
        new_id = await get_queue(name).dead_requeue(entry_id)
        if new_id is None:
            raise HTTPException(status_code=404, detail="no such dead job")
        return {"entry_id": new_id}

    @app.delete("/queues/{name}/dead/{entry_id}", status_code=204)
    async def delete_dead(name: str, entry_id: EntryId) -> Response:
        if not await get_queue(name).dead_purge(entry_id):
            raise HTTPException(status_code=404, detail="no such dead job")
        return Response(status_code=204)

    return app
