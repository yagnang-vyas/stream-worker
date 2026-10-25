from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import textwrap
import time
import uuid
from pathlib import Path
from typing import Any

import pytest

from streamworker.cli import main, redact_url
from tests.conftest import REDIS_URL


@pytest.fixture
def qname() -> str:
    return f"cli-{uuid.uuid4().hex[:8]}"


def _dead(r: Any, qname: str, n: int = 3) -> list[str]:
    return [
        r.xadd(
            f"sw:{qname}:dead",
            {
                "id": f"job{i}",
                "task": "t",
                "payload": '{"secret":1}',
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


def test_stats_text_and_json(
    sync_redis: Any, qname: str, capsys: pytest.CaptureFixture[str]
) -> None:
    sync_redis.xadd(f"sw:{qname}:stream", {"a": "b"})
    assert main(["stats", "--queue", qname, "--redis-url", REDIS_URL]) == 0
    out = capsys.readouterr().out
    assert "length: 1" in out and "oldest_pending_age_ms: -" in out
    assert main(["stats", "--queue", qname, "--redis-url", REDIS_URL, "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["length"] == 1


def test_url_from_environment(
    sync_redis: Any,
    qname: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("REDIS_URL", REDIS_URL)
    assert main(["stats", "--queue", qname, "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["dead"] == 0


def test_missing_url_is_an_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("REDIS_URL", raising=False)
    assert main(["stats", "--queue", "q"]) == 2
    assert "REDIS_URL" in capsys.readouterr().err


def test_unreachable_redis_never_prints_password(capsys: pytest.CaptureFixture[str]) -> None:
    url = "redis://user:hunter2@127.0.0.1:1/0"
    assert main(["stats", "--queue", "q", "--redis-url", url]) == 1
    err = capsys.readouterr().err
    assert "hunter2" not in err
    assert "user:***@127.0.0.1:1" in err


def test_redact_url() -> None:
    assert redact_url("redis://:pw@localhost:6379/0") == "redis://:***@localhost:6379/0"
    assert redact_url("redis://u:pw@[::1]:6379") == "redis://u:***@[::1]:6379"
    assert redact_url("redis://localhost/0") == "redis://localhost/0"
    assert "pw" not in redact_url("rediss://u:pw@host")
    assert redact_url("redis://u:pw@host:notaport") == "<unparseable redis url>"


def test_dead_list(sync_redis: Any, qname: str, capsys: pytest.CaptureFixture[str]) -> None:
    ids = _dead(sync_redis, qname)
    base = ["dead", "list", "--queue", qname, "--redis-url", REDIS_URL]
    assert main(base) == 0
    out = capsys.readouterr().out
    assert ids[0] in out and "Boom" in out and "secret" not in out
    assert main([*base, "--include-payload"]) == 0
    assert "secret" in capsys.readouterr().out
    assert main([*base, "--json", "--limit", "2"]) == 0
    rows = json.loads(capsys.readouterr().out)
    assert [r["entry_id"] for r in rows] == ids[:2]
    assert all("payload" not in r for r in rows)


def test_dead_list_empty(qname: str, sync_redis: Any, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["dead", "list", "--queue", qname, "--redis-url", REDIS_URL]) == 0
    assert capsys.readouterr().out.strip() == "(none)"


def test_dead_requeue_one_and_all(
    sync_redis: Any, qname: str, capsys: pytest.CaptureFixture[str]
) -> None:
    ids = _dead(sync_redis, qname)
    base = ["dead", "requeue", "--queue", qname, "--redis-url", REDIS_URL]
    assert main([*base, "--id", ids[0]]) == 0
    assert "requeued 1" in capsys.readouterr().out
    assert main([*base, "--id", ids[0]]) == 1  # already gone
    capsys.readouterr()
    assert main([*base, "--all"]) == 0
    assert "requeued 2" in capsys.readouterr().out
    assert sync_redis.xlen(f"sw:{qname}:dead") == 0
    jobs = sync_redis.xrange(f"sw:{qname}:stream")
    assert len(jobs) == 3 and {f["attempt"] for _, f in jobs} == {"1"}


def test_dead_purge(sync_redis: Any, qname: str, capsys: pytest.CaptureFixture[str]) -> None:
    ids = _dead(sync_redis, qname)
    base = ["dead", "purge", "--queue", qname, "--redis-url", REDIS_URL]
    assert main([*base, "--id", ids[0]]) == 0
    assert main([*base, "--id", ids[0]]) == 1
    capsys.readouterr()
    assert main([*base, "--all"]) == 0
    assert "purged 2" in capsys.readouterr().out
    assert sync_redis.xlen(f"sw:{qname}:dead") == 0


def test_purge_and_requeue_require_target(qname: str) -> None:
    for action in ("purge", "requeue"):
        with pytest.raises(SystemExit) as exc:
            main(["dead", action, "--queue", qname, "--redis-url", REDIS_URL])
        assert exc.value.code == 2


def test_invalid_entry_id(qname: str, capsys: pytest.CaptureFixture[str]) -> None:
    code = main(["dead", "purge", "--queue", qname, "--redis-url", REDIS_URL, "--id", "-"])
    assert code == 2
    assert "invalid dead-letter entry id" in capsys.readouterr().err


def test_requeue_all_pages_through_many(sync_redis: Any, qname: str) -> None:
    _dead(sync_redis, qname, n=620)
    assert main(["dead", "requeue", "--queue", qname, "--redis-url", REDIS_URL, "--all"]) == 0
    assert sync_redis.xlen(f"sw:{qname}:stream") == 620


def test_run_rejects_bad_targets(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["run", "nocolon"]) == 2
    assert main(["run", "no_such_module_xyz:worker"]) == 2
    assert main(["run", "streamworker:__version__"]) == 2
    err = capsys.readouterr().err
    assert "package.module:worker" in err and "cannot load worker" in err
    assert "not a Worker" in err


WORKER_MODULE = textwrap.dedent(
    """
    import os
    from datetime import timedelta
    import redis.asyncio as aioredis
    from streamworker import Queue, Worker

    QUEUE = os.environ["SW_QUEUE"]
    LOG = os.environ["SW_LOG"]

    async def work(payload):
        with open(LOG, "a") as fh:
            fh.write(f"ran {payload['n']}\\n")

    def build():
        client = aioredis.from_url(os.environ["REDIS_URL"], decode_responses=True)
        return Worker(Queue(client, QUEUE), {"work": work},
                      poll_interval=timedelta(milliseconds=50),
                      promote_interval=timedelta(milliseconds=50))

    async def build_async():
        return build()

    worker = build()
    """
)


@pytest.mark.parametrize("attr", ["worker", "build", "build_async"])
def test_run_command_end_to_end(sync_redis: Any, qname: str, tmp_path: Path, attr: str) -> None:
    (tmp_path / "cli_worker_mod.py").write_text(WORKER_MODULE)
    log = tmp_path / "log"
    sync_redis.xadd(
        f"sw:{qname}:stream",
        {
            "id": "j1",
            "task": "work",
            "payload": '{"n": 7}',
            "attempt": "1",
            "max_attempts": "3",
            "enqueued_at": "1",
        },
    )
    env = {**os.environ, "SW_QUEUE": qname, "SW_LOG": str(log), "REDIS_URL": REDIS_URL}
    proc = subprocess.Popen(
        [sys.executable, "-m", "streamworker.cli", "run", f"cli_worker_mod:{attr}"],
        cwd=tmp_path,
        env=env,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.monotonic() + 20
        while not log.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert log.read_text() == "ran 7\n"
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=20) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        assert proc.stderr is not None
        stderr = proc.stderr.read()
        proc.stderr.close()
    assert "Traceback" not in stderr
