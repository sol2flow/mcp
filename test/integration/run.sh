#!/bin/sh
# make test-integration (README.md → Tests): the MCP server against a real sol2flow. Two ways:
#
#   own stack (default)   PostgreSQL 18 and the app image APP_IMAGE (compose.yml), both throwaway (`down -v` afterwards)
#   an app that runs      APP_CONTAINER=<container>: an app container that is already up on a *_test database, e.g. the
#                         app repository's e2e server (`sol2flow-dev-app-e2e-1`, a production build on sol2flow_test).
#                         The tests join its Docker network; APP_URL (default http://<compose service>:3000) and
#                         DATABASE_URL (default the container's own) can be overridden.
#
# Either way control.mjs runs inside the app container (its Prisma client and APP_ENCRYPTION_KEY): it seeds accounts,
# workspaces, plans and API keys into the test database (it refuses any database whose name doesn't end in _test) and
# serves /world and /sql to the tests on port 4555. The tests run in node:22-alpine with the dev stack's node_modules
# volume (`make install` first), after bundling dist/index.js (the stdio and HTTP tests spawn it).
# ARGS: extra vitest arguments, e.g. ARGS=test/integration/refs.test.ts. MCP_HTTP_URL: run the HTTP tests against a
# server that already runs on the same network (e.g. the image: README.md → Tests) instead of spawning one.
set -eu
cd "$(dirname "$0")"
ARGS="${ARGS:-}"
RUNNER_CMD="node scripts/build.mjs >/dev/null && npx vitest run --project integration $ARGS"

start_control() { # $1: docker exec prefix (container or compose service)
  # a control left over from an earlier run holds the port
  $1 sh -c 'kill "$(cat /tmp/sol2flow-it-control.pid 2>/dev/null)" 2>/dev/null; rm -f /tmp/sol2flow-it-control.pid' || true
  $1 sh -c 'cat > /tmp/sol2flow-it-control.mjs' < control.mjs
  # run from the app's directory, so @prisma/client resolves; the script is read from /tmp
  # shellcheck disable=SC2016
  $1 sh -c 'nohup node --input-type=module -e "$(cat /tmp/sol2flow-it-control.mjs)" >/tmp/sol2flow-it-control.log 2>&1 &
    echo $! > /tmp/sol2flow-it-control.pid'
}
stop_control() {
  $1 sh -c 'kill "$(cat /tmp/sol2flow-it-control.pid 2>/dev/null)" 2>/dev/null; rm -f /tmp/sol2flow-it-control.pid /tmp/sol2flow-it-control.mjs' || true
}

if [ -n "${APP_CONTAINER:-}" ]; then
  service=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$APP_CONTAINER")
  network=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$APP_CONTAINER" | cut -d' ' -f1)
  app_url="${APP_URL:-http://${service:-$APP_CONTAINER}:3000}"
  host=${app_url#*://}
  host=${host%%[:/]*}
  db_env=""
  [ -n "${DATABASE_URL:-}" ] && db_env="-e DATABASE_URL=$DATABASE_URL"
  # shellcheck disable=SC2086
  EXEC="docker exec -i $db_env $APP_CONTAINER"
  echo "integration: the running app $APP_CONTAINER ($app_url, network $network)"
  trap 'stop_control "$EXEC"' EXIT INT TERM
  start_control "$EXEC"
  status=0
  docker run --rm --network "$network" -v "$(cd ../.. && pwd):/mcp" -v sol2flow-mcp_node_modules:/mcp/node_modules \
    -w /mcp -e NPM_CONFIG_UPDATE_NOTIFIER=false -e SOL2FLOW_URL="$app_url" -e CONTROL_URL="http://$host:4555" \
    -e MCP_HTTP_URL="${MCP_HTTP_URL:-}" \
    node:22-alpine sh -c "$RUNNER_CMD" || status=$?
  [ "$status" -eq 0 ] || $EXEC cat /tmp/sol2flow-it-control.log || true
  exit "$status"
fi

export APP_IMAGE="${APP_IMAGE:-ghcr.io/sol2flow/sol2flow:latest}"
COMPOSE="docker compose -f compose.yml"
cleanup() { $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

echo "integration: app image $APP_IMAGE"
$COMPOSE up -d --wait app
start_control "$COMPOSE exec -T app"
status=0
$COMPOSE run --rm --no-deps runner sh -c "$RUNNER_CMD" || status=$?
[ "$status" -eq 0 ] || { $COMPOSE logs --tail 60 app; $COMPOSE exec -T app cat /tmp/sol2flow-it-control.log; } || true
exit "$status"
