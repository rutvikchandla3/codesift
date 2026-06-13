# Implementation drifts and incomplete areas

Snapshot: M2 first critical-path slice in this working tree.

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

Still open / not yet proven:

1. **M2-3 grep parity is not proven against ripgrep.**
   - Current grep uses JavaScript `RegExp` semantics and scans files from the indexed file set.
   - The required random-literal superset-or-equal invariant vs `rg` is not yet implemented as a test/eval gate.
2. **M2-4 exact recall is not golden-set proven.**
   - Exact symbol + exact FTS candidate union exists, and path filtering is SQL-time.
   - `recall@k = 1.0` for exact identifiers/string literals, including path-scoped queries, still needs the M2 eval harness.
3. **M2-5 TTR/cold-latency eval is not implemented.**
   - `packages/eval` remains a scaffold relative to the M2 proof requirements: pinned repos, deterministic policy runner, paired codesift-vs-ripgrep deltas, CI regression gate, and `losses.json` are all still open.
4. **M2-6 token levers are only partially started.**
   - MCP returns compact text by default.
   - `maxTokens`, `tokensReturned`, overlap dedupe/merge, single-best-answer mode, query-centered snippets, and score-to-reason-tag payload changes are not implemented.
5. **M2-7 latency decisions are not recorded.**
   - No measured `vec0`/ANN crossover yet.
   - No daemon timing decision yet.
   - PLAN §12 has not been updated with these decisions.
6. **HTTP MCP remains scaffolded.**
   - M2 exit criteria are stdio-focused, but `codesift serve` still should not be represented as complete.

## Verification run for this snapshot

- `pnpm run ci` passes locally.
- `pnpm run test:smoke-install` skips on Node 24.14.0 with the expected unsupported-engine message; rerun on Node 20 or 22 before claiming packed-install proof.

## Next no-drift steps

1. Add ripgrep parity tests for `Repo.grep()` / `codesift grep`.
2. Build the M2 eval harness enough to prove exact recall and paired TTR/latency deltas.
3. Add M2 token-budget result shaping (`maxTokens`, dedupe, single-best exact answer).
4. Record measured latency decisions in `PLAN.md` once data exists.
