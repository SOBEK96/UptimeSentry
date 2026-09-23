# UptimeSentry developer tasks.
#
#   make install            dev dependencies (.venv) + frontend packages
#   make lint               genvm-lint lint + validate
#   make test               direct suite, then the integration suite (skips with a
#                           reason when no funded network is available)
#   make test-integration   integration suite as a hard gate on $(NETWORK)
#   make smoke              live read-only smoke test of the deployed contract
#   make smoke-write        ...plus an attest_probe transaction (GENLAYER_PRIVATE_KEY)
#   make deploy-check       every deploy step up to signing, against $(NETWORK)
#   make deploy             deploy + verify + record (GENLAYER_PRIVATE_KEY)
#   make profile            rebuild fee-profile.json from finalized receipts
#   make build              frontend production build
#   make gate               lint + direct tests + frontend build

CONTRACT := contracts/uptimesentry.py
NETWORK  ?= studio_devnet
VENV     := .venv
PY       := $(VENV)/bin/python
BIN      := $(VENV)/bin
export PATH := $(abspath $(BIN)):$(PATH)

.PHONY: install lint test test-direct test-integration smoke smoke-write deploy-check deploy profile build gate clean

$(PY):
	@command -v uv >/dev/null && uv venv $(VENV) --python 3.12 || python3.12 -m venv $(VENV)

install: $(PY)
	@if command -v uv >/dev/null; then uv pip install --python $(PY) -r requirements-dev.txt; \
	else $(PY) -m pip install -r requirements-dev.txt; fi
	cd frontend && npm ci

lint:
	genvm-lint lint $(CONTRACT)
	genvm-lint validate $(CONTRACT)

test: test-direct
	gltest tests/integration -ra --network $(NETWORK)

test-direct:
	$(PY) -m pytest tests/direct --cov=contracts --cov-report=term-missing

test-integration:
	UPTIMESENTRY_REQUIRE_NETWORK=1 gltest tests/integration -v -ra --network $(NETWORK)

smoke:
	$(PY) scripts/smoke_test.py --network $(NETWORK)

smoke-write:
	$(PY) scripts/smoke_test.py --network $(NETWORK) --write

deploy-check:
	$(PY) scripts/deploy.py --network $(NETWORK) --dry-run

deploy:
	$(PY) scripts/deploy.py --network $(NETWORK)

profile:
	$(PY) scripts/fee_profile.py --network $(NETWORK)

build:
	cd frontend && npm run build

gate: lint test-direct build
	@echo "All gates passed."

clean:
	rm -rf artifacts .coverage .pytest_cache frontend/dist
	find . -name __pycache__ -type d -prune -not -path "./$(VENV)/*" -not -path "./frontend/node_modules/*" -exec rm -rf {} +
