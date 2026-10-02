#!/bin/sh
# make test-integration: start PostgreSQL 18 and the app image, seed a user, a workspace and two API keys, run the
# flows (flows.test.ts), and remove everything again. APP_IMAGE: the app image to test (default the released one;
# README.md → Tests). Needs `make install` first (the runner uses the dev stack's node_modules volume).
set -eu
cd "$(dirname "$0")"
export APP_IMAGE="${APP_IMAGE:-ghcr.io/sol2flow/sol2flow:latest}"
COMPOSE="docker compose -f compose.yml"

cleanup() { $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

echo "integration: app image $APP_IMAGE"
$COMPOSE up -d --wait app
keys=$($COMPOSE exec -T app node --input-type=module - < seed.mjs)
IT_FULL_KEY=$(printf '%s' "$keys" | sed -E 's/.*"full":"([^"]+)".*/\1/')
IT_READ_KEY=$(printf '%s' "$keys" | sed -E 's/.*"read":"([^"]+)".*/\1/')
export IT_FULL_KEY IT_READ_KEY
status=0
$COMPOSE run --rm --no-deps runner || status=$?
[ "$status" -eq 0 ] || $COMPOSE logs --tail 60 app
exit "$status"
