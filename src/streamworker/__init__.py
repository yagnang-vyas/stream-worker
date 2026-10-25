"""StreamWorker: a small, reliable asyncio job queue on Redis Streams."""

from streamworker.backoff import ExponentialBackoff
from streamworker.errors import (
    ConfigError,
    PayloadTooLargeError,
    SerializationError,
    StreamWorkerError,
)
from streamworker.job import JobContext
from streamworker.queue import Queue, QueueStats
from streamworker.worker import Worker

__version__ = "0.1.0"

__all__ = [
    "ConfigError",
    "ExponentialBackoff",
    "JobContext",
    "PayloadTooLargeError",
    "Queue",
    "QueueStats",
    "SerializationError",
    "StreamWorkerError",
    "Worker",
    "__version__",
]
