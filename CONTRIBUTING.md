# Contributing

Thank you for helping! Contributions are accepted under the MIT licence (LICENSE) — by opening a pull request you agree
that your contribution is licensed under it. There is no CLA.

- Run `make hooks` once per clone, `make format` and `make check` before you push; CI runs the same plus an image
  build. Changes to how the server talks to sol2flow need a test against the fake API (`test/fake-api`), and new API
  operations must be in the vendored OpenAPI document (the contract test checks them).
- Keep the rules in AGENTS.md: the API decides permissions, writes are never retried, nothing secret is logged, stdout
  is the protocol in stdio mode.
- Never commit `.env` files, API keys or other secrets.
- Report security problems privately (SECURITY.md), not in issues.

## Commit messages

Commits and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org), as in the other
sol2flow repositories: `type(scope): summary`, lowercase, imperative, the subject at most about 72 characters. Pull
requests are squash-merged, so the title becomes the commit message on `main`; a CI check enforces it, and the
`commit-msg` hook (`.githooks/commit-msg`) checks local commits.

```text
feat(tools): add list_comments
fix(http): answer 413 before reading the whole body
chore(deps): update the MCP SDK
```

Types: `feat`, `fix`, `perf`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `style`, `revert`.

The commit type decides the release: every push or merge to `main` releases automatically (npm, the image, the
GitHub release). `feat` → minor; `fix`, `perf`, `docs`, `refactor`, `style`, `revert` → patch; a breaking change (`!`
or a `BREAKING CHANGE:` footer) → major (minor while the version is `0.x`); `chore`, `ci`, `test`, `build` → no
release. The title is the line in the release notes: write it for readers of the
[releases page](https://github.com/sol2flow/mcp/releases).

## Trademark

The code is MIT; the name "sol2flow" and its logo are not. A fork must not present itself as the official sol2flow MCP
server: see the [trademark policy](https://github.com/sol2flow/sol2flow/blob/main/TRADEMARKS.md).
