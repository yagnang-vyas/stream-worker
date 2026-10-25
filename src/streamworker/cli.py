"""Command line interface: ``streamworker run|stats|dead``."""

from __future__ import annotations

import argparse
import asyncio
import importlib
import inspect
import json
import logging
import os
import sys
from collections.abc import Sequence
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import redis.asyncio as aioredis
from redis.exceptions import RedisError

from streamworker.errors import StreamWorkerError
from streamworker.queue import Queue
from streamworker.worker import Worker


def redact_url(url: str) -> str:
    """Replace any password in a Redis URL with ``***`` so it is safe to print."""
    try:
        parts = urlsplit(url)
        if parts.password is None:
            return url
        host = parts.hostname or ""
        if ":" in host:
            host = f"[{host}]"
        if parts.port:
            host = f"{host}:{parts.port}"
        user = parts.username or ""
        return urlunsplit(parts._replace(netloc=f"{user}:***@{host}"))
    except ValueError:
        return "<unparseable redis url>"


def _redis_url(args: argparse.Namespace) -> str | None:
    url: str | None = args.redis_url or os.environ.get("REDIS_URL")
    return url


def _import_target(spec: str) -> Any:
    module_name, sep, attr = spec.partition(":")
    if not sep or not module_name or not attr:
        raise StreamWorkerError("target must look like 'package.module:worker'")
    if os.getcwd() not in sys.path:
        sys.path.insert(0, os.getcwd())
    obj: Any = importlib.import_module(module_name)
    for part in attr.split("."):
        obj = getattr(obj, part)
    return obj


async def _resolve_worker(spec: str) -> Worker:
    obj = _import_target(spec)
    if not isinstance(obj, Worker) and callable(obj):
        obj = obj()
        if inspect.isawaitable(obj):
            obj = await obj
    if not isinstance(obj, Worker):
        raise StreamWorkerError(f"{spec!r} is not a Worker (or a callable returning one)")
    return obj


async def _cmd_run(args: argparse.Namespace) -> int:
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    worker = await _resolve_worker(args.target)
    try:
        await worker.run(handle_signals=True)
    finally:
        await worker.queue.redis.aclose()
    return 0


def _format_table(rows: list[dict[str, Any]], columns: Sequence[str]) -> str:
    if not rows:
        return "(none)"
    cells = [[str(row.get(c, "")) for c in columns] for row in rows]
    widths = [max(len(c), *(len(r[i]) for r in cells)) for i, c in enumerate(columns)]
    lines = ["  ".join(c.ljust(w) for c, w in zip(columns, widths, strict=True))]
    lines += ["  ".join(v.ljust(w) for v, w in zip(r, widths, strict=True)) for r in cells]
    return "\n".join(line.rstrip() for line in lines)


async def _with_queue(args: argparse.Namespace, url: str) -> int:
    client = aioredis.from_url(url, decode_responses=True)
    try:
        queue = Queue(client, args.queue)
        if args.command == "stats":
            data = (await queue.stats()).to_dict()
            if args.json:
                print(json.dumps(data))
            else:
                for key, value in data.items():
                    print(f"{key}: {value if value is not None else '-'}")
            return 0
        return await _dead_command(args, queue)
    finally:
        await client.aclose()


async def _all_dead_ids(queue: Queue) -> list[str]:
    ids: list[str] = []
    after: str | None = None
    while page := await queue.dead_list(limit=500, after=after):
        ids += [j.entry_id for j in page]
        after = ids[-1]
    return ids


async def _dead_command(args: argparse.Namespace, queue: Queue) -> int:
    action = args.dead_action
    if action == "list":
        jobs = await queue.dead_list(limit=args.limit)
        rows = [j.to_dict(include_payload=args.include_payload) for j in jobs]
        if args.json:
            print(json.dumps(rows))
        else:
            columns = ["entry_id", "task", "error_type", "attempt", "failed_at", "id"]
            if args.include_payload:
                columns.append("payload")
            print(_format_table(rows, columns))
        return 0
    if action == "requeue":
        count = 0
        for entry_id in [args.id] if args.id else await _all_dead_ids(queue):
            if await queue.dead_requeue(entry_id) is not None:
                count += 1
        print(f"requeued {count} job(s)")
        return 0 if count or not args.id else 1
    deleted = await queue.dead_purge(args.id)
    print(f"purged {deleted} job(s)")
    return 0 if deleted or not args.id else 1


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="streamworker", description="StreamWorker command line.")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="run a worker defined at module:attribute")
    run.add_argument(
        "target", help="e.g. myapp.tasks:worker (a Worker or a callable returning one)"
    )
    run.add_argument("--log-level", default="info", choices=["debug", "info", "warning", "error"])

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--queue", required=True, help="queue name")
        p.add_argument("--redis-url", help="Redis URL (default: $REDIS_URL)")

    stats = sub.add_parser("stats", help="show queue statistics")
    common(stats)
    stats.add_argument("--json", action="store_true", help="machine-readable output")

    dead = sub.add_parser("dead", help="inspect and manage the dead-letter stream")
    dead_sub = dead.add_subparsers(dest="dead_action", required=True)
    lst = dead_sub.add_parser("list", help="list dead jobs")
    common(lst)
    lst.add_argument("--limit", type=int, default=50)
    lst.add_argument("--include-payload", action="store_true", help="also show payloads")
    lst.add_argument("--json", action="store_true")
    requeue = dead_sub.add_parser("requeue", help="move dead jobs back to the queue")
    common(requeue)
    purge = dead_sub.add_parser("purge", help="delete dead jobs")
    common(purge)
    for p in (requeue, purge):
        target = p.add_mutually_exclusive_group(required=True)
        target.add_argument("--id", help="dead-letter entry id")
        target.add_argument("--all", action="store_true", help="apply to every dead job")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "run":
            return asyncio.run(_cmd_run(args))
        url = _redis_url(args)
        if not url:
            print("error: pass --redis-url or set REDIS_URL", file=sys.stderr)
            return 2
        try:
            return asyncio.run(_with_queue(args, url))
        except (RedisError, OSError) as exc:
            print(
                f"error: Redis at {redact_url(url)} failed: {type(exc).__name__}", file=sys.stderr
            )
            return 1
    except StreamWorkerError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except (ImportError, AttributeError) as exc:
        print(f"error: cannot load worker: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
