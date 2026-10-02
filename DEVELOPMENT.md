# Development

How to build, test and release the sol2flow MCP server. For using it, see [README.md](README.md);
for contributing, [CONTRIBUTING.md](CONTRIBUTING.md).

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

## Tests

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

## Code map

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
