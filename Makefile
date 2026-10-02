# sol2flow MCP server. Every command runs in Docker: the host needs no Node.
# The sol2flow app's dev stack network: while it exists, the dev container joins it (docker-compose.app-network.yml), so
# the server can reach the app at http://app:3000.
APP_NETWORK ?= sol2flow-dev_default
HAVE_APP_NETWORK := $(shell docker network inspect $(APP_NETWORK) >/dev/null 2>&1 && echo yes)
COMPOSE   = SOL2FLOW_APP_NETWORK=$(APP_NETWORK) docker compose$(if $(HAVE_APP_NETWORK), -f docker-compose.yml -f docker-compose.app-network.yml)
RUN       = $(COMPOSE) run --rm --no-deps -T dev
RUN_TTY   = $(COMPOSE) run --rm --no-deps dev
IMAGE    ?= ghcr.io/sol2flow/mcp:dev
# make openapi-sync: where the OpenAPI document comes from (the app's dev stack by default)
OPENAPI_URL ?= http://app:3000/api/v1/openapi.json
# make image-run: the upstream sol2flow the container talks to
SOL2FLOW_URL ?= $(if $(HAVE_APP_NETWORK),http://app:3000,https://app.sol2flow.com)
# make inspector: the MCP Inspector's version (fetched with npx on first use, not a dependency)
INSPECTOR ?= 2.9.0
# make test-integration: the app image to test against (a production image: the released one, or `make image` in the
# app repository → ghcr.io/sol2flow/sol2flow:dev); or APP_CONTAINER=<container>, an app that already runs on a *_test
# database (e.g. the app repository's e2e server sol2flow-dev-app-e2e-1); ARGS: extra vitest arguments
APP_IMAGE ?= ghcr.io/sol2flow/sol2flow:latest
APP_CONTAINER ?=
ARGS ?=

.PHONY: help install dev inspector build check test test-integration lint typecheck format format-check image image-run \
        openapi-sync notices pack clean hooks shell

help: ## Show targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[33m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies from package-lock.json (node_modules lives in a Docker volume)
	@# skipped while node_modules matches package-lock.json (a stamp copy of it); npm ci would reinstall everything
	$(RUN) sh -c 'cmp -s package-lock.json node_modules/.lock-stamp 2>/dev/null && exit 0; \
	  npm ci && cp package-lock.json node_modules/.lock-stamp'

dev: install ## The server in HTTP mode on http://localhost:3005/mcp, rebuilt on change (SOL2FLOW_API_KEY only for stdio)
	@echo "MCP server → http://localhost:3005/mcp  (upstream: $${SOL2FLOW_URL:-http://app:3000})"
	$(COMPOSE) run --rm --no-deps -p 127.0.0.1:3005:3005 -e MCP_TRANSPORT=http -e HOST=0.0.0.0 -e PORT=3005 \
	  -e ALLOWED_HOSTS=localhost:3005,127.0.0.1:3005 dev sh -c 'npm run dev'

inspector: build ## The MCP Inspector on http://localhost:6274 against the stdio server (SOL2FLOW_API_KEY=sf_… make inspector)
	$(COMPOSE) run --rm --no-deps -p 127.0.0.1:6274:6274 -p 127.0.0.1:6277:6277 -e HOST=0.0.0.0 \
	  -e ALLOWED_ORIGINS=http://localhost:6274 dev \
	  npx -y @modelcontextprotocol/inspector@$(INSPECTOR) node dist/index.js

build: install ## Bundle dist/index.js (one ESM file, no runtime dependencies) and dist/sentry-sdk.js (image only)
	$(RUN) npm run build

check: install ## Format check + lint + typecheck + tests (unit, protocol, contract) + build + notices + npm pack --dry-run
	$(RUN) npm run format:check
	$(RUN) npm run lint
	$(RUN) npm run typecheck
	$(RUN) npm test
	$(RUN) sh -c 'npm run build && node scripts/notices.mjs --check && node dist/index.js --version && npm pack --dry-run'

test: install ## Unit, protocol and contract tests (vitest, against the fake API in test/fake-api)
	$(RUN) npm test

test-integration: install ## Against a real app: APP_IMAGE=… on PostgreSQL 18, or APP_CONTAINER=… already running (README.md → Tests)
	APP_IMAGE='$(APP_IMAGE)' APP_CONTAINER='$(APP_CONTAINER)' ARGS='$(ARGS)' sh test/integration/run.sh

lint: install ## ESLint
	$(RUN) npm run lint

typecheck: install ## TypeScript, strict
	$(RUN) npm run typecheck

format: install ## Format everything with Prettier (.prettierrc.json; .prettierignore lists what it skips)
	$(RUN) npm run format

format-check: install ## Fail on files Prettier would change (part of make check and CI)
	$(RUN) npm run format:check

openapi-sync: install ## Refresh openapi/openapi-<version>.json from OPENAPI_URL and regenerate src/api/openapi.d.ts
	$(RUN) node scripts/openapi-sync.mjs $(OPENAPI_URL)

notices: install ## Regenerate THIRD-PARTY-NOTICES.md (the licences of everything bundled into dist/)
	$(RUN) npm run notices

pack: build ## What npm publish would upload (npm pack --dry-run)
	$(RUN) npm pack --dry-run

image: ## Build the production image ghcr.io/sol2flow/mcp:dev (HTTP transport, non-root, port 3000)
	docker build -t $(IMAGE) .

image-run: ## Run the image on http://localhost:8082/mcp against SOL2FLOW_URL (Ctrl+C stops it)
	@echo "image → http://localhost:8082/mcp  (upstream: $(SOL2FLOW_URL))"
	docker run --rm --name sol2flow-mcp -p 127.0.0.1:8082:3000 --read-only -e SOL2FLOW_URL=$(SOL2FLOW_URL) \
	  -e ALLOWED_HOSTS=localhost:8082,127.0.0.1:8082 $(if $(HAVE_APP_NETWORK),--network $(APP_NETWORK)) $(IMAGE)

clean: ## Remove the Docker volumes of this project (node_modules)
	$(COMPOSE) down --volumes --remove-orphans

hooks: ## Install the git hooks once per clone (.githooks/commit-msg: Conventional Commit messages)
	git config core.hooksPath .githooks

shell: ## Shell in a dev container
	$(RUN_TTY) sh
