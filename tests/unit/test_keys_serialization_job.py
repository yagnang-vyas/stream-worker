from __future__ import annotations

import math
from datetime import UTC

import pytest

from streamworker.errors import ConfigError, PayloadTooLargeError, SerializationError
from streamworker.job import DeadJob, Job
from streamworker.keys import Keys
from streamworker.serialization import dumps_payload, loads_payload


def test_key_names() -> None:
    keys = Keys("emails")
    assert keys.stream == "sw:emails:stream"
    assert keys.delayed == "sw:emails:delayed"
    assert keys.dead == "sw:emails:dead"
    assert keys.idempotency("welcome:42") == "sw:emails:idem:welcome:42"


@pytest.mark.parametrize("name", ["", "has space", "tab\t"])
def test_invalid_queue_names(name: str) -> None:
    with pytest.raises(ConfigError):
        Keys(name)


def test_payload_round_trip() -> None:
    value = {"user_id": 42, "tags": ["a", "é"], "nested": {"x": None}}
    assert loads_payload(dumps_payload(value)) == value


@pytest.mark.parametrize("bad", [object(), {1, 2}, math.nan, math.inf, b"bytes"])
def test_unserialisable_payload(bad: object) -> None:
    with pytest.raises(SerializationError):
        dumps_payload(bad)


def test_circular_payload() -> None:
    loop: list[object] = []
    loop.append(loop)
    with pytest.raises(SerializationError):
        dumps_payload(loop)


def test_lone_surrogate_rejected() -> None:
    with pytest.raises(SerializationError):
        dumps_payload("\ud800")


def test_payload_size_limit() -> None:
    assert dumps_payload("x" * 10, max_bytes=12)
    with pytest.raises(PayloadTooLargeError):
        dumps_payload("x" * 10, max_bytes=11)


def test_job_round_trip_and_member() -> None:
    job = Job("id1", "task", '{"a":1}', 1, 3, 1_700_000_000_000, "key")
    assert Job.from_fields(job.to_fields()) == job
    assert Job.from_fields(job.next_attempt().to_fields()).attempt == 2
    assert '"attempt":"1"' in job.to_member()
    ctx = job.context()
    assert (ctx.job_id, ctx.task, ctx.attempt, ctx.max_attempts) == ("id1", "task", 1, 3)
    assert ctx.enqueued_at.tzinfo is UTC
    assert "idempotency_key" not in Job("i", "t", "1", 1, 1, 0).to_fields()


@pytest.mark.parametrize(
    "fields",
    [
        {},
        {
            "id": "1",
            "task": "t",
            "payload": "1",
            "attempt": "x",
            "max_attempts": "1",
            "enqueued_at": "1",
        },
    ],
)
def test_malformed_job(fields: dict[str, str]) -> None:
    with pytest.raises(ValueError, match="malformed job"):
        Job.from_fields(fields)


def test_dead_job_to_dict() -> None:
    dead = DeadJob("1-0", {"id": "a", "payload": "secret", "error_type": "X"})
    assert "payload" not in dead.to_dict()
    assert dead.to_dict(include_payload=True)["payload"] == "secret"
    assert dead.to_dict()["entry_id"] == "1-0"
