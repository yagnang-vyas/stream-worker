"""JSON payload (de)serialisation with size limits."""

from __future__ import annotations

import json
from typing import Any

from streamworker.errors import PayloadTooLargeError, SerializationError

DEFAULT_MAX_PAYLOAD_BYTES = 512 * 1024


def dumps_payload(payload: Any, max_bytes: int = DEFAULT_MAX_PAYLOAD_BYTES) -> str:
    """Serialise ``payload`` to compact JSON or raise ``SerializationError``."""
    try:
        text = json.dumps(payload, separators=(",", ":"), allow_nan=False, ensure_ascii=False)
    except (TypeError, ValueError, RecursionError) as exc:
        raise SerializationError(f"payload is not JSON-serialisable: {type(exc).__name__}") from exc
    try:
        size = len(text.encode("utf-8"))
    except UnicodeEncodeError as exc:  # lone surrogates
        raise SerializationError("payload contains invalid unicode") from exc
    if size > max_bytes:
        raise PayloadTooLargeError(f"payload is {size} bytes; limit is {max_bytes}")
    return text


def loads_payload(text: str) -> Any:
    """Decode a payload previously produced by :func:`dumps_payload`."""
    return json.loads(text)
