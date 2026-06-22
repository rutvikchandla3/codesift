# codesift north-goal plan (merged & committed)

> **North goal:** give an AI agent the right context with **(1) fewer tool calls,
> (2) less token output, (3) more accurate context**, and **(4) onboarding that
> feels close to zero setup** — "answer in one call, in fewer tokens than grep,
> never slower," with rg's freshness and zero-egress trust intact.

This is the committed prioritization that merges two idea sources:

- `docs/north-goal-ideas.md` — GPT‑5.5's forward idea stack (front-door tool,
  metadata, adaptive output, onboarding, measurement).
- The 8-lens / 17-agent ideation workflow (code-grounded, adversarially verified
  against `main`; 45 ideas survived, 3 cut).

Where the two disagreed, the resolution and its grounding are recorded in
[§ Decisions](#decisions-where-the-two-sources-disagreed). The `file:line`
anchors below were spot-verified against current `main` (post graph-landing:
the `edges` table and `find_callers/refs/importers/who_implements/impact`
ship). Anchors are accurate as of this writing but a few may drift by several
lines as the files evolve — confirm the surrounding code before editing, not
just the line number.

---

## The through-line

The relational graph (`edges` table) is **paid-for but under-exploited**. The
largest goal-A wins are not new machinery — they are *spending the edges we
already persist at index time* to collapse the agent's multi-call investigation
loop, plus closing honesty gaps that silently cost a second call. Onboarding is
a separate, cheaper track that mostly unblocks from one missing helper
(`findRepoRoot()`). The front-door (`ask_code`) is the right long-term shape for
"make the right one call obvious" — but it is gated on a real agent-loop eval,
because codesift's intent routing is currently asserted, not tested.

**The single most-repeated trap:** a ranking signal must be a *capped tiebreak*,
never a primary-score multiplier. `repo.ts:4671` documents a coverage multiplier
that demoted a correct rank‑1 and was reverted. Centrality, edge-proximity, and
orphan signals are all tiebreak-only.

---

## Roadmap

Five tracks. **P0 → P2** are independent and can run in parallel. **P3
(measurement) gates P4 (`ask_code`) and the ranking half of P5.**

### P0 — Trust & honesty fixes (cheap, unblock everything)

These convert silent failures into one-call answers and fix concrete bugs. Most
are S effort, pure formatter/SQL.

- **`not_indexed` sentinel + empty-result recovery hints.** Bare `[]` is
  indistinguishable from a real miss today, which is *why* instructions still
  mandate a defensive `index_status` preflight. Emit `not_indexed; run: codesift
  index` from every formatter when `existsSync(indexPath)` is false; distinguish
  "def found, 0 indexed edges" from "no definition" in `findDefinitionEdges`
  (`repo.ts:1016` vs `:1026`); surface the already-computed `partialRows`
  (`repo.ts:767`) on `find_symbol`'s exact-miss branch. **Prerequisite for
  dropping the preflight (P1).**
- **Name-only blast-radius cap + lead line on `find_callers`/`find_refs`.** These
  run *unlimited* name-only matches on Go/Java/Ruby/Rust
  (`selectDefinitionEdgeRows` no limit, `repo.ts:1021`; `WHERE dst_file is null`,
  `repo.ts:4267`) — a false-positive flood with no count summary. Add a low
  default cap for name-only resolution + a `name_only_unscoped=N; narrow with
  path_glob/kind` hint before the per-row `approx:name-only` tags.
- **Ambiguity-hint parity.** `search_code` emits `ambiguous: N defs`
  (`ambiguousDefCount`, `types.ts:112`) but `find_symbol`/relation tools do not,
  even though routing sends identifiers *to* `find_symbol`. The distinct-def
  count is already in hand (`repo.ts:1015`) — free. Gate on distinct file+kind so
  overloads don't false-positive.
- **mtime/size short-circuit before content read+hash in `scanRepository`.**
  `scanRepository` reads + SHA‑256-hashes *every* file unconditionally
  (`scan.ts:153-165`); `diffScannedFiles` (`repo.ts:1905`) then only *compares*
  those hashes. So each actual triggered sync re-reads + re-hashes the whole repo
  even when almost nothing changed. (The watch *poll* itself is already cheap — it
  uses the stat-only `scanRepositoryManifest`, `scan.ts` / `repo.ts:2008,2199` —
  so this is a per-sync cost, not a per-idle-tick cost.) Fix: pass the indexed
  file rows (`selectIndexedFileRows`) into `scanRepository` as `knownByPath` and
  skip the `readFile`+hash when `size` + `mtime` match an indexed row, reusing the
  stored hash; keep a full-hash sweep on rebuild / HEAD-change as the correctness
  backstop. *Highest steady-state freshness win for actively-edited repos.*
- **Quick wins (S):**
  - Fix the MCP-shim stderr banner — `mcp-shim.ts:12` hardcodes a stale 5-name
    array; the daemon already serves all 10. Source it from an exported
    constant so it can't drift again.
  - Default CLI `sym` to `with_body` and render the inline body (`program.ts:351`
    omits it while the MCP path defaults it on).
  - Give CLI `search`/`grep` a default token budget matching MCP's (CLI is
    unbounded unless `--max-tokens` is passed; `--max-tokens` is already wired).
  - Tag `find_symbol` partial-fallback rows `matchQuality='partial'`
    (`repo.ts:772`) so a `LIKE %name%` guess isn't rendered as exact.
  - Add `annotations:{readOnlyHint:true, openWorldHint:false}` to every
    `registerTool` (`mcp index.ts:743-772`) so harnesses can auto-approve.

### P1 — Collapse the loop (goal A core; reuses shipped edges)

- **`with_relations` on `search_code`, default-on under `autoSingleBest`.** When
  the top hit resolves to one confident symbol (`autoSingleBest`, `repo.ts:623`,
  `!ambiguousIdentifier`), attach the edge-table bundle (`readFindSymbolRelations`,
  `repo.ts:970`) inside the existing budget cap. Collapses `search → find_symbol →
  find_callers` into one call. No AST walk; relations are budget-fitted and
  dropped first under pressure. *Highest call-reducer on the hottest path.*
- **Auto-include callers in `find_symbol` (budget-gated default).** `with_callers`
  already uses the edge path; flip it on when `canEnrichTopExactRow`
  (`repo.ts:774`) fires and a min-budget check passes. Ship after `with_relations`
  so both share the relations renderer.
- **`changeset_context`** — given an explicit file list, return each file's
  symbols + direct (depth‑1) importers/callers in one call. The "what does my
  diff touch" answer rg structurally cannot give. Explicit file list is the
  PRIMARY input; git-diff resolution is opt-in only (preserves zero-shell
  posture). Hard node cap + token budget + index-staleness surfaced.
- **Drop the `index_status` preflight from instructions** (`mcp index.ts:226`) —
  reword to reactive (health attached to normal results; auto-index when safe).
  **Only after the `not_indexed` sentinel ships**, else this deletes the only
  proactive health signal with no replacement.
- **Adaptive output** (`context=auto|min|body|graph`, `auto` = optimize for
  one-call resolution under budget):
  - `find_symbol` `detail:'sig'` tier — emit the stored `signature` column
    (~10–30 tok vs `INLINE_BODY_MAX_TOKENS=400`), falling back to body when null.
  - Concept search: relevant slice first with a compact enclosing-symbol header;
    full body only when confidence the whole body matters is high.
  - Header-dedup of per-line numbers **only on the provably-contiguous
    inline-body path** (one `@<startLine>` header + raw dedented code); never on
    centered/non-contiguous snippets (absolute-line math breaks). Zero
    `PREFIX_TOKEN_COST` in `renderedBodyTokens` for that renderer or the budget
    over-counts.

### P2 — Onboarding (goal B; orthogonal track)

Unblocks from one missing helper. Sequence:

1. **`codesift doctor`** (S, ship first) — preflight the documented
   Node‑24/`better-sqlite3` ABI footgun. Wrap the `require('better-sqlite3')` in
   try/catch matching `NODE_MODULE_VERSION` so it *diagnoses* rather than crashes
   on the very error it reports. Reuse `supportedNodeMajors`
   (`smoke-pack-install.mjs:11`) + `repo.status()`. Also covers: missing `rg`,
   corrupt/incompatible index, cloud provider selected without key, secrets
   blocking cloud embed, daemon socket reachability.
2. **Shared `findRepoRoot()` in core** — a NEW exported helper (dirname of the
   `.git` location, handling the worktree `gitdir:` case). Do **not** reuse
   `findGitDirectory` (`repo.ts:2112`) — it returns the `.git` path and is
   module-private. Immediately wire it into the MCP shim's root resolution
   (`mcp-shim.ts:16`, only when no explicit `[path]` arg) so subdir launches stop
   silently indexing the wrong subtree.
3. **`codesift init [path]`** — walk up for root, run `sync()` with progress,
   run a tiny smoke query, then **merge-write** the MCP config (never overwrite;
   `.bak` backup; single `codesift` server key; fall back to `--print` on any
   ambiguity). Support `--print` and `--client`. Print two repo-specific example
   queries from detected symbols; state the local/offline posture in one line.
4. **Eager initial sync on first `watch()`/MCP connect** — `watch()` ends with
   `refreshWatchers()` and a 1s safety poll (`repo.ts:1266`) but no immediate
   sync, so an agent on a never-indexed checkout races an empty index and gets
   `[]`. Insert `void runSync(true)` after `refreshWatchers()`, gated by the
   `onlyIfStale` status check; non-blocking — return an "indexing, N files done"
   status and let the agent poll.
5. **npx pinned-version wrapper** — have `init`'s generated config optionally
   emit `npx -y codesift@<exact-version> mcp <cwd>`. **Pin the version, never
   `@latest`** (it re-resolves each cold start and can re-trigger a
   `better-sqlite3` prebuild mismatch). Extend `smoke-pack-install.mjs` to
   exercise `npx codesift init --print`.
6. **Daemon prewarm UX + cold-path phase instrumentation** — `codesift daemon
   start` for a persistent sidecar; longer idle timeout for active sessions; a
   cheap health probe that doesn't load the heavy path. Split the cold-start
   benchmark into spawn / daemon-connect / repo-open / SQLite-ready / first-query
   so "first useful answer feels instant after setup" becomes measurable.

### P3 — Measurement (prerequisite gate for P4 and ranking in P5)

Both sources agree this is the missing scaffolding; the workflow goes further and
flags that **several ranking bets are unfalsifiable without it** — so it is a
gate, not a nice-to-have, and ranks higher than GPT‑5.5's P3 placement.

- **Real agent-loop eval** — replace the deterministic `queryType→tool` switch
  with simulated agent tasks ("where is auth enforced", "what breaks if I change
  X", "find the impl behind this stack trace", "update this safely"). Track:
  calls-to-final-answer, tokens-to-final-answer, first-tool correctness,
  stop-after-sufficient-context rate, wrong-file/wrong-edit rate, recovery cost
  after ambiguous/stale results.
- **Expanded goldens** — paraphrase per concept query; multi-file answer-set
  (beyond same-name collisions); relation/impact goldens; stack-trace &
  error-message goldens; large-repo ranking/budget stress; "false friend"
  fixtures (docs/tests/generated/interfaces sharing the impl's words).
- **Ambiguous-identifier collision fixture** — blocks the degree-collapse half of
  P5 ranking.
- **Cold-start first-index benchmark** — blocks any first-index parallelism work;
  don't optimize an unmeasured cost.

### P4 — The front door (`ask_code`) — gated on P3

- **Ship `ask_code` as the default-recommended MCP tool**: accepts a natural task,
  infers intent server-side, and returns the resolved answer with a terse header
  envelope (`answer_complete`, `confidence`, `intent`, `next`, `freshness`,
  `ambiguity`, `omitted`). This envelope is the home for GPT‑5.5's metadata —
  **not** a second parallel grammar bolted onto the specialist tools.
- **Keep all specialist tools registered.** `ask_code` *removes* the agent's
  routing decision (its value); it must not *hide* the specialists (recovery +
  power-user path). Lead with `ask_code` in `MCP_SERVER_INSTRUCTIONS`; do not
  ship a minimal default toolset that hides `find_callers`/`impact` etc. —
  revisit hiding only if the P3 eval proves it reduces agent waste.
- **Promote relation bundles into `ask_code` only for intents that need them**
  (e.g. "what breaks if I change X"), under the same budgets as P1.

### P5 — Broaden the moat (graph capability + ranking; ranking gated on P3)

Graph capabilities (cheap on persisted edges, mostly independent of eval):

- **`find_unreferenced`** — zero-inbound-edge dead-symbol detection; a single
  indexed anti-join. Scope HARD to import-resolved languages on **both** symbol
  and edge sides; union the default-export alias or every default export
  false-flags as dead; label `candidate-unreferenced (excludes dynamic/string
  dispatch, DI/reflection, test-only)`.
- **`impact` reverse direction (callees / outbound fan-out)** — BFS scaffolding is
  direction-agnostic; swap dst-keyed for src-keyed select (`idx_edges_src`).
  Filter null-`src_symbol` rows; lower depth + honest label for name-only.
- **`find_tests`** (glob post-filter over `findReferences`, labeled "references
  from test files", not coverage) and **`api_surface`** (reframed from
  export-flagging — which would be an O(files) per-query parse, DEAD — to "module
  symbols ranked by external cross-file fan-in", showing fan-in=0 symbols).
- **`find_cycles`** (niche) — bounded Tarjan over import edges; TS/JS/Python only,
  labeled so a Go repo's empty result isn't read as "no cycles".

Ranking (all tiebreak-only; gated on P3 precision axis):

- **Degree-order colliding definitions** — sort the ambiguous top‑3 by
  import-resolved in-degree (`countDefinitionEdgeRows`, bounded to the tiny
  collision set) before `stableChunkSortKey` (`repo.ts:4608`). Ship the
  *ordering* half; defer dominance-collapse (≥3× → `single_best`) until the
  collision fixture exists (it flips recall).
- **Centrality + edge-proximity as capped saturating tiebreaks** — bounded
  query-time in-degree lookup over the top‑25 candidates (NOT a denormalized
  column); insert after coverage/kind in the tiebreak chain. Never a primary-score
  multiplier.
- **Conservative query-intent arm reweight** — branch the static exact-arm RRF
  weight (`repo.ts:4579`) on the existing `isSymbolDominatedQuery` gate between
  two presets, confident-trigger only, defaulting to the current value. Stays in
  RRF reciprocal-rank space (does not violate the no-weighted-fusion kill).
- **Learned/reranker** — gated A/Bs on expanded concept goldens; a default local
  learned arm only if it clears accuracy, latency, trust, onboarding, and rebuild
  gates. Cloud stays opt-in.

---

## Decisions (where the two sources disagreed)

| Topic | GPT‑5.5 (`north-goal-ideas.md`) | Workflow | **Decision** |
|---|---|---|---|
| **`ask_code` front-door** | Headline bet; default path | Did not propose; flagged tool-merge risk | **Adopt, gated on P3 eval.** It *removes* the routing decision (unlike a mode-enum that relocates it). Keep specialists registered. |
| **Minimal default toolset (3)** | Default; hide specialists behind `--toolset all` | Guardrail: don't break cached tool lists / recovery | **Reject as default.** Lead with `ask_code` in instructions; keep all tools; revisit hiding only if P3 proves it helps. |
| **Relation bundles** | Keep opt-in until budgeted (#10) | Default-on under `autoSingleBest` (#1) | **Default-on, budget-gated.** GPT's O(files)-AST fear is retired post-graph; edges are persisted + budget-fitted. Apply GPT's budget discipline. |
| **`code_graph` mode-enum** | Offered as a compromise | Guardrail: don't hard-replace relation tools | **Reject.** Breaking change to cached lists + instructions + tests; merely moves tool-pick to mode-pick. |
| **Rich `key=value` metadata on every tool** | Yes (#4) | Skeptic killed a 2nd `#hints` grammar | **Split:** envelope lives inside `ask_code`; specialist tools extend existing terse inline tokens (`ambiguous: N`, `not_indexed`, `name_only_unscoped=N`, `[stale]`). |
| **Drop status preflight** | Yes (#2) | Yes, but sequence after `not_indexed` (#7) | **Adopt with sequencing:** sentinel first, reword instruction last. |
| **Measurement priority** | P3 | Prerequisite for ranking bets | **Raise to a gate** for P4 + P5-ranking. |

---

## Guardrails (do NOT)

1. **Never add a signal to the primary fused score** — even a small multiplier.
   `repo.ts:4671` is the cautionary tale (correct rank‑1 demoted, reverted).
   Centrality, proximity, orphan, entry-point: capped tiebreaks only.
2. **Do not denormalize a `fan_in`/in-degree column** — `applySyncChanges`
   re-extracts edges per *changed* file only (`repo.ts:1715/1731`), so a symbol's
   in-degree goes stale the moment a *caller's* file changes. Compute degree as a
   bounded query-time lookup over `idx_edges_dst` on the candidate set.
3. **No O(files) AST walk on any query path.** The persisted edge table is the
   only sanctioned relational path. `api_surface` export-flagging would
   reintroduce a per-query parse — reframe to index-time fan-in.
4. **Keep the import-resolved / name-only scope gate on BOTH sides** of any
   anti-join, cycle, or unreferenced query. Resolved edges carry non-null
   `dst_file`; Go/Java/Ruby/Rust carry `dst_file=null`. A naive clause lets an
   unrelated name-only edge mask a genuinely-dead TS symbol — always label.
5. **Do not shell out to git on the default path** (`changeset_context`, init
   root-detection). Explicit file list / explicit path is primary; git-diff /
   `.git` walk-up is opt-in convenience only.
6. **Do not reuse `findGitDirectory` as a root helper** — it returns the `.git`
   path and is private. Build one new exported `findRepoRoot()`.
7. **`init` must never clobber an MCP client config** — detect-and-print first,
   merge a single key with a `.bak` backup, fall back to print on ambiguity.
8. **Do not pin npx to `@latest`** in generated config — pin an exact version.
9. **Do not reword the preflight instruction before the `not_indexed` sentinel
   ships.**
10. **Do not write the live DB in-place while queries may read** — keep the
    shadow-copy + atomic-rename design; only apply in-place when
    `activeDatabaseUsers===0`, else fall back to shadow.
11. **Do not default-on body inlining for `find_callers`, and do not add a def
    body to `impact`** — both shift budget away from the sites/blast-radius the
    agent asked for. `with_def` stays opt-in on `find_callers`/`find_refs` only.
12. **Do not dedup line-numbers on centered/non-contiguous snippets** — per-line
    numbers are the addressability contract; only the provably-contiguous
    inline-body path is safe.
13. **Do not optimize cold first-index parallelism before the benchmark exists**
    (worker_threads startup hurts small repos; P0's mtime short-circuit already
    makes warm resyncs near-free).
14. **Do not ship a default semantic/cloud arm** to "fix" concept search — local,
    offline, zero-egress stays the default; learned arms only behind explicit
    proof + explicit user choice.
15. **Do not replace `rg`** — keep it as the known-literal fallback; win on
    structural + relational context.

---

## Success metrics

**Product:** time from install to first successful answer; % completing setup
without extra docs; commands required for first useful MCP answer; debug paths
caught by `doctor`.

**Agent:** median tool calls to resolution; median tokens to resolution;
first-tool correctness; stop-after-sufficient-context rate; wrong-file/wrong-edit
rate; recovery cost after ambiguous/stale results.

**Engine:** warm first-result latency; cold first-result latency split by phase;
token-loss count by query type; precision-loss count; recall on multi-target and
relation tasks.

**North-star:** a new user runs one command, asks one question, and the agent
receives enough fresh, accurate context to act without another search.

---

## Sequencing summary

```
P0 trust/honesty ──┐ (independent, mostly S — start now)
P1 collapse-loop ──┤  (P1 preflight-reword waits on P0 sentinel)
P2 onboarding ─────┘
                   │
P3 measurement ────┴──► gates ──► P4 ask_code
                                  P5 ranking (graph capability half is independent)
```

P0/P1/P2 run in parallel. P3 is the unlock for the front-door and the ranking
bets — bring it forward, because without it the highest-leverage accuracy work
is unfalsifiable.
