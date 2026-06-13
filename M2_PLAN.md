# M2 Plan — the make-or-break milestone (subsumption + proof)

> **For the parallel implementation agent.** M0 (`M0_ADDENDUM.md`) and M1 (`M1_ADDENDUM.md`) are
> landed in commits `bc9ed15` and `5bbdbf5`. This file sequences M2. Strategic context:
> `NUANCES.md` (the "undeniable" contract §1–2, the 8 levers §2). Kept separate from `PLAN.md` to
> avoid edit collisions.
>
> **Why M2 is make-or-break:** after M1, codesift is a competent *local hybrid retriever* — but no
> agent can reach it (the MCP server is a no-op scaffold), it still can't do grep's core job
> (literal/regex), it can't *guarantee* it beats grep on exact matches, and nothing *measures*
> whether it wins. M2 closes all four. This is the milestone that converts "complement" into
> "undeniable."

## What M1 already delivered (so M2 doesn't redo it)

Verified in the working tree — M2 builds on, not re-implements, these:
- FTS5 `chunks_fts` + `bm25()` ranking + RRF fusion (`fuseRankedRows`, `repo.ts:826`).
- Symbol-boost in fusion via `isExactSymbolMatch`/`extractSymbolCandidates` (`repo.ts:877,894,913`).
- Query-routing seed: `queryShouldUseVectorSearch` (`repo.ts:988`) + `isLearnedEmbeddingProvider` gate
  → the `lexical-v1` default **never loads a model** (the zero-model fast-path foundation).
- Content-addressed stable ids (`parseChunkId`, `repo.ts:1048`) + `readChunk`/`readRange` from disk.
- Lazy `sqlite-vec` (`ensureVectorExtension`, `repo.ts:565`); compatibility guard; `index_generation`.
- CLI `--compact` (`formatCompactHits`); `DEFAULT_SEARCH_K = 8` unified in core.

---

## The M2 critical path (ordered — each item names its blocker)

### M2-1 — Real MCP stdio transport `[CRITICAL · the gate · blocks everything agent-facing]`
- **Now.** `ScaffoldServerHandle.start()` is a no-op (`mcp/src/index.ts:78`); `@modelcontextprotocol/sdk`
  is in **no** package; `codesift mcp` prints a human line to stdout and the process returns/exits — so
  the JSON-RPC stream is corrupt and Claude Code/Cursor see immediate EOF. **The agent uses grep 100% of
  the time.** Nothing else in M2 reaches an agent until this works.
- **Build.** Add `@modelcontextprotocol/sdk` to `@codesift/mcp`. Implement a real `StdioServerTransport`
  that registers the 4 tools **with input JSON schemas**, routes **all** human/log output to **stderr**
  (stdout is reserved for JSON-RPC framing), and keeps the process alive on the transport. Wire
  `createStdioServer` to return a handle whose `start()` actually serves and `stop()` tears down.
- **Accept.** A CI smoke test spawns `node dist/bin.js mcp`, runs `initialize` → `tools/list` →
  `search_code` and `read_chunk` round-trips over real stdio, and asserts stdout contains **only** valid
  framed JSON-RPC (no stray text). `read_chunk` (already implemented in core) works end-to-end here.

### M2-2 — Routing server `instructions` + opinionated tool descriptions `[CRITICAL · adoption · needs M2-1]`
- **Now.** Descriptions are bare blurbs (`mcp/src/index.ts:93-110`) with no schemas, no routing policy,
  no "use this instead of grep." Even once connected, the planner has no reason to pick codesift over its
  built-in grep. *This is where the war is actually won* (`NUANCES.md` §9).
- **Build.** Author an MCP server-level `instructions` block + per-tool `inputSchema` with examples that
  encode the routing policy explicitly: identifiers → `find_symbol`; literal strings/regex → `grep_code`
  (M2-3); concepts/behaviors → `search_code`. State the token/latency advantage so the planner has a
  reason. Treat this text as a **tuned, eval-gated artifact**, not boilerplate. Ship a short README recipe
  for de-prioritizing the host's built-in grep so codesift can subsume it.
- **Accept.** Descriptions name the query class each tool wins; the eval (M2-5) shows the routing policy
  reflected in tool-selection on the agent-task set.

### M2-3 — Literal/regex/exact primitive: `repo.grep` + `grep_code` + CLI `grep` `[CRITICAL · subsumption]`
- **Now.** No path from any interface to "find this exact byte sequence." FTS5 is porter-stemmed +
  camelCase-split — it cannot match `HR_API_BASE`, operators, error strings, or regex. So the agent must
  keep grep, and once grep is open it gets used for everything. **Subsumption is impossible without this.**
- **Build.** `repo.grep(pattern, { regex?, ignoreCase?, wholeWord?, multiline?, lang?, pathGlob?,
  contextLines? })` on the `Repo` interface. Because stored chunks are **not coverage-complete**
  (`NUANCES.md` §3-G), implement grep as a **streaming scan over the scanned file set** (raw bytes), not
  over chunks — using the index only to prefilter candidate files. Expose CLI `codesift grep` / `-e` and
  MCP `grep_code`. Map CLI flags to ripgrep's spelling (`-i -w -A/-B/-C`) so agent habits transfer.
- **Accept.** Invariant test on a sample repo: for random literals, `codesift grep` result set is a
  **superset-or-equal** of `rg` on the same repo. Byte-exact and regex both covered.

### M2-4 — Guarantee exact-identifier recall = 1.0 `[CRITICAL · the contract]`
- **Now.** `search()` fuses FTS + vector, but (a) the **symbols-table exact matches are not UNION-ed**
  into the candidate pool, and (b) **path-glob filtering is JS `applyPathFilter` applied *after* the SQL
  `limit`** (`repo.ts:316,351`) — so a path-scoped exact match beyond `limit` is silently dropped.
  `buildChunkSearchFilters` puts lang/kind in SQL but **not path**.
- **Build.** Always UNION an exact-match candidate set — FTS exact-token hits **+ symbols-table
  exact-name hits** — into the fusion pool **independent of** the vector/FTS top-k truncation. Push the
  path glob into a SQL predicate (`GLOB`/`LIKE` on a normalized path, or a path-prefix column) so
  truncation happens **after** filtering, not before. Keep `k` stable.
- **Accept.** Eval (M2-5) asserts `recall@k = 1.0` on the exact-identifier + string-literal golden sets,
  **including** path-scoped queries. Any miss is a release blocker.

### M2-5 — TTR + cold-latency eval, head-to-head vs ripgrep `[CRITICAL · the proof · gates M2-3/M2-4/M2-6]`
- **Now.** `packages/eval` is types-only (`summarizeEmptyRun` returns zeros; only recall@5/10/MRR). The
  one number that proves the thesis — tokens-to-resolution vs grep — is measured nowhere. Pulled into M2
  (not deferred to M6) so every retrieval change ships measured.
- **Build.** (a) Extend `GoldenQuery` with `queryType: nl-concept|exact-identifier|string-literal|
  error-trace|symbol-def`, an optional `grepPattern`, and `expectedLineRange`. (b) A headless runner with
  a **deterministic agent policy** (search → if top hit covers target, stop; else `read_chunk`/`grep`
  next) so CI is reproducible without a live LLM. (c) Run each task against **two toolsets** — codesift
  MCP vs ripgrep-only — and record `{ tokensToResolution, wallClockMs (cold+warm split), taskSuccess,
  recallAt5, mrr }`. (d) Headline = **paired delta vs ripgrep**. (e) 3–5 pinned OSS repos at fixed refs.
  Author golden queries **blind to the synonym table** to avoid self-gaming.
- **Accept.** `pnpm --filter @codesift/eval run bench` prints per-query-type TTR + cold/warm latency vs
  ripgrep. A CI gate fails on regression in **tokens OR latency OR success** (not just recall). A
  checked-in `losses.json` records where grep still wins; CI passes only if that set doesn't grow.

### M2-6 — Token levers on the result path `[HIGH · the token win, enforced not asserted]`
- **Now.** `--compact` exists for the CLI, but: MCP default is still verbose; no `maxTokens` budget;
  overlapping class/method chunks aren't deduped; no single-best-answer mode; snippet is still a fixed
  first-N-lines slice (`buildSnippet`), not query-centered.
- **Build.** (a) Make the **terse/compact format the MCP default** (never pretty-printed JSON). (b) Add
  `maxTokens` to `SearchOptions`/`search_code`: return highest-ranked distinct hits whose cumulative
  snippet tokens fit; report `tokensReturned`. (c) Post-ranking **dedup/merge** of overlapping chunks
  (drop a contained lower-ranked hit, backfill the slot; keep which child matched for `read_chunk`).
  (d) **Single-best-answer** mode: identifier-exact query → one definition + a terse id list, at zero
  embed cost. (e) **Query-centered, token-bounded snippet** (center on best-matching line; hard per-line
  char ceiling). (f) Drop raw `score` from the default payload; replace with a 1-token reason tag
  (`=`/`~`/`+`).
- **Accept.** Eval shows compact ≥40% smaller than JSON and a measurable TTR drop from dedup +
  single-answer mode; every hit has a predictable token upper bound.

### M2-7 — Latency-track decisions to *make now*, implement as data dictates `[HIGH · decision, partial build]`
- **`vec0` virtual table.** Vectors still live in a blob column scored by `ORDER BY vec_distance_cosine`
  (`repo.ts:367`) — a full-table O(n) scan, not sqlite-vec's SIMD `vec0` path (`NUANCES.md` §8 last item).
  Move the vector arm to a real `vec0` table when a learned provider lands; pin the chunk-count crossover
  (measure at 50k/100k/250k in the M2-5 harness) above which ANN becomes mandatory.
- **Daemon decision.** Per-spawn stdio = no resident model. The cheap half (zero-model lexical fast-path)
  already exists from M1. Decide in M2 whether the persistent per-machine daemon lands in M2 or slips to
  M4; either way publish **cold-first-query** as the headline latency metric in M2-5 (not "warm p50").
- **Accept.** M2-5 reports cold-vs-warm latency split; a documented decision (with the measured crossover)
  on `vec0`/ANN and on daemon timing is recorded in `PLAN.md` §12.

---

## M2 exit criteria (the demo)

1. `codesift mcp` is a real MCP server; Claude Code/Cursor connect with zero config and see 5 tools
   (`search_code`, `find_symbol`, `grep_code`, `read_chunk`, `index_status`).
2. codesift answers **literal/regex** queries with superset-or-equal recall vs ripgrep.
3. `recall@k = 1.0` on the exact-identifier + string-literal golden sets, including path-scoped.
4. The eval prints a **paired TTR + cold-latency delta vs ripgrep**; CI gates on tokens/latency/success;
   `losses.json` is published.
5. An agent, given the routing `instructions`, prefers codesift over its built-in grep on the task set.

## Parallelization

- M2-1 (transport) and M2-3 (`grep` primitive) are independent — build concurrently.
- M2-4 (recall floor) and M2-6 (token levers) are core-side, independent of transport — build concurrently.
- M2-2 (instructions) depends on M2-1 + M2-3. M2-5 (eval) depends on M2-3/M2-4 landing to measure them,
  but its harness scaffold can be built in parallel from day one.
- **Suggested first move:** M2-1 and M2-3 together — they unblock the demo and the subsumption claim.
