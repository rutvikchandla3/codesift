# codesift Moat — Next Steps (post-MOAT_PLAN)

> North goal: give an AI coding agent the right context with **(1) fewer tool calls, (2) less tool output, (3) more accurate context** — i.e. *answer in one call, in fewer tokens than grep, never slower*, with rg's freshness and zero-setup trust intact.

Status: proposal (2026-06). The original `MOAT_PLAN.md` workstreams **0a–4 have shipped** on `main` (body-inline for the top `search_code` hit, structure-preserving output, synonym OR-expansion, `with_usages`, opt-in Voyage reranker, rebaselined per-type eval). This doc is what comes *next*, derived from a 31-agent map → ideate → adversarially-verify → synthesize pass. All file:line claims below were verified against the code.

> **Implementation progress** (branch `moat-next-wave-2`, paused 2026-06-19):
> - **Wave 1** shipped on local `main` (`71eedc3`): #1 one-call `find_symbol` body-inline, #2 self-fresh daemon (`Repo.watch()`), #3 honest token count + 4 quick wins.
> - **Wave 2 measurement gate** (`a6f2789`): precision/false-positive loss axis (rank-1 correctness, self-referential regression guard), multi-target **set-recall** (recall@k = fraction of co-relevant targets; per-target `ExpectedTarget.lineRange`), and the ambiguous-identifier **collision fixture** (`packages/eval/fixtures/collision-ts/`, authored via pi). Re-baselined losses.json (+3 honest entries).
> - **Wave 2 #4** (`0df655c`): progressive FTS relaxation ladder (full AND → drop-rarest by IDF → full OR), gated to fire only on `< MIN_RELAXATION_ROWS` underflow and OFF for symbol-dominated queries. Zero eval regression; mechanism proven by a dedicated core test.
> - **Wave 2 #6** (`5b862a6`): query-aware ranking, **precision-gated**. Loads `signature` into `ChunkRow`; keeps documentation headings out of the high-weight exact-symbol arm for code queries (a README "cookie" H1 was outranking `parseCookie`); demotes pure interface/type declarations ×0.92; meaningful tiebreak (term-coverage → function/method kind → stable key). The precision axis falsified the originally-planned coverage *multiplier* (it demoted `TimestampSigner.unsign` for the thin `validate` wrapper while resolving nothing), so coverage is a **tiebreak only**. Result: nl-concept mrr@1 0.86 → **1.00**, zero new losses, **cookie-parse-concept precision resolved** (re-baselined losses.json).
> - **Wave 2 #7** (`39a64a8`): confidence-gated `single_best`. Collapses an identifier-shaped query to k=1 only when it resolves to a SINGLE distinct definition; a collision (≥2 defs) returns a capped set (`AMBIGUOUS_IDENTIFIER_MAX_K = 3`) with an `ambiguous: N defs` hint on the top hit (plumbed through `SearchHit.ambiguousDefCount` → MCP renderer). Explicit `singleBest` always wins. Eval unaffected (no single-token-identifier nl-concept goldens). Covered by core gate tests + an MCP renderer test.
> - **Remaining (optional, report-only):** #5 `with_usages`/reranker A/B and paraphrase goldens — measurement only, must stay CI-excluded / non-gating. Build env: Node 22 (`~/.nvm/versions/node/v22.22.2/bin`), gate = `pnpm run ci`.

---

## Honest moat assessment

The moat now rests on **two legs, only one load-bearing**:

- **Leg 1 — real & defensible:** warm daemon + structural chunking + disk-fresh inline bodies let codesift answer a "where/how is X" query with the *complete enclosing symbol body in one call*. rg structurally cannot do this — it has no index, so it can never be both warm and pre-resolved.
- **Leg 2 — asserted, not yet wired:** freshness parity. The daemon caches a `Repo` per root but **never calls the already-built, tested `Repo.watch()`**, so long agent sessions go stale and burn an extra re-sync call. One wiring change from real.

**Where the moat is thin (be honest):**

1. **The default semantic arm is dead.** `lexical-v1` returns all-zero vectors (`embedding.ts:62-66`); the vector path is gated on `isLearnedEmbeddingProvider` (`repo.ts:494`). For the *nl-concept* class codesift is supposed to win, it is effectively a second BM25 engine + a hardcoded 10-group synonym list — "the engine the agent already has via rg." A shippable local learned arm is deferred to M6 and **does not exist**.
2. **The eval flatters us.** It counts rg's `NN|` prefixes but **not** codesift's (the headline "fewer tokens than rg" is tilted in our favor); it hardcodes `callsToResolution=1` on the `find_symbol` path that *actually forces a second call*; and it has **zero coverage** of the two flagship levers (`with_usages`, reranker).

**Sequencing thesis:** (a) extend the proven one-call body machinery to the precise-identifier path, (b) make the index self-fresh, (c) make the eval honest — **before** betting on any semantic buildout.

---

## The biggest single finding

> MCP instructions route **every** exact-identifier/definition query to `find_symbol`, but `find_symbol` returns body-less `#N kind name file:range` lines — forcing a mandatory second `read_chunk` on the one query class rg is *worst* at. The one-call body-inline machinery built for `search_code` was never wired into `find_symbol`.

It is **almost entirely wiring of already-shipped, verified code** (`capInlineBody` / `readRange` / `formatBodyBlock`). Highest impact, lowest risk.

---

## Prioritized roadmap

| # | Move | Axes | Impact / Effort | First step |
|---|------|------|-----------------|------------|
| **1** | **Inline paste-ready body in `find_symbol`** (top match only, when ≤3 exact rows; opt-in usages) | calls·tokens·accuracy | **High / M** | Add `withBody` (default true) to `FindSymbolOptions` (`types.ts`); in `SqliteRepo.findSymbol` (`repo.ts:628`) read body via `readRange`+`capInlineBody` for the top match when `exactRows.length<=3`; render via `formatBodyBlock` in `formatMcpSymbols`. **Couple:** fix the eval's hardcoded `callsToResolution=1` (`eval/src/index.ts:734`) with a body-overlap assertion. |
| **2** | **Connect `Repo.watch()` to the daemon** (warm + auto-fresh index) | calls·accuracy·freshness | **High / M** | In `daemon.ts getRepo`, after `openRepo` fire-and-forget `repo.watch({debounceMs})` (**do not await** — it scans the manifest), store the `StopWatching` handle, call it on idle eviction. Keep `markStaleHits` as backstop. |
| **3** | **Honest token count** — render both codesift & rg through the real MCP formatters | tokens·honesty | **Med / S** | Route eval arms through `formatMcpSearchHits/Symbols/Grep` (export `formatMcpSymbols`); count all four arms (incl. rg) with one `ceil(len/4)` estimator over the exact rendered string. |
| **4** | **Progressive FTS relaxation** (AND → drop-rarest → OR backstop) | accuracy·calls | **High / M** | `buildFtsQuery` returns an ordered ladder; `search()` tries tiers until one yields ≥~3 rows: (1) full AND, (2) drop single rarest term-group by cheap IDF over `chunks_fts`, (3) full OR labeled `reason='relaxed-match'`. Ship drop-rarest first; gate full-OR behind the precision axis. |
| **5** | **A/B-measure `with_usages` + reranker lift** | honesty·calls·accuracy | **Med / M** | Add `expectedUsages` goldens + Δcalls-to-resolution + usageRecall; gate a Voyage rerank A/B behind `CODESIFT_EVAL_RERANK=1`+`VOYAGE_API_KEY`, **excluded from offline CI**; report `mrrAt1Delta`. Report-only, not gates. |
| **6** | **Query-aware ranking** (name/sig term-coverage, comment-only penalty, meaningful tiebreak) | accuracy | **Med / M** | Add a mild ~1.1–1.3× term-coverage multiplier over symbol/parent/signature FTS columns (load `signature` into `ChunkRow`'s SELECT); replace the lexicographic `stableChunkSortKey` tiebreak with term-coverage → `kind=function/method`. Gate the comment-only penalty behind the precision guard. |
| **7** | **Confidence-gate `single_best`** (collapse to k=1 only when rank-1 decisively beats rank-2) | accuracy·calls | **Med / M** | **Build an ambiguous-identifier-collision fixture first** (all 23 goldens are single-target today). Then in `search()`: collapse only on a single exact-symbol match, else cap k at 2–3 with an "ambiguous: N defs" hint. Defer the numeric RRF margin until the fixture can tune it. |

### Quick wins (S, anytime)

- **Dedent inlined bodies** in `capInlineBody`: strip the minimum common leading-whitespace prefix across non-blank kept lines (never per-line), recompute tokens post-dedent. ~30–100 tok/body.
- **Collapse 2+ blank lines to one** in `capInlineBody` before the cap (never reorder/drop code).
- **Fold `numLines * PREFIX_TOKEN_COST` into `capInlineBody`/`estimateSearchHitTokens`** so the budget reflects the `NN| ` prefixes the MCP layer actually emits.
- **Relabel eval `"cold"` → `"cold (prebuilt-index, MCP-spawn only)"`** so the report stops implying it measures first-run indexing.

---

## What NOT to do (killed by the adversarial verifiers)

- **❌ Promote `local-hash-v1` to a default vector arm via IDF feature hashing.** Its token/stem/synonym features near-duplicate the OR-expansion `buildFtsQuery` already does (`repo.ts:3007`); the only novel signal (trigram overlap) is "NOT learned semantics" by its own admission — and it costs an L-effort `model_version` bump forcing **every index to rebuild** (freshness tax) to ship a second BM25 by another name. *If anyone insists: zero-default eval A/B first; if MRR@1 doesn't move, drop.*
- **❌ Auto-bundle usages by default.** `findImportResolvedUsages` → `selectUsageCandidateFiles` (`repo.ts:2265`) AST-parses the **entire language family**, short-circuiting only at 5 hits (`repo.ts:2300-2313`). A definition with few usages would parse the whole repo on a **default** path — directly threatens never-slower-than-rg. Keep opt-in until it has a hard candidate-file/time budget.
- **❌ Flip embeddings on for every query / ship a runtime-downloaded or native-ONNX model** — breaks zero-egress, cold-start, and the offline CI gate. The local learned arm stays an M6 research bet.
- **❌ Replace RRF with weighted score fusion** — BM25 is unbounded, cosine is [0,1].
- **❌ Path-dedup of repeated file headers as a standalone item** — low value, churns `mcp.test.ts` + instructions; only ride it behind the honest-counting fix.

---

## Parallelization

The recall/ranking bets (#4, #6, #7) can silently trade accuracy for recall/brevity, and **the eval can't currently catch it** (no precision axis, no multi-target recall, no ambiguous-identifier fixture). So measurement scaffolding gates Wave 2.

### Dependency graph

```
WAVE 1 (start in parallel, day 1)
  Track A — one-call moat:   #1 find_symbol body-inline  ── couples with the eval body-overlap fix
  Track B — freshness:       #2 daemon ↔ Repo.watch()    ── fully independent
  Track C — honest baseline: #3 token-count honesty + the 4 quick wins  ── independent

         (Track C must land the precision axis + multi-target metric before Wave 2 bets are trusted)

WAVE 2 (after the precision/measurement scaffolding from Track C)
  Measurement:  precision/false-positive axis, #5 A/B arms (with_usages + reranker), multi-target recall, paraphrase goldens
  Recall/rank bets (need the precision axis to catch regressions):
                #4 progressive relaxation  →  #6 query-aware ranking  →  #7 single_best gate
```

### File-conflict hotspot

`packages/core/src/repo.ts` is touched by **#4 (`buildFtsQuery`), #6 (`fuseRankedRows`/sort), #7 (`search`)** — overlapping in the *same* search path, so they should land **sequentially in the #4→#6→#7 order** (one owner / one branch), not concurrently. `#1` touches `findSymbol` (disjoint, safe to parallelize). pi's tracks (`daemon.ts`, `eval/src/index.ts`, `capInlineBody`) are disjoint from the search hotspot.

---

## Delegation: Claude (creative) vs pi (mechanical)

Split principle: **Claude owns novel algorithms, scoring/measurement semantics, and any change to ranking behavior; pi owns deterministic wiring, plumbing, fixtures, and mechanical refactors under a written spec.** Hand pi a spec with exact file:line targets, the acceptance test, and "do not touch ranking logic."

| Task | Owner | Why this split |
|------|-------|----------------|
| **#1 design** — inline policy (top-match-only, `≤3` rows, fallback) + the eval body-overlap assertion semantics | **Claude** | Judgment: *when* to inline and *how to prove* the saved call honestly |
| **#1 wiring** — `withBody` in `FindSymbolOptions`, `readRange`+`capInlineBody` call, `formatBodyBlock` in `formatMcpSymbols` | **pi** | Mechanical reuse of shipped machinery once the policy is fixed |
| **#2 daemon ↔ `Repo.watch()`** | **pi** | Deterministic wiring (fire-and-forget watch, store stop handle, evict) — full spec above |
| **#3 honest token count** | **pi** | Route through existing formatters; consistent counting; no design choices |
| **#4 progressive FTS relaxation** | **Claude** | Novel algorithm: tier ladder, IDF-rarest selection, precision gating |
| **#5 metric design** — what to measure, how to keep it honest, CI exclusion | **Claude** | Measurement semantics |
| **#5 harness plumbing + goldens** — `expectedUsages` field, A/B arms, report fields, env gating | **pi** | Scaffolding under the metric spec |
| **#6 query-aware ranking** — scoring signal + tuning | **Claude** | Taste/judgment; changes rank-1 behavior |
| **#7 predicate design** — ambiguity/confidence gate logic + margin | **Claude** | Confidence logic; changes recall behavior |
| **#7 ambiguous-identifier fixture** | **pi** | Mechanical fixture authoring (Claude specifies the collision cases) |
| **precision/false-positive axis + multi-target recall** — design | **Claude** | Measurement design |
| **precision axis + paraphrase goldens — plumbing** | **pi** | Plumbing once designed |
| **Quick wins** (dedent, blank-collapse, prefix-cost, relabel) | **pi** | Pure mechanical, each a few lines |

**Net:** Claude carries #4, #6, #7, and the design half of #1/#5/precision-axis. pi carries #2, #3, all quick wins, the wiring half of #1/#5, and fixtures. Wave 1 can run Claude (#1 design) ∥ pi (#2, #3, quick wins) concurrently.

### How to hand a task to pi

Use the `pi-delegate` skill, one task per delegation, each with: target files + line anchors, the exact change, the acceptance test (`pnpm test` / a specific vitest), and the guardrail *"do not modify ranking, fusion, or query-construction logic."* Good first delegations (independent, fully specified): **#2 daemon watch**, **#3 token honesty**, and the **four quick wins**.

---

## Measurement gaps (must close to trust the roadmap)

1. **find_symbol one-call sufficiency** — eval hardcodes `callsToResolution=1` with no body-overlap check; the second `read_chunk` it forces today is invisible. *(#1 is dishonest to ship without this.)*
2. **`with_usages` saved-call value** — 0 goldens exercise it.
3. **Reranker MRR@1 lift** — harness never sets `rerank`.
4. **Token comparison bias** — codesift counted prefix-blind, rg counted with prefixes *(#3)*.
5. **No multi-target / set-recall metric** — all goldens single-target; `firstMatchingRank` stops at first match, so "where is auth enforced"-style set answers and dropped co-relevant hits are unmeasurable.
6. **No ambiguous-identifier-collision fixture** — `single_best` collapse correctness untunable *(blocks #7)*.
7. **No precision / false-positive axis** — a *wrong* rank-1 body under rg's token total passes clean *(guardrail for #4, #6)*.
8. **"Never slower than rg on cold start" (first-run indexing)** — not measured; `sync(rebuild)` runs outside the timing loop.
9. **No paraphrase-robustness coverage** — one canonical phrasing + tight `pathGlob` per concept hides the synonym gap and the dead vector arm.
10. **No real agent-loop simulation** — routing is a hardcoded `queryType→tool` switch; single-call steering & miss-recovery are asserted, not tested.

---

## Open questions

1. Is the concept-word recall gap actually the dominant nl-concept miss on a realistic multi-file repo, or does progressive relaxation (#4) close most of it cheaply — deciding whether the L-effort synonym/IDF buildout is ever justified?
2. Would a gated cloud `voyage-code-3` eval arm show a large enough MRR@1 delta over `lexical-v1` to justify the M6 local-learned-arm bet, or is RRF + relaxation + query-aware ranking close enough that the semantic arm isn't worth the freshness/cold-start risk?
3. Real FSWatcher handle/CPU cost of daemon-resident watching across many cached repos in a long session — does incremental sync ever block a concurrent query (the never-slower gate for #2)?
4. For `find_symbol` withUsages, is the O(files) AST-parse cost acceptable even gated to a single exact match on a large repo, or does it need a hard candidate-file/time budget?
5. Should the def+usages+neighbors one-call answer live in `find_symbol`, in `search_code`, or a unified tool — the current routing split itself can force a second call.
