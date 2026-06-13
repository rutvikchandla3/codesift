# Implementation drifts and incomplete areas

Snapshot: M4 freshness/watch implementation completed in this working tree.

This file is the no-hidden-drift ledger. If a PLAN/M2_PLAN requirement is not implemented or not proven yet, it is listed here instead of implied by README/status wording.

## Completed since the previous drift snapshot

The previous snapshot was stale. These items are now implemented in the repo:

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

1. **HTTP MCP remains scaffolded.**
   - M2 exit criteria are stdio-focused, but `codesift serve` still should not be represented as complete.
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

## Verification run for this snapshot

- `pnpm build` passes locally.
- `pnpm typecheck` passes locally.
- `pnpm test` passes locally.
- `pnpm run test:offline` passes locally.
- `pnpm bench` passes locally with the existing M3 cold-latency-only loss baseline.
- Real-repo `codesift index . --watch` proof passed locally: temp edit → `search` reflected the change in 850 ms.
- `pnpm run test:smoke-install` was not rerun for this M4 snapshot; rerun on Node 20 or 22 before claiming packed-install proof.

## Next no-drift steps

1. Move into M5: real streamable HTTP MCP, SDK API freeze/typedoc, and cloud provider/rebuild flows.
2. Replace the blob-vector arm with sqlite-vec `vec0` before learned-vector support is presented as default-ready.
3. Keep expanding the pinned OSS golden set for M6 quality numbers.
