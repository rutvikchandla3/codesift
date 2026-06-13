# Implementation drifts and incomplete areas

Snapshot: first M3 implementation slice in this working tree.

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
- First M3 structural chunk/symbol extraction for Go, Java, Ruby, and Rust.
- Heading-aware Markdown chunks and top-level key/section chunks for JSON, YAML, and TOML.
- Nested `.gitignore` / `.codesiftignore` handling, default vendor/third-party ignores, generated/minified flagging + down-ranking, and oversized chunk splitting.

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
4. **`sync()` is still full rebuild style, not manifest-diff incremental indexing.**
5. **`watch()` remains a no-op and CLI watch is explicitly reserved for M4.**
6. **Freshness/staleness reporting is not real yet.**
   - `status().stale` is still always false.

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

First implementation slice now landed:

- Go, Java, Ruby, and Rust structural chunking plus symbol extraction are wired into `buildChunks()`.
- Markdown headings and JSON/YAML/TOML top-level keys/sections now become named chunks.
- Oversized structural chunks split into bounded overlapping windows before embedding/indexing.
- Nested ignore files are honored during scanning; `vendor/`, `third_party/`, and `__generated__/` are default ignored.
- Generated/minified files outside ignored dirs are indexed with a `generated` flag and down-ranked in search instead of silently winning neutral queries.

Still open / not yet proven:

1. **New language parsers are structural regex/brace scanners, not tree-sitter AST.**
   - This starts M3 coverage and symbols, but does not yet meet the final AST-quality wording in `PLAN.md`.
2. **Per-language eval-set spot checks are unit-level only.**
   - `packages/core/test/m3.test.ts` proves representative fixtures; pinned OSS per-language eval fixtures are still needed before M3 sign-off.
3. **Generated code has a down-ranking flag but no public result annotation yet.**
   - Search scoring uses it; status/result UX can be improved later if needed.

## Verification run for this snapshot

- `pnpm build` passes locally.
- `pnpm typecheck` passes locally.
- `pnpm test` passes locally.
- `pnpm run test:offline` passes locally.
- `pnpm --filter @codesift/eval run bench` passes locally with no new losses and no token-loss axes.
- `pnpm run test:smoke-install` skips on Node 24.14.0 with the expected unsupported-engine message; rerun on Node 20 or 22 before claiming packed-install proof.

## Next no-drift steps

1. Finish M3 with tree-sitter-quality parsers or an explicit accepted parser-quality decision plus pinned per-language OSS spot checks.
2. Implement the M4 daemon/watch path that reduces the measured stdio one-time startup tax.
3. Replace the blob-vector arm with sqlite-vec `vec0` before learned-vector support is presented as default-ready.
4. Keep expanding the pinned OSS golden set for M6 quality numbers.
