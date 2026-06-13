# codesift

Local-first lexical code search for repositories, delivered as one TypeScript core with three thin interfaces:

- `codesift` CLI
- `@codesift/core` SDK
- `@codesift/mcp` server

## Status

M5 interfaces are complete on top of the completed M3/M4 slices: streamable HTTP MCP transport with optional bearer token, opt-in cloud embedding providers (Voyage, OpenAI) with secret-scan/redaction, repo `config` + provider resolution + guided `--rebuild`, and a frozen SDK surface with typedoc.

Implemented today:

- repository scan with `.gitignore` / `.codesiftignore` support
- TS/JS structural chunking via the TypeScript compiler API
- Python structural definition chunking
- M3 parser-quality structural scanners + symbols for Go, Java, Ruby, and Rust
  - accepted M3 decision: no tree-sitter WASM dependency yet; deterministic scanners avoid native/postinstall grammar pain and are hardened with comment/string masking plus real-world fixtures
- heading-aware Markdown chunks and top-level key/section chunks for JSON, YAML, and TOML
- fallback line-window chunking for other supported text files
- SQLite-backed local index with FTS and lazy `sqlite-vec` loading
- end-to-end `index`, `search`, `sym`, `grep`, `status`, and `clean` CLI flows
- manifest-diff incremental `sync()` / `index` updates for changed, touched, and removed files
- content-addressed embedding cache so delete+add/rename cases with identical code reuse embeddings
- stable chunk ids plus on-demand chunk/range reads from disk
- real MCP stdio transport with `search_code`, `find_symbol`, `grep_code`, `read_chunk`, and `index_status`
- token-budgeted compact search results (`maxTokens` / `max_tokens`), overlap dedupe, single-best identifier answers, query-centered snippets, reason tags, and stale-hit annotations
- oversized structural chunk splitting, nested ignore-file handling, default vendor ignores, generated/minified code down-ranking, generated result annotations, and generated counts in status
- real `status().stale` from mtime/size manifest drift plus git branch/HEAD drift
- `status().sync` / MCP `index_status` crash-state metadata for running, failed, and aborted syncs
- shadow database sync writes with atomic index-file swap so failed rebuilds keep the previous index readable
- native `fs.watch`-based `watch()` / `codesift index --watch` with a safety poll fallback, refreshing through the same incremental path
- daemon-backed `codesift mcp` shim: the CLI fast-path starts/proxies to a long-lived local daemon so repo handles and MCP routing are amortized across agent sessions
- real streamable HTTP MCP transport (`codesift serve`) over the same tool registry, binding `127.0.0.1` by default with an optional constant-time bearer token
- opt-in cloud embedding providers `voyage-code-3` and `openai-text-embedding-3-small` (lazy key reads, no egress until an embed runs) behind the same `EmbeddingProvider` interface
- secret-scan + redaction gate on the cloud document-embed path (`--allow-secrets`); the local default path never egresses
- `.codesift/config.json` + `codesift config get|set` provider/model/ignore/allowSecrets, with provider resolution precedence and guided `--rebuild` on a provider switch
- frozen `@codesift/core` SDK surface with a typedoc reference (`pnpm run docs`) and a documented quickstart proven by a test
- pinned-OSS + local M3 fixture eval harness with paired tokens-to-resolution plus stdio cold-start latency vs ripgrep and a checked-in loss budget

Still intentionally deferred to later milestones:

- production-default learned embedding provider (cloud providers ship opt-in in M5; a default learned/local model is M6)
- optional future tree-sitter WASM migration if bundled grammars can be added without install pain
- sqlite-vec `vec0` virtual-table vector arm (M6; gated on a default-supported learned provider — see `PLAN.md` §12.8/§12.11)
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
- Cloud embedding is **opt-in only** (explicit provider config + an API key env var); content is secret-scanned and refuses to send without `--allow-secrets`, which redacts first.
- `.codesift/` self-installs a local `.gitignore` with `*` on first open/index so the index never shows up in `git status`.
- If `sqlite-vec` is unavailable, lexical and symbol queries still work; vector search reports degraded mode instead of failing at repo open.

## M3 chunking hardening

- Default ignored directories include `vendor/`, `third_party/`, and `__generated__/`; nested `.gitignore` and `.codesiftignore` files are honored.
- Generated files are detected from path patterns (`*.generated.*`, `*.gen.*`, `*.pb.go`, `*_pb2.py`, `*_pb.rb`, `*.designer.*`), header markers (`@generated`, `Code generated by`, `DO NOT EDIT`, etc.), and minified shape (average nonblank line length >300 or any line >2000 chars).
- Generated files outside ignored directories are indexed, not dropped: search down-ranks them, result formatters annotate them, and `status` reports generated file/chunk counts.
- Oversized structural chunks split into bounded overlapping windows before indexing; Markdown headings and JSON/YAML/TOML top-level keys become named chunks.

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

Cold-start note: `codesift mcp` is now a small stdio shim that starts or reuses a local codesift daemon, then proxies MCP JSON-RPC to it. The daemon exits after an idle timeout and can be pinned with `CODESIFT_DAEMON_SOCKET` / `CODESIFT_DAEMON_IDLE_MS` when tests need isolation.

### HTTP transport (second machine / shared index)

```bash
codesift serve /path/to/repo --port 7345 --token <bearer>   # streamable HTTP MCP, binds 127.0.0.1
```

`serve` exposes the same five tools over the MCP streamable-HTTP transport. It binds `127.0.0.1` by default; pass `--host` to widen and `--token` to require `Authorization: Bearer <token>` (compared in constant time). Use it for a second process/machine on a trusted network — multi-repo/team auth remains post-MVP.

### Cloud embedding providers (opt-in)

Local lexical search is the zero-config default and never leaves the machine. To use a learned cloud provider:

```bash
export VOYAGE_API_KEY=...                       # or OPENAI_API_KEY
codesift config set provider voyage-code-3      # or openai-text-embedding-3-small
codesift index . --rebuild                      # rebuild with the new provider's vectors
```

Before any cloud send, indexed content is secret-scanned: a detected secret aborts the sync unless you pass `index --allow-secrets`, which sends a **redacted** copy instead. API keys are read lazily and only on the embed path; the default local flows stay zero-egress (enforced by `pnpm run test:offline`). Config precedence: explicit SDK `providerId` > `CODESIFT_EMBEDDING_PROVIDER` env > `.codesift/config.json` > local default.

### SDK reference

See `docs/sdk.md` for the frozen `@codesift/core` quickstart; `pnpm run docs` generates the full typedoc API reference into `docs/api/`.

## Commands

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm run test:offline
pnpm --filter @codesift/eval run bench
pnpm run test:smoke-install
pnpm run docs
pnpm run ci
```

See `PLAN.md` for the full product plan.
