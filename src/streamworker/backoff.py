"""Retry backoff policies."""

from __future__ import annotations

import random
from typing import Literal

from streamworker.errors import ConfigError

Jitter = Literal["full", "equal", "none"]
_MAX_EXPONENT = 62


class ExponentialBackoff:
    """``min(cap, base * 2 ** (attempt - 1))`` seconds, with optional jitter.

    * ``full``: uniform in ``[0, ceiling]``
    * ``equal``: uniform in ``[ceiling / 2, ceiling]``
    * ``none``: exactly ``ceiling``
    """

    def __init__(
        self,
        base: float = 1.0,
        cap: float = 300.0,
        jitter: Jitter = "full",
        rng: random.Random | None = None,
    ) -> None:
        if base <= 0 or cap <= 0:
            raise ConfigError("base and cap must be positive")
        if jitter not in ("full", "equal", "none"):
            raise ConfigError(f"unknown jitter mode {jitter!r}")
        self.base = base
        self.cap = cap
        self.jitter = jitter
        self._rng = rng or random.Random()

    def ceiling(self, attempt: int) -> float:
        """The un-jittered delay after the given (1-based) failed attempt."""
        exponent = min(max(attempt, 1) - 1, _MAX_EXPONENT)
        return min(self.cap, self.base * 2.0**exponent)

    def __call__(self, attempt: int) -> float:
        ceiling = self.ceiling(attempt)
        if self.jitter == "full":
            return self._rng.uniform(0.0, ceiling)
        if self.jitter == "equal":
            return self._rng.uniform(ceiling / 2, ceiling)
        return ceiling
