from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def test_crash_demo_runs_and_recovers(sync_redis: object) -> None:
    result = subprocess.run(
        [sys.executable, str(ROOT / "examples" / "crash_demo.py")],
        capture_output=True,
        text=True,
        timeout=90,
        env=dict(os.environ),
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "worker A killed with SIGKILL" in result.stdout
    assert "pending=0, dead=0" in result.stdout
    assert result.stdout.count("DONE") == 1
    assert result.stdout.strip().endswith("recovered")


@pytest.mark.parametrize("script", ["enqueue.py"])
def test_enqueue_example_runs(sync_redis: object, script: str) -> None:
    result = subprocess.run(
        [sys.executable, str(ROOT / "examples" / script)],
        capture_output=True,
        text=True,
        timeout=60,
        env=dict(os.environ),
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "same id: True" in result.stdout
