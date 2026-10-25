# Contributor and agent notes

## Commands

* `make install` installs the package with dev dependencies.
* `make redis-up` starts Redis 7.4 via Docker Compose (`make redis-down` stops it).
* `make check` runs ruff, mypy (strict) and the full test suite with branch
  coverage (>= 90% enforced). Integration tests need `REDIS_URL`
  (default `redis://127.0.0.1:6379/15`); database 15 is flushed per test, so
  never point it at data you care about.
* `STREAMWORKER_REQUIRE_REDIS=1` turns "Redis unreachable" skips into failures.

## Rules

* Failure-path tests are the product. Never skip, weaken or blindly retry a
  test, and never lower the coverage threshold. Fix flakiness at the source.
* Every multi-key Redis transition is a Lua script (`scripts.py`).
* Never log job payloads or Redis URLs with passwords.
* Never swallow `asyncio.CancelledError`.
* Conventional Commits. Record design decisions in `SPEC.md` under "Decisions".
* README contains no throughput or latency numbers.
