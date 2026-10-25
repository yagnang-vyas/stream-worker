from __future__ import annotations

import asyncio
import os
import signal
import sys
from pathlib import Path

PROC_WORKER = Path(__file__).parent / "integration" / "proc_worker.py"


class WorkerProcess:
    """A worker running in a subprocess (see ``proc_worker.py``)."""

    def __init__(self, process: asyncio.subprocess.Process) -> None:
        self.process = process

    @classmethod
    async def start(
        cls,
        queue: str,
        log: Path,
        *,
        sleep: float = 0.0,
        die: bool = False,
        visibility: float = 60.0,
        handler_timeout: float = 30.0,
        grace: float = 10.0,
    ) -> WorkerProcess:
        argv = [
            sys.executable,
            str(PROC_WORKER),
            "--queue",
            queue,
            "--log",
            str(log),
            "--sleep",
            str(sleep),
            "--visibility",
            str(visibility),
            "--handler-timeout",
            str(handler_timeout),
            "--grace",
            str(grace),
        ]
        if die:
            argv.append("--die")
        process = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, env=dict(os.environ)
        )
        assert process.stdout is not None
        line = await asyncio.wait_for(process.stdout.readline(), timeout=30)
        assert line.strip() == b"ready", f"worker did not start: {line!r}"
        return cls(process)

    @property
    def pid(self) -> int:
        return self.process.pid

    @property
    def exited(self) -> bool:
        return self.process.returncode is not None

    def send(self, sig: signal.Signals) -> None:
        self.process.send_signal(sig)

    async def wait(self, within: float = 30.0) -> int:
        return await asyncio.wait_for(self.process.wait(), within)

    async def ensure_dead(self) -> None:
        if self.process.returncode is None:
            self.process.kill()
            await self.process.wait()


def read_log(path: Path) -> list[list[str]]:
    if not path.exists():
        return []
    return [line.split() for line in path.read_text().splitlines() if line]
