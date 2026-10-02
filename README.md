# sol2flow MCP server

An [MCP](https://modelcontextprotocol.io) server for [sol2flow](https://sol2flow.com): it lets AI assistants (Claude
Desktop, Claude Code, Cursor, VS Code and other MCP clients) read and change your boards and tasks. It talks to
sol2flow **only through its public REST API** with your personal API key, so it can do exactly what you can do in the
app, nothing more.

- **Hosted:** `https://mcp.sol2flow.com/mcp` for sol2flow cloud (Streamable HTTP, your key in the `Authorization`
  header).
- **Local:** `npx -y @sol2flow/mcp` (stdio), for the cloud or your own instance.
- **Self-hosted:** the Docker image `ghcr.io/sol2flow/mcp` next to your sol2flow.

User guide: [docs.sol2flow.com → Integrations → MCP server](https://docs.sol2flow.com/docs/integrations/mcp).

## Quick start

1. In sol2flow, open **Settings → API keys** and create a key. **Full access** lets the assistant change things;
   **Read only** lets it only look (the write tools are then hidden or refused).
2. Add the server to your client (replace `sf_…` with the key; for your own instance set `SOL2FLOW_URL`).

**Claude Code**

```sh
claude mcp add sol2flow --env SOL2FLOW_API_KEY=sf_… -- npx -y @sol2flow/mcp
# or the hosted server
claude mcp add --transport http sol2flow https://mcp.sol2flow.com/mcp --header "Authorization: Bearer sf_…"
```

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "sol2flow": {
      "command": "npx",
      "args": ["-y", "@sol2flow/mcp"],
      "env": { "SOL2FLOW_URL": "https://app.sol2flow.com", "SOL2FLOW_API_KEY": "sf_…" }
    }
  }
}
```

Cursor also takes the hosted server: `"sol2flow": { "url": "https://mcp.sol2flow.com/mcp", "headers": { "Authorization": "Bearer sf_…" } }`.

**VS Code** (`.vscode/mcp.json`; the key is asked for once and stored by VS Code):

```json
{
  "inputs": [{ "type": "promptString", "id": "sol2flow-key", "description": "sol2flow API key", "password": true }],
  "servers": {
    "sol2flow": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@sol2flow/mcp"],
      "env": { "SOL2FLOW_API_KEY": "${input:sol2flow-key}" }
    }
  }
}
```

The hosted variant: `"sol2flow": { "type": "http", "url": "https://mcp.sol2flow.com/mcp", "headers": { "Authorization": "Bearer ${input:sol2flow-key}" } }`.

Claude.ai and ChatGPT connectors need OAuth sign-in instead of a key; that comes in a later version.

## Tools

32 tools, named `verb_noun`. Read tools carry `readOnlyHint`; write tools say whether they are destructive and
idempotent. Deleting is not offered: `archive_task` hides a task, `unarchive_task` brings it back.

| Tool                      | What it does                                                                      | API requests    |
| ------------------------- | --------------------------------------------------------------------------------- | --------------- |
| `whoami`                  | Your account, the key (scope, expiry; sol2flow 1.8+), the API version, workspaces | 2               |
| `list_workspaces`         | Workspaces with their slugs and your role                                         | 1               |
| `list_boards`             | Boards of a workspace (keys, task counts)                                         | 1               |
| `get_board`               | A board's lists with their tasks in board order (up to 300 tasks)                 | 2–4             |
| `search`                  | Boards and tasks by name, key or text (like ⌘K)                                   | 1 per workspace |
| `list_tasks`              | Tasks filtered by board, list, assignee, label, text, due dates, last change      | 1–4             |
| `get_task`                | A task in full: description, checklist, links, latest comments                    | 3               |
| `list_labels`             | Labels of a board or workspace                                                    | 1               |
| `list_people`             | Members of a workspace                                                            | 1               |
| `list_time_entries`       | Logged time, by board, task, person and period                                    | 1–3             |
| `get_timer`               | Your running timer                                                                | 1               |
| `list_notifications`      | Your notifications                                                                | 1               |
| `list_my_invitations`     | Pending invitations to you                                                        | 1               |
| `create_task`             | A task with description, labels, assignees, dates, estimate                       | 2–4             |
| `update_task`             | Fields, labels, assignees and list, step by step, reporting each step             | 2–7             |
| `move_task`               | To a list and position (top, bottom, before/after a task) or another board        | 3–5             |
| `archive_task`            | Archive (read-only until unarchived)                                              | 1               |
| `unarchive_task`          | Bring an archived task back                                                       | 1               |
| `add_comment`             | A comment or reply (Markdown, mentions)                                           | 1               |
| `add_checklist_items`     | Checklist items, in order                                                         | 1 per item      |
| `update_checklist_item`   | Tick, untick or edit an item                                                      | 1–2             |
| `link_tasks`              | blocks / blocked by / relates to / duplicates                                     | 1               |
| `unlink_tasks`            | Remove links between two tasks                                                    | 2               |
| `log_time`                | Time on a task (`1h30m`, `45m`)                                                   | 1               |
| `start_timer`             | Start your timer (stops a running one)                                            | 1               |
| `stop_timer`              | Stop it; the time is logged                                                       | 1               |
| `update_time_entry`       | Change one of your entries                                                        | 1               |
| `mark_notifications_read` | Some or all                                                                       | 1 per id, or 1  |
| `respond_to_invitation`   | Accept or decline                                                                 | 1               |
| `create_board`            | A board with its lists                                                            | 1               |
| `create_list`             | A list at the end of a board                                                      | 1               |
| `create_label`            | A board label                                                                     | 1               |

Plus reference lookups: a task key (`PRD-12`) or board name costs one search the first time and is then cached for 10
minutes; the workspace list is fetched once a minute at most. Every request counts against the key's rate limit (600
requests per 10 minutes, at most 120 of them writes) and, where plans apply, the organization's daily API limit.

Prompts: `plan_my_day` and `board_standup`. No resources yet (a `sol2flow://task/{key}` resource is planned).

### References

- **Task:** its key (`PRD-12`, also an old key after a move), its URL in the app, or its id.
- **Board:** its key (`PRD`), name, URL or id. **List**, **label:** name or id.
- **Person:** `me`, `@username`, a name, or an id.
- **Workspace:** the slug. Default: the `workspace` parameter, then `SOL2FLOW_WORKSPACE` (or `?workspace=` on the
  HTTP endpoint), then your only workspace. With several and none chosen, key lookups search them all (up to 10).

Output is compact Markdown (at most about 25 000 characters, with a notice when cut); `response_format: "json"` returns
the API's data. Descriptions and comments are read and written as Markdown.

### Read-only mode

`--read-only`, `READ_ONLY=true` or `?read_only=1` hide every write tool. In stdio mode a **read-only key** hides them
automatically (sol2flow 1.8+ tells the server the key's scope); otherwise a write answers with a clear "this key is
read-only".

## How it works

- Every tool call becomes REST API requests with your key: `Authorization: Bearer sf_…`, `User-Agent:
sol2flow-mcp/<version>`, 15 s per request, 45 s per tool, independent requests in parallel.
- **Permissions are the API's:** plan, key scope, the workspace's API access switch and your roles apply exactly as
  for the API. There is no separate MCP permission.
- **Retries:** reads only — on `rate_limited` with `Retry-After` ≤ 10 s (twice) and on server or network errors (once).
  Never the daily plan limit, never a write: the API has no idempotency keys, so a write without an answer is reported
  as "may or may not have been applied; check first".
- **Versions:** the server reads the `Sol2flow-Api-Version` header (sol2flow 1.8+). Without it, it assumes 1.7.0 and
  does without the newer features; a tool that needs an endpoint the instance doesn't have says the instance is too
  old.
- **Errors** become tool results the model can act on: a refused key (how to create one and where to update it), API
  switched off (instance or workspace), plan, read-only plan, read-only key, permission, not found, archived task
  (`unarchive_task` first), too large, invalid parameter (named as the tool's parameter), rate limits with the time
  until they reset, server errors.

## Configuration

| Variable                                                        | Default                    | What it does                                                                                                       |
| --------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `SOL2FLOW_URL`                                                  | `https://app.sol2flow.com` | The sol2flow instance (`…/api/v1` is added). In HTTP mode fixed by the operator: clients can't change it           |
| `SOL2FLOW_API_KEY`                                              | —                          | stdio only: the API key. Or `SOL2FLOW_API_KEY_FILE` (a Docker secret). There is no flag, so it never shows in `ps` |
| `SOL2FLOW_WORKSPACE`                                            | —                          | The default workspace slug                                                                                         |
| `READ_ONLY`                                                     | `false`                    | Hide the write tools (same as `--read-only`)                                                                       |
| `MCP_TRANSPORT`                                                 | `stdio`                    | `stdio` or `http` (same as `--stdio` / `--http`; the image sets `http`)                                            |
| `HOST`, `PORT`                                                  | `127.0.0.1`, `3000`        | HTTP: where to listen (the image: `0.0.0.0`)                                                                       |
| `ALLOWED_HOSTS`                                                 | loopback only              | HTTP: accepted `Host` headers (`host` or `host:port`, comma-separated). Unset on a public bind: any (a warning)    |
| `ALLOWED_ORIGINS`                                               | localhost origins          | HTTP: accepted `Origin` headers of browser clients; `*` for any. Requests without `Origin` are always accepted     |
| `TRUST_PROXY_HOPS`                                              | `0`                        | HTTP: proxies in front; the client IP is that many `X-Forwarded-For` entries from the right                        |
| `FORWARD_CLIENT_IP`                                             | `false`                    | HTTP: send the client IP upstream as `X-Forwarded-For` (when sol2flow trusts this server as its proxy)             |
| `LOG_LEVEL`                                                     | `info`                     | `debug` adds one line per API request                                                                              |
| `LOG_FILE`                                                      | —                          | Also write the log to dated files next to this path (e.g. `/data/logs/mcp.log`; see Logging)                       |
| `LOG_FILE_MAX_SIZE`, `LOG_FILE_FREQUENCY`, `LOG_FILE_MAX_FILES` | none, `daily`, `10`        | Rotation: as in the app and the website                                                                            |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`            | —, `production`, version   | Error tracking (image only; or `SENTRY_DSN_FILE`)                                                                  |

Flags: `--stdio`, `--http`, `--read-only`, `--host`, `--port`, `--version`, `--help`.

## Hosting (Streamable HTTP)

`POST /mcp` is stateless: each request builds a fresh server around **that request's key** and answers with JSON (no
SSE streams, no sessions, so it works behind tunnels that buffer). Nothing is stored. `GET /healthz` answers
`{"status":"ok","version":"…"}`; `GET` and `DELETE /mcp` answer 405. Query parameters: `workspace=<slug>` (the default
workspace) and `read_only=1`.

Protections: no or malformed key → 401 with `WWW-Authenticate`; `Host` and `Origin` checks against DNS rebinding;
bodies up to 1 MB (413); 15 s to send the headers, 60 s per request; at most 100 requests in flight per process (503);
at most 30 rejected keys per client IP in 10 minutes (429); a key sol2flow refused isn't sent upstream again for 5
minutes.

- **Our hosting:** `examples/swarm-stack.yml` (Docker Swarm, secrets, logs on a host directory owned by 1001:1001),
  reached through the Cloudflare tunnel at `mcp.sol2flow.com` (bot challenges off for that host).
- **Self-hosting:** `examples/compose.selfhosted.yml` puts the server next to your sol2flow's `app` service; give it a
  host name behind your reverse proxy and set `ALLOWED_HOSTS` to it.

```sh
docker run --rm -p 3000:3000 --read-only -e SOL2FLOW_URL=https://flow.example.com \
  -e ALLOWED_HOSTS=mcp.example.com ghcr.io/sol2flow/mcp
```

The image (`linux/amd64`, `linux/arm64`) is one bundled file on `node:22-alpine`, runs as `1001:1001`, works with a
read-only root filesystem, and has a health check.

## Logging

JSON lines (pino) on stdout in HTTP mode and on **stderr in stdio mode** (stdout is the protocol). Each tool call logs
the tool, the outcome, the duration, the number of API requests, the client IP (HTTP) and the key's public 8-character
prefix; with `LOG_LEVEL=debug` also each upstream operation and its status. **Never** the key, tool arguments or
results: on top of not logging them, the usual field names are redacted and every line is scrubbed of anything shaped
like a key or a bearer token.

`LOG_FILE` writes the same lines to `mcp-YYYY-MM-DD.log` files with `mcp.log` as a symlink to the current one
(`LOG_FILE_FREQUENCY` `daily` · `hourly` · `none`, `LOG_FILE_MAX_SIZE` like `20m`, `LOG_FILE_MAX_FILES` kept, `0` =
all). A file that can't be written never stops the server: one warning, then the console only.

## Error tracking

Off unless `SENTRY_DSN` (or `SENTRY_DSN_FILE`) is set, and **only in the Docker image** (the npm package doesn't ship
the SDK). Only server errors from sol2flow and unexpected errors are sent, without requests, headers, bodies,
arguments, results or user data. Works with sentry.io, Bugsink and GlitchTip.

## Privacy

The server stores nothing: no keys (in HTTP mode only a fingerprint of keys sol2flow refused, for 5 minutes), no
content. Resolved references (task key → id) are cached in memory for 10 minutes per key fingerprint. What reaches the
AI assistant is up to you and the assistant's provider.

## Development

Everything runs in Docker; the host needs only Docker and Make. `make help` lists the targets.

| Command                     | What it does                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `make dev`                  | The server in HTTP mode on http://localhost:3005/mcp against the app's dev stack, rebuilt on change           |
| `make inspector`            | The MCP Inspector on http://localhost:6274 against the stdio server (`SOL2FLOW_API_KEY=sf_… make inspector`)  |
| `make check`                | Format check, ESLint, TypeScript, tests, the bundle, `--version`, `npm pack --dry-run`                        |
| `make test`                 | Unit, protocol and contract tests (vitest) against the fake API                                               |
| `make test-integration`     | Every tool against a real app: an image on PostgreSQL 18 (`APP_IMAGE=…`) or a running one (`APP_CONTAINER=…`) |
| `make build`                | `dist/index.js` (one ESM file, no runtime dependencies) and `dist/sentry-sdk.js` (image only)                 |
| `make image`                | The image `ghcr.io/sol2flow/mcp:dev`; `make image-run` runs it on http://localhost:8082/mcp                   |
| `make openapi-sync`         | Refresh the vendored OpenAPI document and the generated types from the app's dev stack                        |
| `make notices`              | Regenerate THIRD-PARTY-NOTICES.md                                                                             |
| `make format`, `make hooks` | Prettier; the commit-msg hook (once per clone)                                                                |

While the app's dev stack runs (network `sol2flow-dev_default`), the dev container joins it and reaches the app at
`http://app:3000`.

### Tests

- **Unit** (`test/unit`): the client's retries, error mapping, reference resolution, config, output limits, the log
  file, and that the key never appears in logs.
- **Protocol** (`test/protocol`): in memory (tool list, annotations, read-only hiding, every tool against the fake
  API), HTTP (401, 403 for Origin and Host, 413, 405, health, two keys in parallel never mixed, refused keys), stdio
  (stdout carries only JSON-RPC).
- **Contract** (`test/contract`): every operation the server calls exists in `openapi/openapi-<version>.json` with that
  method, path and operationId; each tool's scope matches the operations' `x-required-scope`; every query parameter
  and body field the tools send is in the document.
- **Integration** (`test/integration`, `make test-integration`): the server against a real sol2flow (API 1.8+), in one
  of two ways:
  - **its own stack** (default, CI): PostgreSQL 18 and the app image `APP_IMAGE` (default
    `ghcr.io/sol2flow/sol2flow:latest`; locally e.g. one built with `make image` in the app repository), both thrown
    away afterwards;
  - **an app that already runs** on a `*_test` database: `make test-integration APP_CONTAINER=sol2flow-dev-app-e2e-1`
    (the app repository's e2e server, a production build on `sol2flow_test`; start it with the compose commands of its
    `make test-e2e-prod`). The tests join the container's network; `APP_URL` and `DATABASE_URL` can be overridden.

  `control.mjs` runs inside the app container: it seeds people, workspaces, plans and one API key per purpose straight
  into the database (refusing any database whose name doesn't end in `_test`) and lets the tests flip what the API
  can't (instance and workspace API access). `setup.ts` builds the boards, tasks, links, comments, an attachment,
  notifications and invitations through the REST API. Then, checking every write through the REST API:
  `tools.test.ts` (all 32 tools and both prompts), `refs.test.ts` (ids, keys, URLs, old keys, archived tasks and boards,
  names, people, the default workspace, ambiguity), `permissions.test.ts` (read-only, revoked, expired and unknown keys,
  `api_disabled`, `api_disabled_workspace`, viewers, guests, restricted boards and hidden links, archived boards,
  `plan_feature`, the daily `apiCalls` limit, `plan_read_only`, `rate_limited` retried only for reads),
  `transports.test.ts` (`dist/index.js` over stdio and Streamable HTTP: scope hiding, two keys at once, Host / Origin,
  413, 405, refused keys, and logs free of keys, arguments and results) and `flows.test.ts` (one realistic flow).
  With the app's test hooks (the e2e server) the plan tests also run as the cloud edition, and the `rate_limited`
  tests lower the limit for themselves; without them those three are skipped. `MCP_HTTP_URL` points the HTTP tests at a
  server that already runs on the same network, e.g. the image:
  `docker run -d --name mcp-it --network <net> --read-only -e SOL2FLOW_URL=http://app-e2e:3000 -e ALLOWED_HOSTS=mcp-it:3000 ghcr.io/sol2flow/mcp:dev`,
  then `make test-integration APP_CONTAINER=… MCP_HTTP_URL=http://mcp-it:3000 ARGS="test/integration/transports.test.ts -t Streamable"`.
  CI runs it by hand and weekly (`integration.yml`), and on pull requests once the repository is public.

### Code map

| Path                                     | What                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `src/index.ts`                           | The CLI                                                                |
| `src/config.ts`                          | Environment, flags, `*_FILE` secrets                                   |
| `src/server.ts`                          | One MCP server per key: tools, prompts, instructions                   |
| `src/transports/`                        | `stdio.ts` (key check at start), `http.ts` (stateless Streamable HTTP) |
| `src/api/`                               | The REST client, error mapping, the operations used, generated types   |
| `src/resolve/`                           | References (keys, names, URLs) and their cache                         |
| `src/tools/`                             | The tools (`registry.ts`: definitions, registration, error handling)   |
| `src/format/`                            | Markdown and JSON output                                               |
| `src/log.ts`, `log-file.ts`, `sentry.ts` | Logging and error tracking                                             |
| `test/fake-api/`                         | A fake sol2flow API (node:http) for the tests                          |
| `openapi/`                               | The vendored OpenAPI document (`make openapi-sync`)                    |

## Releases

Every push to `main` releases automatically (semantic-release, `.releaserc.json`): the Conventional Commits since the
last tag decide the version (`feat` minor, `fix`/`docs`/`perf`/`refactor`/`style` patch, `!` major — minor while 0.x;
`chore`/`ci`/`test`/`build` none). A release publishes `@sol2flow/mcp` to npm (`NPM_TOKEN`; with provenance once the
repository is public), tags `vX.Y.Z`, creates the GitHub release (the changelog), pushes the image as `:X.Y.Z`, `:X.Y`,
`:X` and `:latest`, and deploys.

## Deployment

After a release has pushed the image, the `deploy` job joins the Headscale tailnet (`HEADSCALE_URL`,
`HEADSCALE_AUTHKEY`) and sends an empty POST to `DEPLOY_WEBHOOK_URL`, which updates the stack. Without these settings
the job only prints a notice.

## License

MIT (see [LICENSE](LICENSE)); the bundled packages' licences are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). "sol2flow" and its logo are trademarks: see the
[trademark policy](https://github.com/sol2flow/sol2flow/blob/main/TRADEMARKS.md). Contributions are welcome under the MIT
licence, without a CLA ([CONTRIBUTING.md](CONTRIBUTING.md)). Security reports: [SECURITY.md](SECURITY.md).
