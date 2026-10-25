"""Redis key naming. Every key lives under ``sw:{queue}:``."""

from __future__ import annotations

from dataclasses import dataclass

from streamworker.errors import ConfigError

DEFAULT_GROUP = "workers"


@dataclass(frozen=True, slots=True)
class Keys:
    """The Redis keys belonging to one queue."""

    queue: str

    def __post_init__(self) -> None:
        if not self.queue or any(c.isspace() for c in self.queue):
            raise ConfigError("queue name must be non-empty and contain no whitespace")

    @property
    def prefix(self) -> str:
        return f"sw:{self.queue}:"

    @property
    def stream(self) -> str:
        return f"{self.prefix}stream"

    @property
    def delayed(self) -> str:
        return f"{self.prefix}delayed"

    @property
    def dead(self) -> str:
        return f"{self.prefix}dead"

    def idempotency(self, key: str) -> str:
        return f"{self.prefix}idem:{key}"
