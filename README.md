# codesift

Local-first hybrid code search for repositories, delivered as one TypeScript core with three thin interfaces:

- `codesift` CLI
- `@codesift/core` SDK
- `@codesift/mcp` server

## Status

M1 walking skeleton is live and in final polish.

Implemented today:

- repository scan with `.gitignore` / `.codesiftignore` support
- TS/JS structural chunking via the TypeScript compiler API
- Python structural definition chunking
- fallback line-window chunking for other supported text files
- local semantic embeddings via a built-in provider
- SQLite-backed local index with `sqlite-vec`
- end-to-end `index`, `search`, `sym`, `status`, and `clean` CLI flows

Still intentionally deferred to later milestones:

- hybrid BM25 + vector fusion
- exact-symbol boost
- incremental freshness / watch mode
- full MCP transport implementation
- production local ONNX embedding model

## Supported platforms

| Environment | Node | Notes |
| --- | --- | --- |
| macOS (`macos-latest`) | 20.x, 22.x | GitHub Actions coverage |
| Ubuntu (`ubuntu-latest`) | 20.x, 22.x | glibc coverage |
| Alpine Linux (`node:<version>-alpine`) | 20.x, 22.x | musl coverage + packed-install smoke test |
| Windows (`windows-latest`) | 20.x, 22.x | GitHub Actions coverage |

## Trust posture

- Telemetry: **none**.
- Default local `index` / `search` / `sym` / `status` flows are covered by offline / zero-egress CI checks.
- `.codesift/` self-installs a local `.gitignore` with `*` on first open/index so the index never shows up in `git status`.
- If `sqlite-vec` is unavailable, lexical and symbol queries still work; vector search reports degraded mode instead of failing at repo open.

## Workspace

```text
packages/
  core/   @codesift/core
  cli/    codesift
  mcp/    @codesift/mcp
  eval/   private eval harness
```

## Quickstart

```bash
pnpm install
pnpm build
pnpm test

node packages/cli/dist/bin.js index .
node packages/cli/dist/bin.js search "where is the sqlite database opened" -k 5
node packages/cli/dist/bin.js sym SqliteRepo
```

## Commands

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm run test:offline
pnpm run test:smoke-install
pnpm run ci
```

See `PLAN.md` for the full product plan.
