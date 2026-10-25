"""Crash recovery with real processes: SIGKILL, poison messages, SIGTERM."""

from __future__ import annotations

import signal
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from streamworker import Queue
from tests.helpers import is_drained, wait_until
from tests.proc import WorkerProcess, read_log


@pytest.fixture
async def procs() -> AsyncIterator[list[WorkerProcess]]:
    started: list[WorkerProcess] = []
    try:
        yield started
    finally:
        for p in started:
            await p.ensure_dead()


async def _spawn(procs: list[WorkerProcess], *args: object, **kwargs: object) -> WorkerProcess:
    proc = await WorkerProcess.start(*args, **kwargs)  # type: ignore[arg-type]
    procs.append(proc)
    return proc


async def test_sigkilled_worker_job_is_recovered_exactly_once(
    queue: Queue, tmp_path: Path, procs: list[WorkerProcess]
) -> None:
    log = tmp_path / "log"
    job_id = await queue.enqueue("work", {"n": 1})
    first = await _spawn(procs, queue.name, log, sleep=60, visibility=300, handler_timeout=120)
    await wait_until(lambda: any(r[0] == "start" for r in read_log(log)))
    first.send(signal.SIGKILL)
    assert await first.wait() == -signal.SIGKILL
    assert (await queue.stats()).pending == 1

    second = await _spawn(procs, queue.name, log, sleep=0, visibility=1, handler_timeout=0.5)
    await wait_until(lambda: any(r[0] == "done" for r in read_log(log)))
    await wait_until(lambda: is_drained(queue))

    rows = read_log(log)
    done = [r for r in rows if r[0] == "done"]
    assert len(done) == 1
    assert done[0][1] == job_id
    assert done[0][3] == str(second.pid)
    assert [r[3] for r in rows if r[0] == "start"] == [str(first.pid), str(second.pid)]
    assert (await queue.stats()).dead == 0
    second.send(signal.SIGTERM)
    assert await second.wait() == 0


async def test_poison_message_is_dead_lettered_after_max_attempts(
    queue: Queue, tmp_path: Path, procs: list[WorkerProcess]
) -> None:
    log = tmp_path / "log"
    max_attempts = 3
    job_id = await queue.enqueue("work", {"n": 1}, max_attempts=max_attempts)
    for _ in range(max_attempts + 1):
        proc = await _spawn(procs, queue.name, log, die=True, visibility=0.6, handler_timeout=0.5)
        await wait_until(lambda p=proc: p.exited or queue.dead_list())  # type: ignore[misc]
        if await queue.dead_list():
            proc.send(signal.SIGTERM)
            assert await proc.wait() == 0
            break
        assert await proc.wait() == 1
    [dead] = await queue.dead_list()
    assert dead.fields["id"] == job_id
    assert dead.fields["error_type"] == "MaxDeliveriesExceeded"
    starts = [r for r in read_log(log) if r[0] == "start"]
    assert len(starts) == max_attempts
    assert not any(r[0] == "done" for r in read_log(log))
    assert await is_drained(queue)


async def test_sigterm_during_short_job_completes_it_and_exits_zero(
    queue: Queue, tmp_path: Path, procs: list[WorkerProcess]
) -> None:
    log = tmp_path / "log"
    await queue.enqueue("work", {})
    proc = await _spawn(procs, queue.name, log, sleep=1.0, grace=10)
    await wait_until(lambda: any(r[0] == "start" for r in read_log(log)))
    proc.send(signal.SIGTERM)
    assert await proc.wait() == 0
    assert [r[0] for r in read_log(log)] == ["start", "done"]
    assert await is_drained(queue)


async def test_sigterm_during_long_job_leaves_it_pending_then_recovered(
    queue: Queue, tmp_path: Path, procs: list[WorkerProcess]
) -> None:
    log = tmp_path / "log"
    job_id = await queue.enqueue("work", {})
    first = await _spawn(
        procs, queue.name, log, sleep=60, grace=0.5, visibility=300, handler_timeout=120
    )
    await wait_until(lambda: any(r[0] == "start" for r in read_log(log)))
    first.send(signal.SIGTERM)
    assert await first.wait() == 0
    assert not any(r[0] == "done" for r in read_log(log))
    assert (await queue.stats()).pending == 1

    second = await _spawn(procs, queue.name, log, sleep=0, visibility=1, handler_timeout=0.5)
    await wait_until(lambda: is_drained(queue))
    done = [r for r in read_log(log) if r[0] == "done"]
    assert [r[1] for r in done] == [job_id]
    assert done[0][3] == str(second.pid)
    second.send(signal.SIGTERM)
    assert await second.wait() == 0
