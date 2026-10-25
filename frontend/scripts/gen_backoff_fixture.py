"""Regenerate fixtures/backoff.json from the real streamworker.ExponentialBackoff.

Usage (repo root, package installed): python frontend/scripts/gen_backoff_fixture.py
Writes ceilings and jitter bounds only; jitter samples are random and are not fixtured.
"""

from __future__ import annotations

import json
from pathlib import Path

from streamworker import ExponentialBackoff

CASES = [
    (1.0, 300.0),
    (1.0, 10.0),
    (0.5, 60.0),
    (2.0, 100.0),
    (30.0, 30.0),
    (0.001, 1.0),
]
JITTERS = ["none", "full", "equal"]
ATTEMPTS = [0, 1, 2, 3, 4, 5, 6, 8, 12, 62, 63, 64, 1000, 10_000]

out = []
for base, cap in CASES:
    for jitter in JITTERS:
        b = ExponentialBackoff(base=base, cap=cap, jitter=jitter)  # type: ignore[arg-type]
        for attempt in ATTEMPTS:
            c = b.ceiling(attempt)
            lo = {"none": c, "full": 0.0, "equal": c / 2}[jitter]
            out.append(
                {
                    "base": base,
                    "cap": cap,
                    "jitter": jitter,
                    "attempt": attempt,
                    "ceiling": c,
                    "min": lo,
                    "max": c,
                }
            )

path = Path(__file__).resolve().parent.parent / "fixtures" / "backoff.json"
path.write_text(json.dumps(out, indent=1) + "\n")
print(f"wrote {len(out)} cases to {path}")
