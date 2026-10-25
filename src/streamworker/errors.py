"""Exception types raised by StreamWorker."""


class StreamWorkerError(Exception):
    """Base class for all StreamWorker errors."""


class ConfigError(StreamWorkerError):
    """Invalid configuration (bad argument, unsuitable Redis client)."""


class SerializationError(StreamWorkerError):
    """A payload could not be serialised to JSON."""


class PayloadTooLargeError(SerializationError):
    """A serialised payload exceeds the configured size limit."""
