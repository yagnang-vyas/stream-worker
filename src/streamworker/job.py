"""Job model and the stream/dead-letter field encodings."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any


@dataclass(frozen=True, slots=True)
class JobContext:
    """Metadata passed to handlers that accept a second argument."""

    job_id: str
    task: str
    attempt: int
    max_attempts: int
    enqueued_at: datetime


@dataclass(frozen=True, slots=True)
class Job:
    """A job as stored in the stream. ``payload`` is JSON text."""

    id: str
    task: str
    payload: str
    attempt: int
    max_attempts: int
    enqueued_at: int
    idempotency_key: str | None = None

    def to_fields(self) -> dict[str, str]:
        fields = {
            "id": self.id,
            "task": self.task,
            "payload": self.payload,
            "attempt": str(self.attempt),
            "max_attempts": str(self.max_attempts),
            "enqueued_at": str(self.enqueued_at),
        }
        if self.idempotency_key is not None:
            fields["idempotency_key"] = self.idempotency_key
        return fields

    def to_member(self) -> str:
        """Serialise for the delayed sorted set (a JSON object of strings)."""
        return json.dumps(self.to_fields(), separators=(",", ":"), ensure_ascii=False)

    def next_attempt(self) -> Job:
        return Job(
            id=self.id,
            task=self.task,
            payload=self.payload,
            attempt=self.attempt + 1,
            max_attempts=self.max_attempts,
            enqueued_at=self.enqueued_at,
            idempotency_key=self.idempotency_key,
        )

    def context(self) -> JobContext:
        return JobContext(
            job_id=self.id,
            task=self.task,
            attempt=self.attempt,
            max_attempts=self.max_attempts,
            enqueued_at=datetime.fromtimestamp(self.enqueued_at / 1000, tz=UTC),
        )

    @classmethod
    def from_fields(cls, fields: dict[str, str]) -> Job:
        """Parse stream fields. Raises ``ValueError`` if malformed."""
        try:
            return cls(
                id=fields["id"],
                task=fields["task"],
                payload=fields["payload"],
                attempt=int(fields["attempt"]),
                max_attempts=int(fields["max_attempts"]),
                enqueued_at=int(fields["enqueued_at"]),
                idempotency_key=fields.get("idempotency_key"),
            )
        except (KeyError, ValueError) as exc:
            raise ValueError(f"malformed job: {type(exc).__name__}") from exc


@dataclass(frozen=True, slots=True)
class DeadJob:
    """A dead-letter entry."""

    entry_id: str
    fields: dict[str, str]

    def to_dict(self, include_payload: bool = False) -> dict[str, Any]:
        out: dict[str, Any] = {"entry_id": self.entry_id, **self.fields}
        if not include_payload:
            out.pop("payload", None)
        return out
