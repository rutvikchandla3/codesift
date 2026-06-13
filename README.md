# codesift

Local-first lexical code search for repositories, delivered as one TypeScript core with three thin interfaces:

- `codesift` CLI
- `@codesift/core` SDK
- `@codesift/mcp` server

## Status

M2 implementation is complete on top of the M1 walking skeleton.

Implemented today:

- repository scan with `.gitignore` / `.codesiftignore` support
- TS/JS structural chunking via the TypeScript compiler API
- Python structural definition chunking
- fallback line-window chunking for other supported text files
- SQLite-backed local index with FTS and lazy `sqlite-vec` loading
- end-to-end `index`, `search`, `sym`, `grep`, `status`, and `clean` CLI flows
- stable chunk ids plus on-demand chunk/range reads from disk
- real MCP stdio transport with `search_code`, `find_symbol`, `grep_code`, `read_chunk`, and `index_status`
- token-budgeted compact search results (`maxTokens` / `max_tokens`), overlap dedupe, single-best identifier answers, query-centered snippets, and reason tags
- pinned-OSS eval harness with paired tokens-to-resolution plus stdio cold-start latency vs ripgrep and a checked-in loss budget

Still intentionally deferred to later milestones:

- production learned embedding provider
- watch mode and incremental freshness
- streamable HTTP MCP transport
- broader M6-quality golden sets and learned-vector ranking work

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
node packages/cli/dist/bin.js grep -e "SqliteRepo" --path 'packages/core/**'
node packages/cli/dist/bin.js sym SqliteRepo
```

## MCP recipe

After indexing a repo, point an MCP client at the stdio command:

```bash
codesift mcp /path/to/repo
```

Routing policy for agents: `find_symbol` for identifiers/definitions, `grep_code` for exact strings or regex, and `search_code` for behavior/concept queries. Keep host grep as fallback, not the first tool. `search_code` is compact by default and accepts `max_tokens` for strict context budgets.

Cold-start note: `codesift mcp` has a measured stdio startup cost, but normal MCP clients keep the server process alive, so this is a one-time repo/session tax; subsequent searches use the warm path. The M4 daemon will further reduce this startup cost.

## Commands

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm run test:offline
pnpm --filter @codesift/eval run bench
pnpm run test:smoke-install
pnpm run ci
```

See `PLAN.md` for the full product plan.
