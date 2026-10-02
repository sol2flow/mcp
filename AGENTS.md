# AGENTS.md — how to work in this repo

The sol2flow MCP server: TypeScript (ESM, strict), the MCP SDK and zod, bundled by esbuild into one file. It talks to
sol2flow **only through the public REST API** (`/api/v1`); the app (sol2flow/sol2flow) and the docs (sol2flow/docs)
are separate repositories. README.md is the user reference; DEVELOPMENT.md covers building, testing and releasing.

## Ground rules

1. **The API decides.** No permission logic of our own: plan, key scope, workspace API access and roles are the
   API's. Tools call the API with the caller's key and map its errors (`src/api/errors.ts`) to text the model can act
   on.
2. **Every operation is declared.** New API calls go into `src/api/operations.ts` (by operationId) and into the tool's
   `ops`; the contract test checks them against `openapi/openapi-<version>.json` (`make openapi-sync` refreshes it).
   A tool's `scope` must match its operations' `x-required-scope`.
3. **Never retry writes.** The API has no idempotency keys. A write without an answer says "may or may not have been
   applied; check first".
4. **Older instances keep working.** The oldest supported API is the vendored snapshot's version. Newer features are
   detected (the `Sol2flow-Api-Version` header, optional fields such as `/me.api_key`) and degrade gracefully; an
   unknown endpoint is "instance too old for <tool>", never a crash.
5. **stdout is the protocol in stdio mode.** Log through `src/log.ts` (stderr there); never `console.log`.
6. **Never log the key, tool arguments or results.** Log the tool, outcome, duration, status, client IP and the key's
   8-character prefix. `test/unit/log.test.ts` guards this.
7. **Tools:** `verb_noun`, no prefix, descriptions start with "sol2flow:", references by key / name / URL
   (`src/resolve/refs.ts`), compact Markdown output with `response_format: "json"`, annotations set. No deletes
   (archive instead) until elicitation can confirm them.
8. **Zero runtime dependencies in the package:** everything is bundled into `dist/index.js`; the Sentry SDK is a
   separate bundle shipped only in the image. Update THIRD-PARTY-NOTICES.md with `make notices` after dependency
   changes (CI checks it).
9. **Formatting** is Prettier (`.prettierrc.json`, 120 columns): `make format` before `make check`.
10. **Commit messages** are Conventional Commits (CONTRIBUTING.md); they decide the version (semantic-release). Never
    commit a version bump or a CHANGELOG.

## Commands (all in Docker)

```
make check              # format check + lint + typecheck + tests + bundle + npm pack --dry-run
make test               # unit, protocol, contract (fake API)
make test-integration   # against a real app: an image on PostgreSQL 18, or APP_CONTAINER=<running app on *_test>
make dev | inspector    # HTTP server on 3005 | MCP Inspector on 6274
make openapi-sync       # refresh the vendored OpenAPI document and types
```
