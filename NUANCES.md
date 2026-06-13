# codesift — Unexplored nuances: making it *undeniably* beat grep

> Audit date: 2026-06-13. Produced by a multi-lens audit (8 expert lenses → adversarial
> verification → completeness critic; 62 verified findings) against `PLAN.md`,
> `IMPLEMENTATION_DRIFTS.md`, and the actual source in `packages/*/src`.
>
> Companion docs: **`M0_ADDENDUM.md`** and **`M1_ADDENDUM.md`** hold the concrete scope
> deltas for the milestones currently being implemented (kept separate to avoid colliding
> with the parallel implementation agent). The forward-looking plan changes are folded into
> **`PLAN.md` §12**.

---

## 0. The one thing this document is about

The PLAN positions codesift as *"a complement to grep, not a competitor"* (§3). **That framing
is the ceiling on this product.** A complement is optional; an agent reaches for it sometimes.
The goal you stated is the opposite: codesift should be **undeniably better than grep** on
latency, tokens, and recall — *the only tool an agent ever reaches for.*

The moment an agent has to **choose** between codesift and grep, codesift has already lost,
because the agent's built-in `Grep`/`Glob` tool is always present, zero-config, and ~10–50 ms
cold. So the real product thesis is **subsumption, not complement**:

> codesift must do **everything grep does, at least as well**, *plus* semantic — behind one
> tool surface — so there is never a reason to keep grep wired in.

Almost every unexplored nuance below falls out of taking that sentence literally. The current
build cannot win this fight yet: it has **no literal/exact-string mode at all**, its
"semantic" layer is a **fake hash heuristic**, its MCP server **cannot speak MCP**, and the
metric that would *prove* superiority (tokens-to-resolution vs grep) **is measured nowhere.**

---

## 1. What "undeniable" means, as a contract

"Undeniable" is a measurable claim or it is marketing. Define it as a per-axis contract codesift
must satisfy on a pinned benchmark, head-to-head against ripgrep:

| Axis | The contract codesift must meet | Today |
|---|---|---|
| **Recall (exact)** | If a string/identifier exists, codesift returns it. `recall@k = 1.0` on the exact-identifier + string-literal golden sets. **Any miss is a release blocker.** | ✗ no literal mode; vector top-k silently drops exact matches |
| **Recall (concept)** | NL→code recall@5 ≥ a real-embedding baseline; ≥ grep on conceptual queries (grep's floor here is ~0). | ✗ fake embedder; loses to a real model |
| **Tokens** | Median *tokens-to-resolution* ≤ ½ of ripgrep-only on the agent-task set. | ✗ not measured; default output is pretty-printed verbose-key JSON |
| **Latency (common case)** | Exact/identifier queries answer in single-digit ms — never load a model. Cold-first-query competitive with `rg` cold. | ✗ every query embeds first; per-spawn cold-start unbounded |
| **Latency (concept)** | Warm p50 < 150 ms; cold-first-query a *published, separately-measured* number. | ✗ "300 ms warm" measures a state that never exists under stdio |
| **Trust** | Never confidently wrong: stale/branch-drift flagged; deterministic results; no secret leakage. | ✗ `stale` hardcoded `false`; non-deterministic ids |

If codesift hits all six on a public, pinned, head-to-head benchmark, the claim is undeniable.
None are met today. The rest of this doc is how to meet them.

---

## 2. The eight levers that decide it (ranked)

These are the bets that most directly convert "complement" into "undeniable." Detail for each
is in the themed sections below.

1. **Make the MCP server actually speak MCP, and make its tool descriptions *route*, not
   describe.** Today `start()` is a no-op and it prints a human sentence to stdout — the
   JSON-RPC stream is corrupt and the process dies on spawn, so the agent uses grep 100% of
   the time. This is the gate before any other lever matters. *(§3-A, §7)*
2. **Add a first-class literal/regex/exact primitive (`repo.grep`) over raw file bytes** —
   exposed as CLI `codesift grep` and MCP `grep_code`. Without it the agent must keep grep, and
   once grep is open it gets used for everything. Subsumption is impossible without this. *(§3-B)*
3. **Guarantee exact-identifier recall = 1.0** by UNION-ing symbol-table + FTS-exact candidates
   into the fusion pool *independent of* the vector top-k, and pushing path filters into SQL
   *before* truncation. grep's contract is "if it exists, you see it"; codesift must match it on
   its highest-frequency query class. *(§3-C)*
4. **Implement `read_chunk` for real**, with content/location-addressed **stable ids** and a
   query-centered, token-bounded snippet. The entire token thesis ("short hits + ids, expand
   only what's needed") is non-functional today: `read_chunk` is placeholder text, the SDK has
   no read primitive, ids are unstable rowids, and snippets are a fixed first-8-lines slice. *(§4)*
5. **Build a tokens-to-resolution (TTR) + cold-latency eval, head-to-head vs ripgrep**, with a
   deterministic agent policy so it runs in CI. This is the single number that proves the
   thesis — and it gates every retrieval change. It must land *with* M2, not be deferred to M6. *(§6)*
6. **Resolve the cold-start tension: a zero-model lexical/exact fast-path + a persistent
   per-machine daemon**, with *cold-first-query* as the headline latency metric. Agents spawn
   `npx codesift mcp` per repo — there is no resident model, so "300 ms warm" measures a state
   that never occurs. *(§3-D)*
7. **Stop calling the fake `local-hash-v1` "semantic"/"hybrid."** Shipping a bag-of-hashed-tokens
   heuristic advertised as semantic is a trust bomb that loses on all three axes and poisons the
   eval (its synonym table self-games recall). Honest default = lexical+BM25+symbol; gate the
   word "semantic" behind a real learned provider. *(§5)*
8. **Win exact-identifier queries token-minimally**: self-route `search_code` so an
   identifier-shaped query returns *one authoritative definition + a terse id list* at zero
   embedding cost — pure upside on all three axes, using machinery that already half-exists. *(§4)*

---

## 3. Theme A — Subsume grep (positioning + the missing primitives)

### A. The positioning inversion (supersedes PLAN §3)
- **Nuance.** PLAN §3 says "we treat [ripgrep] as a complement, not a competitor." Under the
  "undeniable / only tool" goal this is the wrong north star. Reframe to **subsumption**:
  codesift is a strict superset of grep's capability surface.
- **Why it matters.** A complement is opt-in; the agent's built-in grep is always-on and
  zero-config. Optional loses to default.
- **Fix.** Adopt the §1 contract. State explicitly in the plan and in MCP server `instructions`
  that codesift replaces grep for *all* code search, including literal/regex.

### B. No literal/regex/exact-string mode at all *(CRITICAL, M2)*
- **Gap.** The only paths are vector `search()` and `findSymbol()` over the symbols table. There
  is **no** way to "find this exact byte sequence anywhere in the repo" — grep's core contract.
  FTS5 (when it lands) is porter-stemmed + camelCase-split, so it *cannot* match `HR_API_BASE`,
  operators, error strings, or regex.
- **Fix.** `repo.grep(pattern, { regex?, ignoreCase?, wholeWord?, multiline?, lang?, pathGlob?,
  contextLines? })` backed by FTS5 fast-path **and** a raw streaming scan/regex over file bytes
  for true byte-exact/regex. Expose as CLI `codesift grep` / `-e` and MCP `grep_code`. This is
  the load-bearing addition that makes subsumption *literally true*.

### C. Exact-identifier recall is not guaranteed *(CRITICAL, M2)*
- **Gap.** `search()` keeps only the top `limit` (`k*10`/`k*25`) rows by cosine distance, so an
  exact match at cosine rank 300 is **silently dropped**. The symbols table is never UNION-ed
  into `search()`. Path globs are filtered in **JS after** top-k truncation (`repo.ts:241`), so
  `k` collapses and matches vanish.
- **Fix.** Always UNION an exact-match candidate set (FTS exact-token + symbol exact-name) into
  the fusion pool **independent of** the vector top-k, then RRF. Move `lang`/`path`/`kind` into
  SQL predicates so truncation happens *after* filtering. Eval asserts `recall@k = 1.0` on the
  exact-identifier set; any miss blocks release.

### D. References/usage parity (reframe the PLAN §2 non-goal) *(CRITICAL, M2)*
- **Gap.** PLAN §2 scopes out references/call-graphs. But the #1 reason an agent greps an
  identifier is to find every **call site**, not the single definition.
- **Fix.** Don't build a semantic call graph — but **guarantee token-exact occurrence recall**
  via the literal primitive. Optionally add a lexical "references" mode so `find_symbol(x)`
  returns def-first, usages-after. Sell it as *"definition + every usage in one call, fewer
  tokens than `rg | head`."*

### E. Query-intent routing does not exist *(CRITICAL, M2)*
- **Gap.** Every query goes through `provider.embedBatch` + cosine regardless of shape, so a
  bare `getUserById` is fed to the (fake) embedder and is guaranteed to lose to grep. PLAN
  mentions symbol *boost* as a scoring tweak — never as a *routing* decision — and even the
  tweak is unimplemented.
- **Fix.** A core intent classifier on the raw query string: (a) quoted/`/regex/` → literal
  path; (b) single identifier token (camel/snake/dotted, no spaces) → symbol-exact + lexical
  first, semantic as tie-breaker, **skip embedding**; (c) multi-word NL → hybrid RRF. Surface
  the chosen route in result metadata (for the agent and the eval). `extractSymbolCandidates()`
  already detects identifier shapes — reuse it as the gate.

### F. Grep flag-parity surface *(HIGH, M5)*
- **Gap.** Agents drive `rg` with a known vocabulary (`-i -w -t/-T --glob -A/-B/-C -l -c`).
  codesift exposes only `--lang --path -k --json`.
- **Fix.** Plumb `ignoreCase / wholeWord / regex / multiline / include+exclude globs /
  contextLines / filesWithMatches / count` through SDK→CLI→MCP, mapping CLI flags to rg's exact
  spelling so an agent's rg habits transfer verbatim.

### G. Stored chunks aren't coverage-complete *(HIGH, M2)*
- **Gap.** Chunks are built only from extracted definitions + fallback windows. Content between
  definitions may be in **no chunk** — so an index-only literal search would **miss** matches
  grep finds by reading raw bytes.
- **Fix.** For literal/regex parity, don't rely on definition chunks: either a coverage-complete
  lexical layer (FTS over full file text / per-file line index) decoupled from the semantic chunk
  layer, or implement grep mode as a real streaming file scan. **Invariant test:** for a random
  sample of literals, `codesift grep` ⊇ `rg` on the same repo.

---

## 4. Theme B — Token economics (the strongest possible win, currently un-built)

Tokens-spent-to-resolve-a-task is codesift's biggest structural advantage over grep (grep dumps
whole match sets; codesift can return one ranked, bounded, dedup'd answer). It is also the most
*neglected* — there is no measurement and the expand-on-demand loop is broken.

- **The two-step loop is architecturally impossible today** *(CRITICAL, M2)*. `read_chunk`
  returns `"Scaffold only..."`, core exposes no `readChunk(id)`, and snippets are a fixed
  first-8-lines slice that may not even contain the matched line. → Add
  `repo.readChunk(id, {contextLines})` + `repo.readRange(file,start,end,{contextLines})`
  reading from disk; center the default snippet on the best-matching line, cap by **tokens** not
  lines.
- **Stable ids are a prerequisite** *(CRITICAL, M1→M2)*. `SearchHit.id` is the autoincrement
  rowid; `sync()` does delete-all + reinsert, so ids are reassigned on every reindex — an
  agent-cached id silently mis-resolves after any background rebuild. → content/location-addressed
  ids: `relpath:start-end@contentHash`. (Settle in M1; see `M1_ADDENDUM.md`.)
- **Terse wire format** *(HIGH, M2)*. The only machine output is `JSON.stringify(hits, null, 2)`
  — verbose English keys repeated per hit + 2-space indent: the most token-expensive
  serialization possible. → one canonical terse line format shared by `--compact` and MCP:
  `<id> <path>:L<start>-<end> <symbol|->` + snippet. Make compact the MCP **default**. Assert
  ≥40% smaller in eval.
- **Dedup overlapping chunks** *(HIGH, M2)*. Chunking emits a class chunk *and* a chunk per method
  inside it; retrieval returns both, so one class eats several `k` slots with overlapping text. →
  post-ranking merge: if a higher-ranked hit's range contains a lower one, drop/merge and backfill
  the freed slot; track which child matched so `read_chunk` can still expand precisely.
- **Token-budget, not just `k`** *(HIGH, M2)*. MCP defaults `k=8`, SDK defaults `k=10` (inconsistent),
  both fixed counts — eight 200-line chunks blow the budget exactly like grep. → unify default in
  core; add `maxTokens` to `SearchOptions`; return highest-ranked distinct hits whose cumulative
  snippet tokens fit; report `tokensReturned` so the agent sees its spend. (Resolves OQ#4 → budget-first.)
- **Single-best-answer (lookup) mode** *(HIGH, M2)*. For "definition of X" the token-minimal answer
  is *one* definition, not a `k`-list. → self-route identifier-exact queries to a `definition`
  result (one full snippet + terse id list of other matches) at zero embed cost.
- **Token-bounded snippets** *(MEDIUM, M2)*. `buildSnippet` caps at 8 lines with no column/token
  ceiling; one 400-char minified/JSX line makes a "short" hit as costly as reading a file. → hard
  per-line char ceiling (ellipsis-truncate) + total-snippet token cap; a shared `chars/4` token
  estimator feeds both snippets and the budget.
- **Drop the raw score from the payload** *(MEDIUM, M2)*. Each hit serializes a float `score`
  (an artifact of the fake embedder); an agent can't calibrate absolute scores across queries. →
  omit by default (rank is implicit in order); optionally a 1-token match-reason tag (`=` exact-symbol,
  `~` semantic, `+` both) that tells the agent whether to trust the hit without grep fallback.

---

## 5. Theme C — Embedding quality & the trust bomb

- **`local-hash-v1` advertised as "semantic" is a trust-destroying lie** *(CRITICAL, M1)*. It is a
  bag-of-hashed-tokens model — strictly worse than ripgrep on exact identifiers *and* worse than a
  real model on concepts: it loses on **all three** axes at once. MCP already advertises
  *"Hybrid lexical + semantic"* (`mcp/index.ts:67`). → **Hard release gate:** the default provider
  id is **never** `local-hash-v1` in any published artifact. Until a real ONNX model lands, the
  honest default is **lexical-only** and the tool calls itself "lexical search." Gate the word
  "semantic" behind an actual learned provider. *A fake semantic signal is worse than none.*
- **No content-hash embedding cache** *(CRITICAL, M2)*. `sync()` re-embeds **100%** of chunks every
  run; the sha256 per file (`scan.ts:110`) is thrown away. The "incremental < 5 s" target is
  impossible the moment embedding is real ~10–50 ms/chunk inference. → `embeddings(text_hash PK, vec
  BLOB)` keyed by `hash(embeddingText + providerId + modelVersion)`; only embed cache-misses.
  Survives renames (same code → same text → cache hit, contradicting PLAN's delete+add stance) and
  full `--rebuild`s. **Single biggest lever for incremental latency and cloud cost.**
- **Query vs document embedded identically** *(HIGH, M1)*. `search()` embeds the raw query through
  the *document* path, but asymmetric code models (jina-v2-code, voyage-code) require distinct
  query/passage prompts — silently degrading recall. → role-aware interface:
  `embedBatch(texts, { role: 'query' | 'document' })`; local ONNX applies per-role prompts, cloud
  maps to `input_type`. Bake into the M1 interface so providers *and* the cache key are role-aware.
- **Dims baked into the schema with no migration guard** *(HIGH, M1)*. The `vec_length` CHECK is
  hardcoded from the default provider's dims at open (`repo.ts:417`); `provider_id/dims` are written
  to `meta` but **never read**. Swapping 384d→768d silently fails the CHECK mid-insert or mixes
  incompatible vectors. → on open, compare `meta.provider_id/dims` (+ `model_version`) to the active
  provider; on mismatch refuse with the guided `--rebuild` PLAN already promises.
- **Reranker interface doesn't exist** *(HIGH, M2)*. PLAN §5.5 claims "a Reranker interface ships in
  v0.1 (no implementation)" — but `types.ts` has **none**, and §10 calls reranking "the biggest single
  quality jump." Against a weak bi-encoder, the reranker is what makes precision beat grep. → land the
  `Reranker` interface for real in M2, wire an optional rerank stage over top-N fused candidates, ship a
  quantized local cross-encoder as an opt-in `--rerank` flag in M5/M6. Measure recall@5 ± rerank *and*
  the added p50 (reranking is on a collision course with the latency budget — gate it on query type and
  a per-query time budget; skip it entirely for exact-identifier queries the lexical arm already nailed).
- **Batch sizing / throughput unspecified** *(MEDIUM, M1)*. `sync()` passes **all** chunk texts to one
  `embedBatch` (`repo.ts:88`) — fine for a hash, but a real model fed 30–80k texts in one array OOMs or
  blocks the event loop for minutes. → provider-declared `maxBatch`/`maxBatchTokens`; core driver
  batches embed→insert→release, emits per-batch progress, checks `signal.aborted` between batches,
  bounds peak memory to one batch.

---

## 6. Theme D — Proof: the eval *is* the weapon

"Undeniable" lives or dies in the benchmark. The current eval is **types-only** and, even fully built
per PLAN, measures the **wrong axes** (recall@k/MRR — nothing an agent's context window cares about).

- **Measure the three north-star axes, head-to-head vs ripgrep** *(CRITICAL, M6→pull to M2)*. Redefine
  `EvalSummary` as a per-(task, tool) record: `{ tool: codesift|ripgrep|hybrid, tokensToResolution,
  wallClockMs (cold+warm split), taskSuccess, recallAt5, mrr }`. The headline is a **paired delta vs
  ripgrep on the same task**, not an absolute recall number.
- **Golden-set schema must express the queries grep wins** *(CRITICAL, M6)*. `GoldenQuery` carries only
  an NL string + `{file, symbol?}` — it can't encode exact-identifier or regex-literal queries, so the
  benchmark is rigged in codesift's favor. → add `queryType:
  nl-concept|exact-identifier|string-literal|error-trace|symbol-def`, an optional `grepPattern` (the rg
  query a competent agent would write), and `expectedLineRange` (score on line precision). Require the
  set balanced across types with per-type targets (exact-identifier: codesift recall ≥ grep AND fewer tokens).
- **Cold-start is the real benchmark unit** *(CRITICAL, M6)*. The harness must measure stdio
  spawn→first-result, not "warm p50." Instrument phases (spawn, db-open, vec-load, model-load, embed,
  search, format) and publish a histogram. Headline = **cold** latency, since that's what competes with grep.
- **Agent-in-the-loop task harness** *(HIGH, M6)*. recall@k assumes the agent uses top-k perfectly. →
  a headless harness with a **deterministic** policy (greedy top-k + expand-until-target) for reproducible
  CI numbers, plus an optional **LLM-agent** mode for the published "undeniable" numbers. Run the same
  tasks against a ripgrep-only toolset for the paired baseline.
- **Paired-delta CI gates + a `losses.json` scorecard** *(HIGH, M6)*. Absolute thresholds drift; the gate
  that matters is "did not regress vs ripgrep on tokens AND latency AND success." Maintain a checked-in,
  version-controlled `losses.json` of queries where grep still wins (with target milestones); CI passes
  only if that set doesn't grow. Publish it in the README as the honest scorecard.
- **Score-breakdown for attribution** *(HIGH, M6)*. Opaque multiplicative scoring (`1.12 code · 1.08
  symbol · 0.84 docs · 0.82 metadata`) makes losses unattributable. → optional `{bm25Rank, vecRank,
  rrfScore, symbolBoostApplied}` behind an explain flag; per-component ablation runs (vector-only /
  lexical-only / fused / fused+boost) so each win decomposes to the knob that earned it.
- **Guard against the synonym-table self-gaming** *(MEDIUM, M6)*. `local-hash-v1` hardcodes synonym
  groups (auth/login/jwt, validate/verify/check…); golden NL queries written with those words show recall
  that is an *artifact of the map*, not retrieval — and collapses when a real model lands. → author
  queries blind to the synonym table, include paraphrase variants, run the same set across providers
  (hash / real ONNX / Voyage) and treat a large hash-vs-real gap as an overfit signal.

---

## 7. Theme E — Freshness, concurrency & trust (confidently-wrong is worse than grep)

grep is always live; a stale or branch-mismatched index that answers *confidently wrong* is strictly
worse, and it destroys the trust the "only tool" thesis depends on.

- **`status().stale` is structurally impossible to compute** *(CRITICAL, M4)*. PLAN §5.6 promises a
  "cheap mtime scan," but `files` stores only `(path, language, hash, size)` — mtime is computed in
  `scan.ts:87` then **thrown away**. The only way to detect staleness today is to re-hash the whole tree.
  → add `mtime` (+ keep `size`) now (M1 schema; see addendum); stat-only staleness, hash only on
  mismatch. Persist `git_head_sha`, `git_branch`, `git_dirty` in `meta`. Return a **structured reason**
  ("HEAD moved 3 commits, 12 files drifted"), not a bool.
- **Git-branch switches → confidently wrong, zero signal** *(HIGH, M4)*. An index built on branch A and
  queried on B returns A's results until a full resync, with nothing telling the agent which branch it
  reflects. → compare HEAD/branch at query time; set `stale` with reason; optionally key the index
  generation on branch so switching back is a fast no-op.
- **Unstable ids poison `read_chunk` and agent caches** *(CRITICAL, M1→M2)*. (See §4.) Embed an
  index-generation/epoch in returned ids so a read against a stale epoch is *detectable* rather than
  silently mis-resolved.
- **`SCHEMA_VERSION` written but never read** *(HIGH, M4→M1)*. `ensureSchema` only does `create table if
  not exists`; the stored version is never compared on open. When M2 adds `chunks_fts`/`vecs` and M4 adds
  `mtime`, a new binary opening an old DB queries a half-shaped index and returns garbage. → on open, read
  `meta.schema_version`; migrate or refuse with a machine-readable "run `--rebuild`" that `index_status`
  surfaces so the agent self-heals. (The schema already churned v1→v2 with no gate — this is a live bug.)
- **Provider/dims mismatch enforced only by a cryptic CHECK** *(HIGH, M5→M1)*. PLAN §5.3 promises a
  "guided `--rebuild`"; reality is a raw `SQLITE_CONSTRAINT` mid-insert (or, in `search()`, an unguarded
  cross-dim cosine). → the same open-time guard as the dims-migration fix; never run a cross-dim cosine.
- **Concurrency: `SQLITE_BUSY` during a rebuild** *(HIGH, M4)*. `sync()` wraps clear+full-reinsert in one
  transaction holding an exclusive write lock for the whole rebuild; with no `busy_timeout`, a second
  agent's `search()` during that window throws immediately. → set `busy_timeout`; apply changes per-file
  in small transactions; long-term build into a **shadow generation** and atomically swap (the only moment
  ids/epoch change) so readers always see a consistent committed generation.
- **Crash/partial-state is invisible** *(MEDIUM, M4)*. An aborted embed can leave the prior index intact
  but the user believing the reindex "failed" with a cryptic CHECK error and no partial-progress signal.
  → record `last_sync_started_at / completed_at / status` in the finalizing commit; validate
  `embeddings.length === chunkRows.length` before opening the transaction; fail fast with an actionable message.
- **Determinism is unspecified** *(HIGH, M1)*. Nothing guarantees the same query returns the same ordered
  results: RRF ties fall back to `localeCompare` only after fragile float-equality, and rowids change
  across reindex. Agent caching, eval gates, and trust all require determinism (grep is deterministic by
  default). → deterministic final tie-break on a stable key (`file:startLine`/contentHash, never rowid) +
  a reproducibility assertion (same query twice → identical ordered id list).

---

## 8. Theme F — Scope, scale & safety (what you index decides recall, tokens, latency, trust)

- **Secrets indexed verbatim and shipped to cloud embedders** *(CRITICAL, M5)*. No secret detection:
  `config.yaml`, `secrets.json`, `*.tf`, hardcoded keys in source are chunked, stored full-text in
  `index.db`, and (opt-in cloud) sent to Voyage/OpenAI verbatim. → a secret-scan pass (entropy +
  provider-key regexes: AWS/GCP/Slack/JWT/PEM/`*_API_KEY=`); default = redact the span (keep surrounding
  code searchable) + tag `hasSecret`; cloud path hard-refuses without `--allow-secrets`; extend default
  ignores to `.env* *.pem *.key *.tfvars id_rsa*`.
- **`.codesift/index.db` is a full plaintext copy of the source, never gitignored** *(HIGH, M1)*. Every
  chunk stores full `content`, so the index is a second copy of the repo — yet nothing writes `.codesift/`
  to `.gitignore` despite PLAN §4.1 claiming "gitignored by default." → write `.codesift/.gitignore`
  containing `*` on first `sync`. Separately: if `read_chunk` re-reads from disk by file+range (it should),
  **drop the `content` column** entirely — halves index size and removes the source-duplication risk.
- **Symlinks silently dropped** *(HIGH, M1)*. `walk()` uses `isFile()/isDirectory()`, both false for
  symlinks, so symlinked source/dirs are invisible — a real recall hole in monorepos. → detect symlinks,
  follow with a visited-realpath set (cycle-safe), refuse links resolving outside the repo root, surface
  `skippedSymlinks` in `SyncResult` (restores `rg --follow` parity safely).
- **No chunk-size cap / oversized-node splitting** *(HIGH, M3)*. One chunk per top-level node with full
  text — a 600-line class exceeds `maxTokens` (8192), so a real provider truncates it and its vector
  becomes meaningless. → implement the splitting/merging PLAN §5.2 already promises (split at child
  boundaries with overlap, merge tiny siblings to 256–512 tokens, hard-truncate to `maxTokens`); assert a
  chunk-token distribution in eval.
- **Generated/vendored/minified detection is a tiny basename list** *(HIGH, M3)*. `*.pb.go`, `*_pb2.py`,
  `*.generated.ts`, `vendor/`, `third_party/`, `__generated__/`, bundled JS all get fully indexed,
  flooding recall and burning tokens. → broader default-ignore dirs + a content sniff for
  `@generated`/`DO NOT EDIT`/`Code generated by` and minified files (avg line length > ~300) + a
  `generated` flag that **down-ranks** rather than drops; all overridable via `.codesiftignore`.
- **Nested `.gitignore` ignored** *(MEDIUM, M3)*. Only root `.gitignore`/`.codesiftignore` are read; git
  applies ignores at every directory level, so per-package monorepo ignores are violated. → accumulate
  ignores per directory, or adopt git-backed enumeration (`git ls-files --cached --others
  --exclude-standard`) when in a checkout (also fixes symlink/binary edge cases and is faster on large repos).
- **Whole-repo single `embedBatch` is a memory wall, not a "5k-file" policy** *(HIGH, M5)*. The "~5k files"
  cap is really "what fits in a Node heap" — no streaming/backpressure/checkpoint. → stream in bounded
  batches, flush per batch, make the index resumable (precondition for the post-MVP scale backend).
- **Markdown/config indexed then actively de-ranked** *(MEDIUM, M3)*. Docs/config are blind 60-line windows
  *and* penalized `0.84×` (+`0.82×` for README/package.json) unless the query contains a doc keyword — so
  "where is the retry timeout configured" under-recalls. → replace the blanket penalty with intent-aware
  fusion (let RRF decide for neutral NL); heading-aware markdown chunking; key/section-aware config chunking
  (YAML/TOML/JSON top-level keys as first-class searchable units, surfaced via `find_symbol`).
- **Vector search is a full-table O(n) blob scan, not a `vec0` KNN** *(HIGH, M2)*. The embedding is a plain
  blob column scored with `vec_distance_cosine()` in an `ORDER BY` over the whole table — sqlite-vec
  contributes only the distance function, *not* its SIMD `vec0` virtual-table scan. PLAN §5.4's "fine to
  ~1M vectors with SIMD" claim does not hold for this layout. → use a real `vec0` virtual table (PLAN's
  `vecs` table); pin the chunk-count crossover (measure at 50k/100k/250k) where O(n) exceeds budget and make
  ANN (LanceDB/HNSW) a **data-driven** hard requirement above it, not an indefinitely-deferred "design-for-big."

---

## 9. Theme G — Cross-cutting nuances no single lens owned (from the completeness critic)

- **The agent-loop integration boundary is where the war is actually won** *(CRITICAL, M2)*. Every other
  finding optimizes codesift *the tool*; none address the planner's tool-selection layer. Claude
  Code/Cursor ship a built-in `Grep`/`Glob` that is always present and zero-config — even a perfect
  codesift loses every query the planner never routes to it. The MCP server-level `instructions` field +
  per-tool descriptions are the **only** lever to displace grep in the planner's head, and today they're
  bare one-liners with no routing policy, no "use this instead of grep," no stated latency/token edge.
  Ship a tuned, eval-gated `instructions` block **and** a documented recipe for how a user de-prioritizes
  or disables the built-in grep so codesift can subsume it.
- **Multi-repo / workspace agents** *(HIGH, M2)*. Real sessions span multiple repos (monorepo packages, a
  service + shared libs, vendored siblings). The model is rigidly per-repo: `.codesift/index.db` per root,
  `npx codesift mcp` per repo, no cross-repo query, and each spawned process independently loads the model
  + native ext — compounding cold-start *multiplicatively* with repo count. → the daemon should own
  multiple indexes addressed by repo root, share one resident model, and offer an optional cross-repo/
  workspace query.
- **Cross-platform native-dep failure is a silent abandonment path** *(HIGH, M0)*. `better-sqlite3` +
  `sqlite-vec` are loaded unconditionally in `openDatabase` (`repo.ts:443-446`). If a prebuilt binary is
  missing for the user's exact Node ABI/platform/libc (Node 22 on Alpine/musl, Windows-ARM, a fresh Node
  minor), npm silently falls back to a node-gyp **source** build needing a C toolchain — which fails on a
  fresh agent machine, and the agent sees an MCP server that won't even start. And `sqlite-vec` is loaded
  even for a pure lexical query that doesn't need it. → **lazy-load `sqlite-vec`** only on the first vector
  query so the lexical/symbol/literal path survives a missing prebuild; expand the CI matrix
  (musl/Alpine, Win-ARM) + a clean-image `npx` install smoke test asserting no source compile.
- **Cloud-embedding cost/rate-limits/failure entirely unmodeled** *(MEDIUM, M5)*. The opt-in cloud path
  has no per-query/per-index cost estimate, no rate-limit/backoff, no batch ceiling, no offline fallback;
  combined with the un-batched whole-repo `embedBatch`, a 5k-file repo means one giant API call + an
  uncapped bill, and every `search()` is a network round-trip with no cache. → cost estimate before a cloud
  index, batching + backoff, query-vector cache, offline fallback to lexical.
- **Offline/airgapped is asserted but not enforced** *(MEDIUM, M1)*. PLAN goal 4 promises "works offline,"
  but the real model is a ~65MB HuggingFace download on first run; on an airgapped/CI machine the first
  semantic query blocks forever, with no env var to point at a local model file and no bundled artifact.
  The lexical path needs no model — but nothing *tells* the user/agent that semantic is degraded-but-
  functional offline vs broken. → document + enforce: lexical works offline always; `CODESIFT_MODEL_PATH`
  for pre-seeded models; `index_status` reports model availability.
- **Telemetry / egress posture asserted but unverified** *(MEDIUM, M0)*. codesift runs as an MCP server
  with read access to the user's entire source tree — a high-trust position — yet PLAN OQ#5 ("telemetry:
  none") is unresolved and nothing verifies no dependency phones home. → resolve OQ#5 to **none**; add a
  network-egress CI test (index+search with network blocked, assert zero outbound sockets) to the green bar.
- **Human CLI has no grep-drop-in contract** *(MEDIUM, M5)*. No `codesift <query>` zero-subcommand fast
  path, no grep-compatible **exit codes** (0=match / 1=no-match / 2=error) that `if codesift ...; then`
  relies on, no `-l`/`-c` modes. An agent that drives tools via Bash (extremely common) treats codesift as
  a grep replacement only if it behaves like one in a pipe. → add the zero-subcommand fast path, exit-code
  contract, and `-l`/`-c`.

---

## 10. Where each change lands

| Milestone | What moves, and why |
|---|---|
| **M0** (scaffold) | Architectural *seams* that are expensive to retrofit: lazy-load `sqlite-vec`; self-gitignore the index; CI native-dep matrix + clean-install smoke test; network-egress/offline test; pin Node/platform/libc; resolve telemetry→none. **→ `M0_ADDENDUM.md`.** |
| **M1** (walking skeleton) | Interface & data-shape decisions everything downstream is built on: stable content-addressed chunk ids; `readChunk`/`readRange` in the SDK; role-aware embedding interface; provider/dims/schema-version guard; `mtime` in the manifest; batched embed orchestration + `maxBatch`; **never ship the fake embedder as "semantic"** (honest lexical default); deterministic results; symlink handling. **→ `M1_ADDENDUM.md`.** |
| **M2** (the make-or-break milestone) | The subsumption surface: real MCP transport + routing `instructions`; literal/regex `grep_code`; exact-identifier recall floor = 1.0 (UNION + SQL filters); query-intent routing; working `read_chunk` + token-budget + dedup + terse format + single-answer mode; `vec0` virtual table; query-embedding cache; daemon decision + zero-model fast-path; **TTR/cold-latency eval pulled in** to gate it all. |
| **M3** | Chunker hardening: oversized splitting, generated/vendored detection, nested gitignore / git-backed scan, heading-aware doc/config chunking. |
| **M4** | Freshness done right: real `stale` (mtime+git HEAD), incremental + embedding cache, busy_timeout + shadow-swap, crash/partial signaling. |
| **M5** | Cloud providers with cost/rate-limit/secret-redaction; grep flag-parity; human CLI grep-drop-in contract; SDK freeze. |
| **M6** | Quality + the public head-to-head scorecard (`losses.json`), ablations, reranker, anti-self-gaming golden sets — the published "undeniable" numbers. |
| **post-MVP** | ANN scale backend (data-driven threshold from M2), team server, more query types, ecosystem. |

---

## 11. The pitch, once this is true

> *codesift is the one search tool an agent needs. Ask for an exact string, an identifier, a
> regex, or a concept — it answers in one call, in fewer tokens than grep, never slower than
> grep on grep's own queries, and it tells you when it might be stale. We measured it
> head-to-head against ripgrep on a pinned benchmark and published where we still lose. There's
> no longer a reason to keep grep wired in.*

Everything above is the gap between that sentence and today. The order is set by §2.
