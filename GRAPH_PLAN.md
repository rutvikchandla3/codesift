# codesift Graph Plan — the relational moat (callers / refs / impact)

> North goal: make codesift answer the questions `rg` *structurally cannot* — "who calls X", "what uses X", "what imports this", "who implements this", "what breaks if I change X" — in **one warm, fresh, zero-egress call**. This is the durable moat: an index can hold relationships; a stateless line-matcher never can.

Status: proposal (2026-06). All file:line anchors below are verified against current `main`.

---

## The one-paragraph thesis

We already compute the hard part and throw it away. `findTypeScriptUsages` (`repo.ts:2415-2524`) does real **import resolution** — it follows `import` declarations, resolves the module specifier back to the defining file, tracks the local binding name (named / default / namespace), then AST-walks for genuine use sites while excluding the definition and the import statements themselves. `findPythonUsages` (`repo.ts:2559+`) does the regex equivalent. But this runs **at query time, re-parsing files from disk on every call** (`repo.ts:2423-2436`), **only for the top hit** (`attachUsagesToTopDefinitionHit`, `repo.ts:2350`), **capped at 5** (`repo.ts:2424`), **opt-in/off by default**, and is **discarded after each query**. The `symbols` table stores **definitions only** (`repo.ts:1198-1208`); there is no edges table anywhere in the schema (`repo.ts:1155-1221`).

The plan: **relocate that resolution from query time to index time, persist it as an `edges` table, and serve relational queries as cheap indexed lookups.** This is a moat move *and* a runtime win — the per-query AST parse disappears, `with_usages` becomes free + always-on + uncapped, and `find_callers` / `find_refs` / `find_importers` / `who_implements` come essentially for free on top of the persisted edges.

---

## The data model

One new table, derived per **source** file (the file that contains the reference), so it maintains incrementally through the path that already exists.

```sql
create table if not exists edges(
  id          integer primary key autoincrement,
  src_file    text not null references files(path) on delete cascade,
  src_line    integer not null,
  src_symbol  text,            -- enclosing caller symbol (nullable; resolved by containing range)
  dst_name    text not null,   -- referenced identifier
  dst_file    text,            -- resolved defining file (import-resolved); null for name-only
  edge_kind   text not null,   -- 'ref' | 'call' | 'import' | 'implements' | 'extends'
  resolution  text not null,   -- 'import-resolved' | 'name-only'   (NEVER a fake 'type-resolved')
  language    text
);
create index if not exists idx_edges_dst on edges(dst_name, dst_file);
create index if not exists idx_edges_src on edges(src_file);
create index if not exists idx_edges_kind on edges(edge_kind);
```

The relational queries then become:

- **who calls / uses X** → `where dst_name = ? and (dst_file = ? or dst_file is null) and edge_kind in ('call','ref')`. The `dst_file` match is what disambiguates the three different `validate` defs in `fixtures/collision-ts/` — the exact collision case `rg` can't resolve.
- **what imports this file** → `where dst_file = ? and edge_kind = 'import'`.
- **who implements / extends Y** → `where dst_name = ? and edge_kind in ('implements','extends')`.

### Two design rules that keep this honest and fresh

1. **Resolution honesty (don't repeat the SCIP mistake).** `MOAT_PLAN.md` already killed "a SCIP graph the scanners can't back." Every edge carries `resolution`. `import-resolved` = we followed the binding (high confidence — what TS/Python already do). `name-only` = identifier matched without resolving the import (the fallback for the Go/Java/Ruby/Rust regex scanners), and it must be surfaced to the agent as *"may include unrelated same-named symbols."* We **never** emit a `type-resolved` label — we don't have a type checker.
2. **Resolve `dst_symbol` lazily by name+file at query time** (via the existing `symbols` table containing-range lookup), rather than storing a hard `dst_symbol_id`. That keeps edges robust when a definition just moves lines — only the *source* file's edges need re-extraction, never every inbound edge.

### Schema-version decision

Adding `edges` is a schema change. Existing indexes won't have edges until rebuilt. Recommendation: **bump `SCHEMA_VERSION`** so the existing compat path (`getIndexCompatibility`, `repo.ts:1269`; `schema_version_mismatch` → guided `--rebuild`) triggers a one-time rebuild that backfills edges. Clean and correct; the one-time reindex cost is acceptable and already a supported flow. (Alternative — add the table without a bump and lazy-backfill on next per-file sync — leaves the graph incomplete until every file is touched; rejected.)

---

## Phasing

### Phase 0 — Foundation (schema + per-file plumbing)

Lay the table and the maintenance plumbing **before** any extraction logic, so extraction and the read-side tools can be built against a real (if initially empty) edges store in parallel.

- Add the `edges` table + indexes to the schema block (`repo.ts:1155-1221`).
- Add `delete from edges` to `clearIndex` (`repo.ts:1228-1237`).
- In `applySyncChanges` (`repo.ts:1327`), add a per-file `deleteEdgesBySrcFile` prepared statement and call it in the replacement loop alongside `deleteSymbolsByFile`/`deleteChunksByFile` (`repo.ts:1391-1398`), plus an `insertEdge` statement and an **extraction hook point** in the changed-files insert loop (`repo.ts:1411`) — initially a no-op `extractEdges(file) -> []`.
- Bump `SCHEMA_VERSION`.
- Add `Edge` / `EdgeKind` / `EdgeResolution` types to `types.ts`; widen `SymbolUsage.resolution` (`types.ts:34`) from the lone `'import-resolved'` literal to `'import-resolved' | 'name-only'`.

This phase ships dark (no behavior change — extractor returns `[]`), so it's safe to land first.

### Phase 1 — Index-time extraction for TS/JS + Python (the core move)

Promote the existing query-time resolvers to index-time extractors that emit `Edge[]` for a single file, and repoint `with_usages` to read persisted edges.

- Refactor `findTypeScriptUsages` (`repo.ts:2415-2524`) into a pure `extractTypeScriptEdges(file, content, sourceFile)` that returns all import-resolved `ref`/`call`/`import` edges for the file (drop the 5-cap; the cap was a query-time budget, not a correctness limit). **Free-ride the existing parse**: TS/JS files are already AST-parsed during chunking (`buildTypeScriptChunks`, `chunking.ts:70-170`) — extract edges in that same pass so marginal index cost is ~zero.
- Same for `findPythonUsages` → `extractPythonEdges`.
- **Caller attribution:** for each use site, resolve `src_symbol` by looking up the `symbols` row whose `[start_line, end_line]` contains `src_line` (cheap range query; the index `idx_chunks_file_range` / symbols table already supports it). A use site inside a function body → that function is the caller; mark the edge `call` when the reference is in call position, else `ref`.
- Rewrite `attachUsagesToTopDefinitionHit` (`repo.ts:2344-2360`) to **read from the `edges` table** instead of parsing — an indexed `select` keyed by the definition's name+file. `with_usages` can now default-on safely (it's a bounded indexed read, no longer an O(files) AST walk — this removes the never-slower hazard `MOAT_NEXT.md:66` flagged).

End state: `with_usages` is free, always-fresh, and complete; the graph is populated for the two languages where resolution is real.

### Phase 2 — Relational query API + MCP tools

Expose the graph. Read-side only; depends on Phase 0's schema (can be built in parallel with Phase 1 against seeded rows).

- Core: `findCallers(name, opts)`, `findReferences(name, opts)`, `findImporters(file)` on the `Repo` class — each a thin indexed `select` over `edges` joined to `symbols` for the def-site, with the same token-budgeting treatment as existing hits.
- MCP: register `find_callers`, `find_refs`, `find_importers` — add to `MCP_TOOL_NAMES` (`mcp/src/index.ts:49-55`), zod input schemas (alongside `:176-219`), `getToolDefinitions` (`:256-324`), the dispatch `switch (name)` (`:431-452`), and `registerTool` (`:521-533`), with formatters mirroring `formatMcpSymbols` (`:1208`). Update `MCP_SERVER_INSTRUCTIONS` (`:167-171`) routing.

### Phase 3 — `implements`/`extends` + multi-language name-only edges

- TS `implements`/`extends` edges from the AST (`heritageClauses` — already in the tree we parse).
- `name-only` edges for Go / Java / Ruby / Rust by piggybacking on their existing regex scanners (`chunking.ts:172-503`), masking strings/comments via the existing `maskCStyleSyntax`. Labeled `name-only`, surfaced honestly.
- `who_implements` MCP tool.

### Phase 4 — One-call relational answer + impact analysis

- Upgrade `find_symbol` to optionally return **definition body + top callers + usages + same-file neighbors** in a single response (answers the open question in `MOAT_NEXT.md:148`; collapses the agent's `find_symbol → grep → read → grep` refactor loop into one call).
- `impact(name, depth)` — transitive callers up to depth N (bounded), the "what breaks if I change this" query, with a hard node/time budget.

---

## Parallelization

### Dependency graph

```
PHASE 0 (foundation — lands first, ships dark)
   schema + clearIndex + applySyncChanges hook + types
        │
        ├─────────────────────────┬───────────────────────────┐
        ▼                         ▼                           ▼
PHASE 1 (extraction)        PHASE 2 (tools/read API)      (fixtures, seeded rows)
 TS/JS + Python edges       build against schema with     usages-ts + collision-ts
 + with_usages repoint      hand-seeded edge rows,        already exist — reuse
        │                   wire to real edges when 1 lands
        └─────────────┬───────────┘
                      ▼
              PHASE 3 (implements/extends + name-only langs)
                      ▼
              PHASE 4 (one-call answer + impact)
```

The unlock: **Phase 1 (extraction) and Phase 2 (read-side tools) are independent once Phase 0's schema exists.** Phase 2 can be developed and tested against hand-seeded `edges` rows, then flipped to live data the moment Phase 1 lands. That's two tracks running concurrently after a small, fast Phase 0.

### Tracks

- **Track A — extraction (the novel work).** Phase 1 → Phase 3 extraction. Owns the edge-extraction algorithms, caller attribution, and resolution-confidence semantics.
- **Track B — read-side surface (mechanical).** Phase 2 query methods + MCP tools, developed against seeded rows. Then Phase 4 wiring.
- **Track C — foundation (mechanical).** Phase 0; lands first, unblocks A and B.

### File-conflict hotspot

`packages/core/src/repo.ts` is the shared file. Conflicts are avoidable because the work lands in **different functions**, but two pairs need ordering discipline:

| Work | Functions in `repo.ts` | Note |
|------|------------------------|------|
| Phase 0 | schema block (`1155`), `clearIndex` (`1228`), `applySyncChanges` (`1327`) | lands first |
| Phase 1 | `extractTypeScriptEdges`/`extractPythonEdges` (was `2415`/`2559`), hook in `applySyncChanges` insert loop (`1411`) | **touches `applySyncChanges` too → land after Phase 0, same owner for that function** |
| Phase 2 | new `findCallers`/`findReferences`/`findImporters` (new functions, disjoint) | safe in parallel |

`packages/mcp/src/index.ts` is touched only by Phase 2/4 (new tools) — disjoint from the `repo.ts` extraction work, so Track B's MCP edits never collide with Track A. `types.ts` is touched by Phase 0 (and read by all) — land the type additions in Phase 0 so the rest compile against them.

**Recommendation:** give each track its own branch/worktree. The only function needing a coordination conversation is `applySyncChanges` (Phase 0 lands the hook point; Phase 1 fills the extractor).

---

## Delegation: Claude (creative) vs pi (mechanical)

Same split principle the moat work used (`MOAT_NEXT.md:99`): **Claude owns novel algorithms, resolution/confidence semantics, caller-attribution logic, and anything that changes what an edge *means* or how a tool *answers*; pi owns deterministic schema/plumbing, MCP wiring, formatters, and fixtures under a written spec** with exact file:line targets, the acceptance test, and a guardrail.

| Task | Owner | Why this split |
|------|-------|----------------|
| `edges` schema + index design, `resolution` taxonomy, schema-version decision | **Claude** | Data-model + honesty semantics |
| Phase 0 wiring — table in schema block, `clearIndex` line, `applySyncChanges` delete/insert/hook, `SCHEMA_VERSION` bump, `types.ts` additions | **pi** | Pure mechanical plumbing once schema is fixed |
| Phase 1 extraction algorithm — refactor resolvers to pure per-file extractors, drop the 5-cap, edge-kind (`call` vs `ref`) classification | **Claude** | Novel: changes what we extract and how we classify it |
| Phase 1 **caller attribution** — containing-range `src_symbol` resolution design | **Claude** | Judgment: how to attribute a use site to its enclosing symbol |
| Phase 1 `attachUsagesToTopDefinitionHit` repoint to indexed read + default-on flip | **pi** | Mechanical once the read shape is specified |
| Phase 2 tool **semantics** — what each tool returns, output shape, routing-instruction wording, collision/ambiguity handling | **Claude** | Changes the agent-facing contract |
| Phase 2 MCP **plumbing** — `MCP_TOOL_NAMES`, zod schemas, `getToolDefinitions`, dispatch `switch`, `registerTool`, formatters | **pi** | Deterministic wiring against shipped patterns |
| Phase 2 core read methods (`findCallers`/`findReferences`/`findImporters`) | **pi** | Thin indexed selects once the SQL shape is specified |
| Phase 3 `implements`/`extends` extraction + name-only multi-language design + honest surfacing | **Claude** | Confidence labeling + cross-language judgment |
| Phase 3 regex-scanner edge plumbing per language | **pi** | Mechanical, mirrors the chunking scanners |
| Phase 4 one-call answer composition + `impact` traversal + budgets | **Claude** | Novel composition + bounded-traversal algorithm |
| Correctness fixtures/tests (reuse `fixtures/usages-ts`, `fixtures/collision-ts`) | **pi** | Mechanical fixture/test authoring to a spec |

**Net:** Claude carries the extraction algorithms (1, 3, 4 extraction), caller attribution, tool/answer semantics, and the data model. pi carries Phase 0 foundation, all MCP/SQL plumbing, the with_usages repoint, the regex-scanner edge wiring, and fixtures. **Wave 1 = pi (Phase 0) lands fast → then Claude (Phase 1 extraction) ∥ pi (Phase 2 plumbing on seeded rows) run concurrently.**

### How to hand a task to pi

Use the `pi-delegate` skill, **one task per delegation**, each with: target files + line anchors, the exact change, the acceptance test (`pnpm test` or a named vitest), and the guardrail *"do not modify extraction/resolution/ranking logic — plumbing only."*

> **Local gotcha:** `pi-delegate` crashes on startup in this repo via the broken agent-view extension — invoke it with `-ne` to disable extensions. Build/test under Node 22 (`.nvmrc`), since `better-sqlite3`'s native binary needs it.

Good first pi delegations (independent, fully specified): **Phase 0 foundation** and **the Phase 2 MCP plumbing against seeded edge rows**.

---

## What NOT to do (guardrails)

- **Don't claim type resolution.** No `type-resolved` label, ever — we have no type checker. Label `import-resolved` vs `name-only` and surface `name-only`'s ambiguity to the agent.
- **Don't make extraction unbounded on the default path.** Edge extraction rides the existing per-file parse (index time, once per file change) — never an O(files) walk at query time. That is the whole point and the thing that keeps "never slower than rg" intact.
- **Don't break zero-egress / offline.** The graph is pure local AST/regex work — no network, no model. Keep it inside `pnpm run test:offline`.
- **Don't store hard `dst_symbol_id` pointers** — resolve by name+file at query time so a moved definition doesn't require rewriting every inbound edge.
- **Don't over-promise multi-language.** Go/Java/Ruby/Rust ship as `name-only` first; upgrade per language to import-resolved only when a real lightweight import parser exists for it.

---

## Proof (lightweight, product-correctness — not a new benchmark)

Reuse the fixtures that already exist: `fixtures/usages-ts/` (a `parseToken` def with two real call sites in `src/api.ts` + `src/worker.ts`) proves caller/usage extraction; `fixtures/collision-ts/` (three `validate` defs) proves `dst_file` disambiguation. Add core tests asserting: (1) edges survive incremental re-sync of a changed source file, (2) `find_callers` resolves the right `validate` by file, (3) `with_usages` returns identical results read-from-index as the old parse path. These are correctness gates on the feature, not a competitive eval.
