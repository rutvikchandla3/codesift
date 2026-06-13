# M1 Addendum — scope deltas for the walking skeleton

> **For the parallel agent implementing M1.** Separate from `PLAN.md` to avoid edit collisions.
> M1 is "scan → chunk → embed → store → index+search e2e." The audit (see `NUANCES.md`) found that
> several M1-era decisions are **load-bearing for M2–M6** and are far cheaper to settle now than to
> retrofit after the schema and the `EmbeddingProvider`/`Repo` interfaces have consumers. The theme:
> **lock the interfaces and the data shapes correctly now; defer the heavy implementations.**
>
> Most items are *interface/shape* changes, not full features — the implementation can stay simple
> (even the current hash embedder) as long as the **contract** is right.

Each item: **what / why it must be in M1 / concrete change / acceptance.**

---

## M1-1 — Do not ship `local-hash-v1` as "semantic"/"hybrid" — honest lexical default `[critical]`

- **Why now.** The fake hash embedder is strictly worse than ripgrep on exact identifiers *and*
  worse than a real model on concepts — it loses on all three north-star axes. Worse, it's already
  advertised as *"Hybrid lexical + semantic code search"* (`packages/mcp/src/index.ts:67`) and the
  CLI describes itself as *"Local-first hybrid code search"* (`program.ts:86`). Shipping this wording
  is a trust bomb that detonates the moment a real model lands, and it poisons the eval (the synonym
  table self-games recall — `NUANCES.md` §6).
- **Change.** (a) **Hard rule:** the published default provider id must **never** be `local-hash-v1`.
  (b) Gate the words "semantic"/"hybrid" in all tool descriptions, CLI help, and README behind a real
  (non-hash) learned provider being active; until then the honest name is **"lexical search."**
  (c) Keep the hash provider only as a test/dev fixture, clearly labelled, never the published default.
- **Acceptance.** A test asserts no published artifact's default provider id is `local-hash-v1`, and
  that "semantic"/"hybrid" strings only appear when a learned provider is registered.

## M1-2 — Stable, content/location-addressed chunk ids (not autoincrement rowid) `[critical]`

- **Why now.** `SearchHit.id` is the SQLite autoincrement rowid, and `sync()` does `clearIndex()` +
  reinsert (`repo.ts:441`), so **every reindex reassigns ids**. M2's `read_chunk` and agent-side id
  caching are built directly on these ids; unstable ids silently mis-resolve to a different (or
  deleted) chunk after any edit/rebuild. This is the durable handle the SDK read primitive needs, so
  it must exist before that primitive is designed.
- **Change.** Make chunk identity content-derived and sync-stable, e.g.
  `id = "<relpath>:<startLine>-<endLine>@<contentHash>"` (or a `(file_path, symbol_path, content_hash)`
  composite stored as a TEXT key separate from rowid). Add an index-generation/epoch counter in `meta`
  and embed it (or make epoch checkable) so a read against a stale epoch is *detectable*.
- **Acceptance.** Re-running `sync()` on unchanged content yields **identical** `SearchHit.id`s for the
  same chunks (test asserts id stability across two syncs).

## M1-3 — Add the read primitive to the core `Repo` interface now `[critical]`

- **Why now.** PLAN's whole token story is "compact hits + ids → expand on demand," and M2's MCP
  `read_chunk` + the eval token harness are built on it — but the SDK exposes no chunk-by-id read, so
  M2 can't implement it and the eval can't measure tokens. The `content` column already exists
  (`repo.ts:124`); only the API + stable id are missing. Defining the contract in M1 unblocks M2.
- **Change.** Add to the `Repo` interface (`packages/core/src/types.ts:87`):
  `readChunk(id, { contextLines? })` and `readRange(file, startLine, endLine, { contextLines? })`,
  reading from the **on-disk file** (re-sliced) so results are correct even if the stored snippet is
  stale. Implementation can be minimal in M1; the signature is the deliverable.
- **Acceptance.** `repo.readChunk(hit.id)` returns the chunk's source for a hit produced by `search()`;
  `readRange` returns an arbitrary line window ± context. Typed and exported.

## M1-4 — Role-aware `EmbeddingProvider` interface (`query` vs `document`) `[high]`

- **Why now.** `search()` embeds the raw query through the **document** path (`repo.ts:196` vs the
  breadcrumb-prefixed `embeddingText` in `chunking.ts:280`). Asymmetric code models (jina-v2-code,
  voyage-code) require distinct query/passage prompts; cloud providers need an `input_type` param; and
  the embedding cache key (M2) must be role-aware. Baking the role into the interface now means
  providers and the cache are correct from day one, with no later breaking change.
- **Change.** Extend the interface (`types.ts:96`): `embedBatch(texts, { role: 'query' | 'document' },
  signal?)` (or `embedQuery`/`embedDocuments`). The hash provider can ignore the role; the contract is
  what matters. Decide deliberately whether queries get a synthetic breadcrumb — query and document
  text construction must be intentional, not accidentally identical.
- **Acceptance.** Interface carries the role; `search()` calls it with `role: 'query'`; sync calls it
  with `role: 'document'`. Type test covers both.

## M1-5 — Batched embed → insert orchestration + `maxBatch`/`maxBatchTokens` `[high]`

- **Why now.** `sync()` flatMaps the **entire repo** into one `embedBatch` call and one transaction
  (`repo.ts:81-91, 140-180`). Harmless for the synchronous hash, but it bakes a memory-wall +
  event-loop-block architecture that a real M1/M2 model would inherit (30–80k texts in one array OOMs
  or stalls for minutes). Fix the *orchestration shape* now while it's cheap.
- **Change.** Add provider-declared `maxBatch` / `maxBatchTokens` to `EmbeddingProvider`. Have the core
  driver chunk the corpus into bounded batches, embed → insert → release per batch (interleaving with
  the transaction), emit per-batch progress events, and check `signal.aborted` between batches. Bound
  peak memory to one batch of vectors.
- **Acceptance.** Indexing a synthetic large repo holds flat memory (one batch resident); abort between
  batches stops cleanly; progress events fire per batch.

## M1-6 — Provider/dims/schema-version guard on open (guided rebuild) `[high]`

- **Why now.** The `vec_length` CHECK hardcodes dims from the default provider at table-creation
  (`repo.ts:417`), and `provider_id`/`provider_dims`/`schema_version` are written to `meta`
  (`repo.ts:174-177, 224`) but **never read**. Swapping in a real 768d model on a 384d index throws a
  cryptic `SQLITE_CONSTRAINT` mid-insert, or `search()` runs an unguarded cross-dim cosine. The schema
  has *already* churned (v1 here; v2 adds FTS/vec in M2) with no migration gate — this is a live bug.
- **Change.** On `openDatabase`, read `meta.schema_version` + `provider_id` + `provider_dims` (+ a new
  `model_version`); on mismatch with the active binary/provider, **refuse to query** and emit a
  structured, machine-readable message (`"index built with X (Ndims) / schema vK, now Y (Mdims) /
  schema vL — run \`codesift index --rebuild\`"`) that the CLI turns into a guided prompt and
  `index_status` exposes. Never run a cross-dim cosine.
- **Acceptance.** Opening an index whose stored provider/dims/schema differ from the active ones
  refuses with the guided message instead of throwing a raw constraint error.

## M1-7 — Add `mtime` to the `files` manifest now `[high]`

- **Why now.** PLAN §5.6 promises a "cheap mtime scan" for M4 staleness, but the `files` table is
  `(path, language, hash, size)` (`repo.ts:398-403`) — `scan.ts:87` computes `mtime` then **throws it
  away**. Adding a column later is a schema change that forces a rebuild; adding it now in M1 means M4
  freshness has something to scan against for free.
- **Change.** Add `mtime` to the `files` schema and persist `fileStat.mtimeMs` (already available in
  `scan.ts`). No behavior change required in M1 — just stop discarding the data.
- **Acceptance.** `files` rows carry `mtime`; a test reads it back.

## M1-8 — Deterministic results + reproducibility assertion `[high]`

- **Why now.** Determinism is a silent prerequisite for the M6 paired-delta eval gate, agent id-caching,
  and trust — grep is deterministic by default. Two non-determinism sources already exist: fragile
  float-equality before the `localeCompare` tie-break in fusion, and rowid reassignment across reindex
  (fixed by M1-2).
- **Change.** Add a deterministic final tie-break to the ranking/fusion on a **stable** key
  (`file:startLine` or contentHash — never rowid). Add a test: the same query against the same index,
  run twice, returns an **identical ordered id list**.
- **Acceptance.** The reproducibility test passes; ordering is stable across runs and across a
  no-op reindex.

## M1-9 — Symlink handling in the scan `[high]`

- **Why now.** `walk()` uses `Dirent.isFile()/isDirectory()` (`scan.ts:77-82`), both false for symlinks,
  so symlinked source files/dirs are silently dropped — a real recall hole in monorepos, invisible with
  no warning. Cheaper to handle in the M1 scanner than to debug missing-recall reports later.
- **Change.** Detect symlinks explicitly; follow them with a visited-realpath set (cycle-safe); refuse
  links resolving **outside the repo root** (security); surface `skippedSymlinks` in `SyncResult`.
- **Acceptance.** A symlinked source file inside the repo is indexed; a symlink pointing outside the
  root is refused and counted; cycles don't hang the walk.

---

## Smaller M1 shape fixes worth folding in (low cost, prevents churn)

- **Unify the default `k` in core.** MCP defaults `k=8` (`mcp/index.ts:10`), SDK defaults `k=10`
  (`repo.ts:202`). Pick one (8) in core so M2's token-budget work has a single source of truth.
- **Consider dropping the `content` column.** If `readChunk`/`readRange` (M1-3) re-read from disk, the
  full-text `content` column is redundant (it's a second plaintext copy of the source — `NUANCES.md` §8)
  and roughly halves index size. Decide in M1 so M2 storage isn't built around storing it.
- **Keep the lexical/symbol path model-free.** Whatever lands in M1, ensure a symbol/identifier query
  can be answered with **zero** embedding-model involvement. This is the seam the M2 zero-model
  cold-start fast-path and the M0-1 lazy-vector-load depend on.

---

## Cross-references

- Strategic context and the "why beat grep" framing: **`NUANCES.md`** (§4 tokens, §5 embeddings, §7
  freshness/trust, §10 milestone map).
- M0 seams these depend on (lazy vector load, self-gitignore, native-dep matrix): **`M0_ADDENDUM.md`**.
- Forward plan changes (positioning, daemon, latency contract, roadmap, risks): **`PLAN.md` §12**.
