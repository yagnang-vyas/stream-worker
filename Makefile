PYTHON ?= python3
REDIS_URL ?= redis://127.0.0.1:6379/15
export REDIS_URL

.PHONY: install lint typecheck test check redis-up redis-down

install:
	$(PYTHON) -m pip install -e ".[dev]"

lint:
	ruff check .
	ruff format --check .

typecheck:
	mypy

test:
	coverage erase
	coverage run -m pytest
	coverage combine
	coverage report

check: lint typecheck test

redis-up:
	docker compose up -d --wait

redis-down:
	docker compose down
