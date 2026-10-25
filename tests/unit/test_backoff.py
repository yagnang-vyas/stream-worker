from __future__ import annotations

import random

import pytest

from streamworker import ConfigError, ExponentialBackoff


def test_no_jitter_is_exact_and_capped() -> None:
    b = ExponentialBackoff(base=1.0, cap=10.0, jitter="none")
    assert [b(a) for a in range(1, 7)] == [1, 2, 4, 8, 10, 10]


def test_full_jitter_bounds() -> None:
    b = ExponentialBackoff(base=2.0, cap=100.0, jitter="full", rng=random.Random(1))
    for attempt in range(1, 12):
        for _ in range(200):
            assert 0.0 <= b(attempt) <= b.ceiling(attempt)


def test_equal_jitter_bounds() -> None:
    b = ExponentialBackoff(base=2.0, cap=100.0, jitter="equal", rng=random.Random(2))
    for attempt in range(1, 12):
        for _ in range(200):
            assert b.ceiling(attempt) / 2 <= b(attempt) <= b.ceiling(attempt)


def test_seeded_rng_is_deterministic_and_spreads() -> None:
    a = [ExponentialBackoff(rng=random.Random(7))(3) for _ in range(1)]
    b = [ExponentialBackoff(rng=random.Random(7))(3) for _ in range(1)]
    assert a == b
    rng_backoff = ExponentialBackoff(base=1.0, cap=300.0, rng=random.Random(3))
    samples = {round(rng_backoff(5), 6) for _ in range(50)}
    assert len(samples) > 40
    assert max(samples) <= 16.0


def test_huge_attempt_does_not_overflow() -> None:
    b = ExponentialBackoff(base=1.0, cap=300.0, jitter="none")
    assert b(10_000) == 300.0
    assert b(0) == 1.0


@pytest.mark.parametrize("kwargs", [{"base": 0}, {"cap": -1}, {"jitter": "wild"}])
def test_invalid_config(kwargs: dict[str, object]) -> None:
    with pytest.raises(ConfigError):
        ExponentialBackoff(**kwargs)  # type: ignore[arg-type]
