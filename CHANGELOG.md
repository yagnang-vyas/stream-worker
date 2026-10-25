# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `frontend/`: optional React console with an operations dashboard over the admin API and a
  browser-only simulation playground. No changes to the Python package, scripts, CLI or admin API.

## [0.1.0] - 2026-10-25

### Added

- `Queue`: enqueue with JSON payloads, atomic idempotency keys, delayed jobs, stream
  trimming, `stats()`, and dead-letter list/requeue/purge.
- `Worker`: consumer-group processing with bounded concurrency, handler timeouts,
  exponential backoff retries (`ExponentialBackoff`), a delayed-job promoter, and dead
  letters for exhausted, unknown and malformed jobs.
- Crash recovery via `XAUTOCLAIM`, poison-message detection (`MaxDeliveriesExceeded`),
  and graceful shutdown on SIGTERM/SIGINT.
- `streamworker` CLI: `run`, `stats`, `dead list|requeue|purge`.
- Optional FastAPI admin API (`streamworker[admin]`) with API-key auth.
- Redis integration tests, including real-process `SIGKILL` crash recovery, poison
  message, graceful shutdown, concurrency, promoter race and privacy tests.
- Examples (including `crash_demo.py`), a throughput benchmark script, and CI.
