# Implementation drifts and incomplete areas

Snapshot: M5 interfaces (HTTP MCP transport, cloud providers, config/rebuild, SDK freeze + typedoc) completed in this working tree, on top of the completed M0–M4 work.

This file is the no-hidden-drift ledger. If a PLAN/M2_PLAN/M5_PLAN requirement is not implemented or not proven yet, it is listed here instead of implied by README/status wording.

## Completed in the M5 snapshot

- Real streamable HTTP MCP transport (`packages/mcp/src/http.ts`) wired to CLI `codesift serve`, over the same `createSdkServer` registry as stdio; binds `127.0.0.1` by default; optional constant-time bearer token. Proven by `packages/mcp/test/http.test.ts` + a CLI serve smoke.
- Opt-in cloud embedding providers `voyage-code-3` and `openai-text-embedding-3-small` (`isLearned: true`), registered but not default, with lazy key reads and no import-time/local-path network.
- Secret-scan + redaction (`packages/core/src/secret-scan.ts`) gating the cloud document-embed path; `--allow-secrets` redacts, otherwise refuses before any network/key use.
- `.codesift/config.json` (`packages/core/src/config.ts`) + CLI `config get|set`; provider resolution precedence (explicit > env > config > default); `openRepo(root, options?)`; provider-switch surfaces guided `--rebuild`.
- Frozen `@codesift/core` SDK surface + `docs/sdk.md` quickstart proven by `packages/core/test/sdk-quickstart.test.ts`; `typedoc.json` + `pnpm run docs` (0 errors).

## Completed in earlier drift snapshots

These items were landed before M5 and remain implemented in the repo:

- FTS5 `chunks_fts`, BM25 ranking, and RRF-style fusion.
- Symbol boost and exact-symbol candidate handling in `search()`.
- Stable content/location chunk ids.
- Core read primitives: `readChunk()` and `readRange()`.
- Provider/schema/dims/model compatibility guard with guided rebuild errors.
- CLI `--kind` and `--compact` for search.
- Real MCP stdio server for `codesift mcp` using `@modelcontextprotocol/sdk`.
- MCP tools: `search_code`, `find_symbol`, `grep_code`, `read_chunk`, `index_status`.
- MCP server instructions and per-tool input schemas.
- Core `Repo.grep()` plus CLI `codesift grep` for literal/regex search over indexed files.
- SQL-time path filtering for search/symbol paths, including a regression test for pre-truncation filtering.
- M3 parser-quality structural chunk/symbol extraction for Go, Java, Ruby, and Rust, with an accepted no-tree-sitter-yet decision recorded in `PLAN.md` §12.10.
- Heading-aware Markdown chunks and top-level key/section chunks for JSON, YAML, and TOML.
- Nested `.gitignore` / `.codesiftignore` handling, default vendor/third-party ignores, generated/minified flagging + down-ranking, generated result/status UX, and oversized chunk splitting.
- Local M3 eval fixture repos for Go, Java, Ruby, and Rust covering `search_code`, `find_symbol`, and `grep_code` behavior.
- M4 initial freshness path: manifest-diff incremental `sync()`, deletion/touched-file handling, mtime/size + git branch/HEAD staleness reasons, stale search-hit annotations, SQLite `busy_timeout`, and foreground polling `watch()` / `codesift index --watch`.

## Current honest status by milestone

### M0

Practical scaffold is in place. Strict release-readiness is still not fully proven:

1. **npm name/package publication is not proven in this repo.**
   - Package names are set, but no actual npm publish/reservation proof is checked in.
2. **Remote GitHub Actions green status is not proven here.**
   - Local CI passes; remote matrix status must be verified outside this working tree.
3. **Packed install smoke was not run under a supported Node in this session.**
   - `pnpm run test:smoke-install` skips on Node 24 because the project supports Node 20/22.

### M1

M1 addendum contracts are mostly implemented, but these product/architecture drifts remain:

1. **Default embeddings are lexical/heuristic, not a real learned ONNX model.**
   - README/CLI/MCP correctly avoid claiming semantic/hybrid behavior unless a learned provider is active.
2. **Python chunking is structural regex/indentation, not Python AST.**
3. **TS/JS chunking uses the TypeScript compiler API, not tree-sitter WASM.**

### M2

Implemented in the current slice:

- M2-1 real stdio MCP transport with JSON-RPC smoke coverage.
- M2-2 routing instructions and schemas.
- M2-3 first implementation of literal/regex grep in core, CLI, and MCP.
- M2-4 first implementation of exact candidates plus SQL path filtering.
- M2-5 pinned-OSS paired eval runner (`jshttp/cookie`, `pallets/itsdangerous`, `sindresorhus/escape-string-regexp`) with checked-in `losses.json` and full stdio spawn→first-result cold timing.
- M2-6 token levers: `maxTokens` / `max_tokens`, `tokensReturned`, overlap dedupe, single-best identifier answers, query-centered snippets, short read ids, and reason tags instead of default raw scores.
- M2-7 decisions recorded in `PLAN.md` §12.8 for `vec0`/ANN crossover and daemon timing.
- Exit criterion #5 has an automated deterministic routing proof in the eval summary and unit test: all benchmark tasks select `search_code`, `find_symbol`, or `grep_code`; host grep selections are zero.

Still open / not yet proven:

1. **HTTP MCP is now real (resolved in M5).**
   - `codesift serve` runs a real streamable HTTP transport with an optional bearer token; see the M5 section.
2. **Cold stdio latency is an accepted one-time startup tax for M2.**
   - The tax is now measured and recorded as `latency.cold` entries in `packages/eval/losses.json` rather than hidden.
   - Normal MCP clients keep `codesift mcp` alive, so this cost is paid once per repo/client session, not per search.
   - Token losses against `rg` are currently cleared from the M2 loss budget.

### M3

M3 is complete:

- Go, Java, Ruby, and Rust use hardened structural scanners rather than tree-sitter WASM. The accepted decision is documented in `PLAN.md` §12.10: avoiding grammar packaging/install surface is preferable for v0.1 until learned-vector quality justifies that dependency.
- The scanners mask comments/strings before brace parsing, preserve parent breadcrumbs, suppress duplicate same-range chunks, and extract modules/classes/types/interfaces/traits, functions/methods, constants, and variables where sensible.
- Markdown headings and JSON/YAML/TOML top-level keys/sections are named chunks and symbols where appropriate.
- Oversized structural chunks split into bounded overlapping windows before embedding/indexing; regression coverage asserts max chunk size.
- Nested ignore files are honored during scanning; `vendor/`, `third_party/`, and `__generated__/` remain default ignored.
- Generated/minified files outside ignored dirs are indexed with a `generated` flag, down-ranked in search, annotated in search output, and counted in status.
- `packages/eval/fixtures/m3-{go,java,ruby,rust}` plus `packages/eval/fixtures/manifest.json` provide per-language spot checks for `search_code`, `find_symbol`, and `grep_code`.

### M4

M4 is complete in the current working tree:

- `sync()` now diffs against the `files` manifest and only re-chunks/re-embeds changed or added files; removed files are deleted from `files`, `chunks`, `chunks_fts`, and `symbols`.
- Hash-identical touched files refresh manifest mtime/size without rebuilding chunks.
- Content-addressed embedding cache entries are keyed by provider/dims/model/content hash, so delete+add or rename cases with identical code reuse prior embeddings.
- Sync writes into a shadow database copied from the current index and atomically swaps it into place only after embeddings and replacement writes finish.
- Failed/aborted embedding work leaves the previous index in place; `status().sync` exposes `running`, `completed`, `failed`, and `aborted` metadata with errors where available.
- `status().stale` is real for added/modified/removed indexable files and git branch/HEAD drift, with structured `staleReasons`.
- `search()` annotates stale hits, and CLI formatters surface `[stale]` / `stale` markers.
- `watch()` and `codesift index --watch` use native `fs.watch` directory subscriptions with a bounded safety poll fallback, then refresh through incremental `sync()`.
- `codesift mcp` is now a thin stdio shim that starts or reuses a local daemon over a local socket, then proxies MCP JSON-RPC to daemon-held repos.
- The CLI build is split so the MCP shim entry stays small while the heavy core/MCP implementation loads in the daemon process.
- Regression coverage now includes content-cache rename/delete+add reuse, failed shadow-sync preservation, aborted sync status, git branch/HEAD drift, daemon-backed MCP stdio, and a larger-repo watch edit that resolves inside the 5s M4 target.

Still open / not yet proven:

- No M4 implementation items remain open. Release packaging proof still needs `test:smoke-install` under Node 20/22.

### M5

M5 is complete in the current working tree:

- Streamable HTTP MCP transport (`codesift serve`) is real, stateless, and reuses the stdio tool registry; optional bearer token compared in constant time; binds `127.0.0.1` by default. Covered by `packages/mcp/test/http.test.ts` (HTTP round-trip + 401 cases) and a manual CLI serve smoke.
- Cloud providers `voyage-code-3` / `openai-text-embedding-3-small` are registered, learned, opt-in, and never default; keys are read lazily and no network occurs at import or on the local path (offline gate still green).
- Secret-scan/redaction gates the cloud document-embed path; `--allow-secrets` (CLI) + `SyncOptions.allowSecrets` + config `allowSecrets` thread the flag; the local path is never gated. Verified manually: a planted AWS key refuses before any key/network use; `--allow-secrets` redacts then proceeds to the missing-key error.
- `config get|set`, `.codesift/config.json`, provider resolution precedence, `openRepo(root, options?)`, and provider-switch `--rebuild` guidance are implemented and exercised via the CLI.
- SDK surface frozen + re-exported (`RepoOptions`, `SearchReasonTag`, config API, provider/secret-scan symbols); `docs/sdk.md` quickstart proven by `packages/core/test/sdk-quickstart.test.ts`; `pnpm run docs` builds with 0 errors.

Still open / not yet proven:

- `vec0` vector arm is **intentionally deferred to M6** (PLAN §12.8/§12.11): cloud providers are opt-in, so the default-supported-learned-provider trigger has not fired. Until then a learned-vector index uses the blob-column `ORDER BY` arm.
- Cloud provider request/response shapes are covered by stubbed-`fetch` unit tests, not a live API round-trip (no network in CI by design; no real key exercised in this session).
- Packed-install proof still needs `test:smoke-install` under Node 20/22 (this session ran Node 24, where the smoke test skips).

## Verification run for this snapshot

- `pnpm run ci` (build · typecheck · test · test:offline · bench) passes locally; 54 tests pass; `pnpm run test:offline` confirms zero egress with cloud providers registered; `pnpm bench` shows 0 new losses against the M3 cold-latency-only baseline.
- `pnpm run docs` builds the typedoc reference with 0 errors (1 environmental warning: no local `origin` git remote).
- Manual CLI proofs: `serve` with a token returns 401 (no/wrong token) and 200 (correct bearer) over real HTTP; `config set provider` round-trips and prints rebuild guidance; cloud-provider index refuses a planted secret pre-network and redacts under `--allow-secrets`.
- `pnpm run test:smoke-install` was not rerun for this M5 snapshot; rerun on Node 20 or 22 before claiming packed-install proof.

## Next no-drift steps

1. M6: replace the blob-vector arm with sqlite-vec `vec0` (gated on a default-supported learned provider), add a default learned/local model, and tune retrieval knobs against expanded golden sets.
2. Exercise the cloud providers against a live API (out-of-CI) to confirm real request/response shapes and dims.
3. Run `test:smoke-install` under Node 20/22 and verify the remote CI matrix for packaged-install + publish readiness.
