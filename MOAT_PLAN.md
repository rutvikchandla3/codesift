# codesift Moat Plan — make it deadly vs raw `rg`/`grep`

> North star (already in `NUANCES.md:438`): *answer in **one call**, in **fewer tokens than grep**, **never slower**.*
> The shipped default violates all three. This doc is the plan to fix that, and **what can be built in parallel**.

Status: proposal (2026-06). All claims below are verified against the current `main`.

---

## TL;DR

- **The moat is NOT better string matching.** `rg` is near-ceiling on exact-identifier / string-literal / error-trace. Out-recalling it is the marginal-not-decisive trap.
- **The moat IS one-shot structural resolution:** return the *complete enclosing symbol body* (paste-ready) — and, where cheap and honest, its *real callers/usages* — in a **single tool call**, with rg's freshness and zero-setup trust intact.
- **The unlock is a coupled P0:** fix the eval to measure calls-to-resolution truthfully, *then* inline the top-hit body. These two ship together or not at all.

---

## Verified diagnosis (why there is no moat today)

| # | Problem | Evidence (verified) |
|---|---------|---------------------|
| D1 | **Two-call tax is hard-coded.** `search_code` returns a 48-token, zero-context, single-line teaser built from only the first 8 stored lines of a chunk → not usable code → agent must call `read_chunk`. Strictly worse than `rg -C5` on calls-to-resolution. | `DEFAULT_SNIPPET_TOKEN_BUDGET=48`, `DEFAULT_SNIPPET_CONTEXT_LINES=0` (`repo.ts:132-133`); `buildSnippet ... .slice(0, 8)` (`chunking.ts:1316`); `chunks` table stores `snippet`, not full content (`repo.ts:1056`); ` ↩ ` line-join (`mcp/src/index.ts:555`). |
| D2 | **No semantic moat by default.** Default provider `lexical-v1` returns all-zero vectors, so "hybrid" collapses to pure FTS5/BM25 — a second lexical engine the agent already has via `rg`. | `DEFAULT_EMBEDDING_PROVIDER_ID='lexical-v1'`; `embedBatch` returns `new Float32Array(dims)` (zeros) (`embedding.ts:5,55-57`). |
| D3 | **Brittle NL recall.** `buildFtsQuery` AND-joins every content stem with no synonym/OR expansion. The one query class where codesift could beat rg (nl-concept) is handicapped. The `SYNONYM_MAP` exists but is wired only into the local-hash *fixture* embedder, never the real query path. | `.join(' AND ')` (`repo.ts:2319`); `SYNONYM_MAP` used only at `embedding.ts:82` (fixture provider). |
| D4 | **Eval is blind to the tax.** `tokensToResolution` scores only the `search_code` output; never charges the mandatory `read_chunk`, and models `rg` at bare match-line (no `-C5`). The harness "wins" in a fictional one-call world, and would flag the moat fix as a regression. | `estimateTokenCount(formatSearchHits(hits))` only (`eval/src/index.ts:565`); `read_chunk` never executed in harness; `formatRipgrepHits` emits one trimmed line (`eval/src/index.ts:915`). |
| D5 | **No relational answers.** `symbols` table stores definitions only; there is no refs/call-edge table. "Who calls X" requires the agent to grep + read (3 calls). | `symbols` schema (`repo.ts:1075-1085`). |

`NUANCES.md` already anticipated most of this: line 31 (TTR "measured nowhere"), 127 ("definition + every usage in one call"), 165 ("two-step loop... CRITICAL"), 230-232 (reranker = opt-in `--rerank`, gated on query type).

---

## The moat statement

> codesift must be the tool that returns **exact, paste-ready code plus the structural edges grep can't see** — the enclosing symbol body in one call, and its real callers/usages — collapsing the agent's `search → read → grep` loop into a **single call**, with rg's freshness and zero-setup trust intact.

---

## Workstreams

| ID | Workstream | Effort | Priority | Primary files | Depends on |
|----|-----------|--------|----------|---------------|------------|
| **0a** | Eval: conditional + symmetric calls-to-resolution, end-to-end tokens, `rg -C5` baseline, per-type MRR@1, rebaseline `losses.json` | S–M | **P0** | `eval/src/index.ts`, `eval/losses.json` | — |
| **0b** | Inline full enclosing-symbol body for top hit (fresh from disk), two-tier token budget, fallback to compact snippet | M | **P0** | `repo.ts` (`buildBudgetedSearchHits`/`buildSearchHit`/`search`), `types.ts` | 0a (to land) |
| **0c** | Structure-preserving output: kill ` ↩ ` join, real newlines + indentation + `NN \| code` prefixes | S | **P0** | `mcp/src/index.ts` (`compactSnippet`) | — (lands with 0b) |
| **1** | Synonym-aware OR-expansion in `buildFtsQuery`; relax over-conservative vector-suppression gate | S–M | **P1** | `repo.ts` (`buildFtsQuery`, `queryShouldUseVectorSearch`), `embedding.ts` | — |
| **2** | Definition → **import-resolved** usages bundled in response (TS/JS + Python only), `with_usages` flag | L | **P1** | `chunking.ts` (scanners), `repo.ts`, `mcp/src/index.ts`, `eval/src/index.ts` (new query type) | 0a (eval type) |
| **3** | Reranker as **opt-in** arm (Voyage/Cohere `rerank`), gated to nl-concept, behind `--rerank` | M | **P2** | `repo.ts` (`fuseRankedRows`), `providers/`, `types.ts` | 0a (to measure) |
| **4** | Rewrite MCP instructions + tool descriptions to assert single-call sufficiency | S | **P2** | `mcp/src/index.ts` (`MCP_SERVER_INSTRUCTIONS`, descriptions) | 0b (to be true) |

---

## Parallelization

### Dependency graph

```
              ┌─────────────────────── TRACK A: the moat (mostly sequential) ───────────────────────┐
              │                                                                                       │
   0a (eval) ─┼─► 0b (body inline) ──► 4 (MCP instructions)                                           │
              │        ▲                                                                              │
   0c (format)┘────────┘  (lands with 0b)                                                            │
              └───────────────────────────────────────────────────────────────────────────────────┘

   TRACK B (independent):  1 (synonym OR-expansion + vector gate)        ── parallel from day 1
   TRACK C (independent):  2 (def→usages)  ── needs small eval-type from 0a; otherwise parallel
   TRACK D (independent):  3 (opt-in reranker)  ── develop in parallel; LAND after 0a to measure lift
```

### What can run in parallel — 4 tracks, ~4 owners

- **Track A — Retrieval UX / the moat (owner 1).** `0a → 0b → 4`. Sequential *to land* (0a's rebaseline must precede/accompany 0b; 4's claim must follow 0b). `0c` is a small standalone cleanup that can be done by anyone and merged any time, but should be in place when 0b lands so the body renders with structure.
- **Track B — Lexical recall (owner 2).** `1` is **fully independent** of P0. Start day 1. No dependency on inlining, eval, or reranker.
- **Track C — Relational moat (owner 3).** `2` is independent feature work (new refs extraction in scanners + a `with_usages` flag). Only coupling: it wants a relational query type in the eval, which is a tiny add that can be folded into 0a — coordinate that one hunk.
- **Track D — Reranker (owner 4).** `3` is independent; the `Reranker` interface + provider + the `fuseRankedRows` hook can be built in parallel. **Land after 0a** so the lift is measurable on the real harness before any default flips (it stays opt-in regardless).

### Develop-in-parallel vs land-in-order

Several items can be *developed* concurrently but must *merge* in a specific order to keep CI green:

- **0a before 0b** (merge order). 0b inflates per-hit tokens; without 0a's redefinition + rebaseline, the loss budget gate goes red. Build both at once; merge 0a first.
- **0b before 4** (merge order). 4 tells agents "no follow-up read needed" — only true once 0b ships.
- **3 after 0a** (merge order). So `--rerank` lift shows up on the fixed metric.

### File-conflict hotspot — read before splitting work

`packages/core/src/repo.ts` is touched by **0b, 1, 2, 3** — but in *different functions*, so conflicts are avoidable with discipline:

| Item | Functions in `repo.ts` | Conflict risk |
|------|------------------------|---------------|
| 0b | `search`, `buildBudgetedSearchHits`, `buildSearchHit` | — |
| 1  | `buildFtsQuery`, `queryShouldUseVectorSearch` | low (disjoint from 0b) |
| 2  | new refs query + `findSymbol` neighborhood | low |
| 3  | `fuseRankedRows` (insert rerank stage after fusion) | low |

`packages/eval/src/index.ts` is touched by **0a (heavy), 2 (new query type), 3 (ablation metric)** — 0a owns the file; 2 and 3 add small isolated hunks. Coordinate merge timing or use a short-lived integration branch.

**Recommendation:** give each track its own git worktree/branch. The only files needing a coordination conversation are `repo.ts` (function-scoped, low risk) and `eval/src/index.ts` (0a lands first, others rebase).

### Suggested two-wave sequencing

- **Wave 1 (parallel):** 0a + 0b + 0c (Track A), 1 (Track B), scanner-side of 2 (Track C), Reranker interface + provider of 3 (Track D). Merge order: 0a → 0c → 0b → 1.
- **Wave 2 (parallel):** 4 (after 0b), query-side + `with_usages` of 2, wire `--rerank` of 3, prove lifts on the fixed eval.

---

## Item detail

### 0a — Fix the eval to measure the truth *(the real unlock)*
Redefine "resolution" = *the answer's actual code lines are in the agent's context*. For each tool, count a **second call + its tokens only when call-1 output isn't usable code** — symmetrically: `rg -C5` often already contains the answer (1 call); codesift's teaser usually does not (2 calls), so charge the `read_chunk` tokens. Actually execute `read_chunk` in the codesift policy when the snippet is non-usable. Add per-query-type **MRR@1** (MRR already computed at `index.ts:574` — just aggregate). Rebaseline `losses.json` in the same PR (the `rg -C5` baseline will blow up token deltas by design).

### 0b — Inline the full enclosing-symbol body for the top hit *(the moat move)*
For rank-1 (and rank-2 only within a score margin of rank-1), return the **verbatim enclosing chunk read fresh from disk** via the existing `readRange` path (`repo.ts:657`) — not the 8-line stored teaser. **Two-tier budget:** a body sub-budget (cap ~400 tok / ~50 lines per hit) for the inlined hit(s), compact signature+location for the tail, so hit-1 doesn't starve disambiguation breadth. On overflow or disk-read failure, fall back to the compact snippet (never throw). Reuse the existing `single_best` flag (`repo.ts:481`) so identifier-exact queries inline confidently. Add a `context: sig|body` param (default `body` for hit-1 only). **Collapses `search → read_chunk` into one call for the common "where/how is X" query.**

### 0c — Preserve structure in the output
Delete `compactSnippet`'s whitespace-strip + ` ↩ ` join for search hits (`mcp/src/index.ts:555`). Emit real `\n` with original indentation and a `NN | code` line-number prefix so the inlined body is paste-ready. (Note: this is a correctness fix, *not* a token win — the metadata rows are already terse from M2; do **not** re-do "TOON/tabular" work.)

### 1 — Synonym-aware OR-expansion + relax vector gate
Change `buildFtsQuery` (`repo.ts:2313`) from pure AND-of-stems to **OR-groups** using the existing `SYNONYM_GROUPS` (`embedding.ts:21`): e.g. `("validate" OR "verify" OR "check") AND ("jwt" OR "token")`. Lifts NL recall with **zero embeddings, zero network, zero staleness, zero re-index**. Also relax `queryShouldUseVectorSearch` (`repo.ts:2416`) so a single PascalCase/acronym token in an NL query (e.g. "validate JWT signature") doesn't suppress semantic intent — require *both* high symbol-density *and* short length before suppressing.

### 2 — Definition → import-resolved usages *(scoped honestly)*
Do **not** claim a SCIP code graph the scanners can't back (Go/Java/Ruby/Rust scanners are single-line def-keyword regexes; TS is syntactic-AST-only, no type checker). For **TS/JS + Python**, where import binding is locally resolvable, when the top hit is a definition, bundle its top-N **real usage sites** (file:line + 1-line context, comment/string-masked) behind a `with_usages` flag (default off). Label them *import-resolved, not type-resolved* in the tool description. Gate on a relational query type added to the eval (the small 0a coordination hunk). This is `NUANCES.md:127`'s "definition + every usage in one call," kept honest.

### 3 — Opt-in reranker only
Land the `Reranker` interface and wire **Voyage/Cohere `rerank`** as an opt-in arm (symmetric with embeddings), gated to nl-concept, behind `--rerank` — as `NUANCES.md:230-232` already decided. **Do not** default-on a local ONNX cross-encoder: it taxes install size, native deps, cold-start, and risks the zero-network offline gate — none of which beat rg. Keep RRF (k=60) as the recall-oriented candidate generator; insert rerank as a downstream re-scoring stage over ~top-25. Prove the lift on *your* eval before defaulting anything.

### 4 — MCP instructions assert single-call sufficiency
Current text primes the chain ("read_chunk only for the best id", `mcp/src/index.ts:131`). After 0b, rewrite to: *"search_code returns the complete top result inline; no follow-up read is normally needed. read_chunk is only for expanding additional hits or widening context."* Models are RL'd to grep — state the response contract explicitly so they don't reflexively re-read or re-grep.

---

## Anti-patterns (do NOT)

- **Don't** compete on out-recalling rg for exact / string / error queries — near-ceiling, marginal-not-decisive.
- **Don't** keep the 48-token teaser for the primary hit — show the full body or nothing; never a flattened teaser.
- **Don't** flip embeddings on for every query — it sacrifices the freshness / zero-setup parity that is codesift's legitimate tie with rg. Auto-escalate by query shape at most.
- **Don't** replace RRF with weighted score fusion — BM25 is unbounded, cosine is [0,1]; outliers swamp the dense signal.
- **Don't** ship syntactic name-matching dressed as a SCIP graph — that's just cached `rg`.
- **Don't** trust the current eval's "win" — it scores a one-call fiction. Fix measurement first.
- **Don't** pursue ColBERT / late-interaction / HyDE / per-item LLM relevance — conflicts with local-first, low-token, zero-telemetry.

---

## Open decisions

1. **Body-inline cap** — confirm ~400 tok / ~50 lines per hit, and whether rank-2 inlines on a score margin or never.
2. **`with_usages` default** — off (proposed) vs auto-on when the top hit is a definition.
3. **Reranker provider** — Voyage `rerank-2.5` vs Cohere; both opt-in.
4. **`losses.json` rebaseline** — single rebaseline PR coupled to 0a (proposed), or staged.
