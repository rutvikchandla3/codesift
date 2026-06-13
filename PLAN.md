# codesift — Plan

> Chosen name: **codesift**. See [§9 Naming](#9-naming) for the final comparison and npm availability check.

Hybrid (lexical + semantic) code search for repositories, shipped as one TypeScript core with three thin interfaces: a **CLI** for humans, an **SDK** for programs, and an **MCP server** for AI agents. Open source, MIT.

**Status**: M4 freshness/watch is complete; M5 and M6 remain before v0.1 release.

---

## 1. Problem & summary

`grep`/`ripgrep` find exact strings; they can't answer "where do we validate JWTs?" or "what handles retry backoff?". Pure embedding search answers those but misses exact identifiers (`verifyToken`, `HR_API_BASE`) — which are most code queries in practice. The tools that do both well today are either hosted/proprietary (Sourcegraph, Greptile, Cursor's internal indexing) or not designed to be embedded (no SDK, no MCP, or no local-first story).

codesift indexes a repo into a single local file (AST-aware chunks + symbols + BM25 + vectors), keeps it fresh incrementally, and serves hybrid search through CLI/SDK/MCP. Code never leaves the machine by default; cloud embedding providers are opt-in.

## 2. Goals & non-goals

### Goals (v0.1)

1. **Hybrid retrieval**: BM25 (lexical) + dense vectors, fused with reciprocal rank fusion; exact-symbol boost. Quality target: relevant result in top 5 for typical NL queries (measured by eval harness, §6).
2. **Two query types done well**: natural language → code, and symbol-aware lookup ("definition of `TokenVerifier`").
3. **Three interfaces, one engine**: CLI (`codesift`), SDK (`@codesift/core`), MCP server (stdio + minimal HTTP). All wrappers <~500 LOC each; logic lives in core.
4. **Local-first, pluggable embeddings**: local ONNX model by default (zero API keys, works offline); Voyage/OpenAI/Gemini opt-in behind one provider interface.
5. **First-class language support ×6**: TypeScript/JavaScript, Python, Go, Java, Ruby, Rust — AST chunking + symbol extraction. Everything else (incl. Markdown/config) gets smart line-based fallback chunking, still searchable.
6. **Incremental freshness**: content-hash diffing on `index`; optional `--watch` daemon.
7. **Eval harness**: golden query sets over pinned OSS repos, recall@k/MRR in CI, so tuning isn't guesswork.

### Non-goals (v0.1) — explicitly post-MVP

- Cross-encoder **reranking** (architecture leaves a slot; see §10).
- **Team server**: multi-repo routing, real authn/z, user management. v0.1 HTTP mode is single-index, localhost/trusted-network, optional bearer token.
- **Monorepo scale** (millions of LOC). The storage interface must not preclude it (§5.5), but v0.1 targets repos up to ~5k files / ~500k LOC.
- Code → similar-code queries, error-trace → code queries.
- Cross-repo/org-wide search, editor extensions, a hosted service.
- Full code intelligence (references, call graphs, type info) — we extract definitions, not an LSP replacement.

## 3. Landscape (why build this)

| Tool | Gap codesift fills |
|---|---|
| ripgrep / grep | Lexical only; no semantic recall. We treat it as a complement, not a competitor. |
| Sourcegraph / Zoekt | Server-grade, heavy to self-host; lexical-first; no local-first MCP story. |
| Greptile, Cursor indexing | Hosted/proprietary; code leaves the machine; not embeddable. |
| mgrep (mixedbread), claude-context (Zilliz) | Closest neighbors. Tied to one vendor's embeddings/store; weaker symbol-awareness; not all three of CLI+SDK+MCP. |
| semgrep | Pattern/rule matching for static analysis — different job despite the name. |

Positioning: *the local-first, vendor-neutral, embeddable hybrid code search engine* — `ripgrep` for meaning, installable in one command, usable equally by a human, a script, and an agent.

## 4. Product requirements

### 4.1 CLI (`codesift`)

```
codesift index [path] [--rebuild] [--watch]      # build/refresh index (incremental by default)
codesift search "<query>" [-k 10] [--lang ts] [--path 'src/**'] [--kind function]
                          [--json | --compact]   # compact = token-efficient, for piping to agents
codesift sym <name> [--kind class|function|...]  # symbol lookup from the symbols table (no embedding)
codesift mcp                                     # MCP server on stdio
codesift serve --port 7345 [--token <t>]         # MCP over streamable HTTP (localhost default)
codesift status                                  # index freshness, chunk/symbol counts, model, size
codesift config [get|set]                        # provider, model, ignore rules
codesift clean                                   # delete the index
```

- Default output: `file:line-range`, symbol breadcrumb, scored snippet — readable in a terminal.
- First run downloads the local embedding model (~65 MB quantized) with a progress bar; cached in `~/.cache/codesift/models/`.
- Index lives at `.codesift/` in the repo root (gitignored by default; `index.db` single file).
- Respects `.gitignore` (+ `.codesiftignore`); never indexes files >1 MB or binaries.

### 4.2 SDK (`@codesift/core`)

```ts
import { openRepo } from '@codesift/core'

const repo = await openRepo('/path/to/repo')        // opens or creates .codesift/
await repo.sync()                                    // incremental index; emits progress events
const hits = await repo.search('where are JWTs validated', {
  k: 10, lang: ['ts'], pathGlob: 'src/**',
})
// hits: { file, range, score, symbol?, kind?, snippet, language }[]
const defs = await repo.findSymbol('TokenVerifier', { kind: 'class' })
const stop = await repo.watch()                      // chokidar-backed incremental updates

// Bring-your-own embeddings:
import { registerEmbeddingProvider } from '@codesift/core'
registerEmbeddingProvider(myProvider)                // { id, dims, maxTokens, embedBatch(texts) }
```

- ESM-only, Node ≥ 20, fully typed, no side effects on import.
- The CLI and MCP server are consumers of this exact API — it's the contract.

### 4.3 MCP server (`@codesift/mcp`)

Tools (designed for agent token-efficiency — compact results, ids for follow-up reads):

| Tool | Purpose |
|---|---|
| `search_code(query, k?, lang?, path_glob?)` | Hybrid search; returns compact hits (path:lines, symbol, 3–5 line snippet, score). |
| `find_symbol(name, kind?)` | Definition lookup from the symbols table. |
| `read_chunk(id, context_lines?)` | Expand a hit to full chunk ± context, so `search_code` results can stay short. |
| `index_status()` | Freshness, counts, model info; lets the agent decide whether to suggest reindexing. |

- **stdio** (default): agents spawn `npx codesift mcp` per repo. Zero config in Claude Code/Cursor.
- **Streamable HTTP** (v0.1-minimal): `codesift serve` — same single index, binds `127.0.0.1` by default, optional static bearer token for trusted-network sharing. Multi-repo/team auth is post-MVP (§10).
- Server instructions teach the agent: search before grep for conceptual queries, prefer `find_symbol` for identifier lookups.

## 5. Architecture

### 5.1 Repo layout (pnpm workspaces)

```
packages/
  core/   @codesift/core   — engine + public SDK (everything below lives here)
  cli/    codesift         — commander-based CLI, depends on core + mcp
  mcp/    @codesift/mcp    — MCP tools/transports on @modelcontextprotocol/sdk, depends on core
  eval/   (private)        — eval harness, golden sets, benchmark repo manifests
```

### 5.2 Indexing pipeline

```
scan (git ls-files ∪ fs walk, .gitignore-aware)
  → detect language
  → chunk: AST/structural language parsers | fallback line-windows (others)
  → extract symbols (defs: name, kind, signature, range, parent)
  → build embedding text: path + symbol breadcrumb + leading comment + code
  → embedBatch via provider (local ONNX default)
  → store chunks + vectors + FTS rows + symbols + file manifest  (one SQLite transaction per file batch)
```

- **Chunking**: top-level functions/classes/methods become chunks; oversized nodes split at child boundaries with overlap; tiny siblings merged. Target 256–512 tokens/chunk. Each chunk carries file, range, language, symbol name/kind/parent. Fallback: ~60-line windows, 15-line overlap.
- **Parser-quality decision for M3**: tree-sitter WASM remains the preferred long-term parser path only if grammars can be bundled without native/postinstall pain. For M3, codesift accepts deterministic structural scanners for Go/Java/Ruby/Rust instead: comment/string-masked brace/block parsing, nested parent tracking, broad symbol extraction, and eval fixtures prove the launch contract without adding a new grammar supply chain.
- **Contextual headers**: embedding text is prefixed with `src/auth/jwt.ts > class TokenVerifier > verify()` + docstring — markedly improves NL→code retrieval for little cost.

### 5.3 Embeddings — provider interface

```ts
interface EmbeddingProvider {
  id: string            // recorded in the index; mismatch forces --rebuild
  dims: number
  maxTokens: number
  embedBatch(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
}
```

- **Local default**: `jina-embeddings-v2-base-code` (code-specific, 768d, 8k ctx) via `@huggingface/transformers` ONNX, int8-quantized (~65 MB). Chosen over general-text models because the eval target is code; final call validated by the harness in M6.
- **Cloud (opt-in)**: `voyage-code-3` (best published code-retrieval quality), OpenAI `text-embedding-3-*`, Gemini. Keys via env; provider set in `.codesift/config.json`.
- Index records `{providerId, model, dims}`; switching providers triggers a guided `--rebuild`.

### 5.4 Storage — single SQLite file

`better-sqlite3` + **FTS5** (BM25, compiled in) + **sqlite-vec** extension (vectors, prebuilt binaries on npm). Tables: `files` (path, hash, mtime), `chunks`, `chunks_fts` (FTS5), `vecs` (sqlite-vec virtual table), `symbols`, `meta`.

Why: one embedded file, zero services, transactional consistency between lexical/vector/symbol data, trivial `clean`. sqlite-vec is brute-force KNN — fine to ~1M vectors with SIMD, and a 5k-file repo yields ~30–80k chunks. int8 vector quantization keeps a typical index ≲ 100 MB.

**Design-for-big**: core talks to a `StorageBackend` interface (upsert/delete by file, lexicalSearch, vectorSearch, symbol queries). SQLite is the only v0.1 implementation; a LanceDB (ANN) or server backend slots in post-MVP without touching the pipeline or retrieval code.

### 5.5 Retrieval

```
query → [BM25 over code+symbol text]  →  top-100 ─┐
      → [vector KNN over chunk vecs]  →  top-100 ─┤→ RRF (k=60) → symbol boost → filters → top-k
```

- **Symbol boost**: identifier-shaped tokens in the query (camelCase/snake_case/dotted) that exactly match a symbol name multiply that chunk's fused score. This is what makes "where is `verifyToken` called from" beat pure-vector tools.
- Filters (lang/path/kind) applied as SQL predicates, not post-filtering — keeps k stable.
- Reranker slot: a `Reranker` interface ships in v0.1 (no implementation) so the post-MVP cross-encoder is additive.
- Latency targets: p50 < 300 ms warm (local model resident), index 5k files < 5 min cold on an M-series laptop (embedding-bound), incremental update < 5 s for a handful of changed files.

### 5.6 Freshness

- `files` manifest: content hash (xxhash) + mtime + size. `index` diffs the manifest, re-processes only changed/added files, deletes chunks of removed files. Renames = delete + add (cheap; embeddings re-used not attempted in v0.1).
- `--watch`: native `fs.watch` directory subscriptions with 500 ms debounce and bounded safety polling, batched through the same incremental path.
- `codesift mcp`: a thin stdio shim starts or reuses a long-lived local daemon over a local socket, so MCP routing and repo handles are amortized across agent sessions.
- Query-time: cheap mtime scan; results carry a `stale: true` flag (and the MCP `index_status` tool exposes it) rather than blocking the search.

## 6. Eval harness (`packages/eval`)

- 3–5 pinned OSS repos across the launch languages (e.g., `express` (JS), `flask` (Py), `gin` (Go), a Rust + Java repo).
- Golden sets: 30–50 NL queries per repo with expected file/symbol targets, hand-curated; plus a symbol-lookup set.
- Metrics: recall@5, recall@10, MRR; per-language breakdown. Results JSON checked in → regressions show as diffs in PRs; runnable headless in CI (local embedder, no keys).
- Used to settle every quality knob: chunk size, RRF k, symbol-boost weight, fallback window size, and the local-model choice (jina-code vs alternatives), and to publish an honest local-vs-Voyage quality comparison in the README.

## 7. Milestones

Each milestone ends with a demo and a hard cut line. Dogfooding starts at M2 (this is deliberate — the MCP server lands early enough to use codesift while building codesift).

| # | Scope | Demo / exit criteria |
|---|---|---|
| **M0 Scaffold** | pnpm workspace, tsconfig/tsup, vitest, CI (mac+linux+win matrix), MIT, name registered on npm. | `pnpm build && pnpm test` green in CI. |
| **M1 Walking skeleton** | Scan → AST chunking (TS/JS, Python) + fallback → local embeddings → SQLite+sqlite-vec → `index` + `search` (semantic-only) e2e. | NL query over a real repo returns sensible results from the CLI. |
| **M2 Hybrid + symbols + early MCP** | FTS5 + RRF fusion, symbol extraction (TS/JS, Py), symbol boost, `sym` command, `--json/--compact`; **minimal MCP stdio** (`search_code`, `find_symbol`). | Identifier queries beat M1 visibly; codesift is installed in our own Claude Code via MCP. |
| **M3 Languages** | Go, Java, Ruby, Rust AST + symbols; Markdown/config via fallback; chunker hardening (huge files, generated-code heuristics). | Eval-set spot checks pass per language. |
| **M4 Freshness** | Manifest diffing, deletions, `--watch`, `status`, stale flags. | Edit → save → search reflects the change in <5 s under `--watch`. |
| **M5 Interfaces complete** | Full MCP toolset + streamable HTTP w/ bearer token; SDK API freeze + typedoc; cloud providers (Voyage, OpenAI) + `--rebuild` flow. | Second machine queries over HTTP; SDK quickstart works as documented. |
| **M6 Quality & release** | Eval harness + golden sets, tune all knobs, perf pass against §5.5 targets, README + docs, **v0.1.0 on npm**. | Published; eval numbers in README; `npx codesift index && npx codesift search` works on a cold machine. |

Rough sizing: M0–M2 are the critical path to a usable tool; M3–M6 are parallelizable hardening. If scope pressure hits, M3 shrinks to 4 languages before anything else moves.

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Local embedding quality disappoints vs cloud | Eval harness quantifies the gap; provider swap is one config line; publish honest numbers. |
| ~65 MB first-run model download UX | Progress UI, shared cache in `~/.cache/codesift`, clear offline docs; `--provider` lets users skip it. |
| Native dep pain (`better-sqlite3`, `sqlite-vec` prebuilds) | Both ship prebuilt binaries; CI matrix on mac/linux/win catches breakage; M3 avoids adding a parser native dependency. |
| Brute-force KNN ceiling on huge repos | Documented limit; `StorageBackend` interface keeps an ANN backend (LanceDB) a post-MVP add, not a rewrite. |
| Chunking quality varies by language | Per-language eval breakdown; fallback chunker as the floor. |
| Index staleness confuses users | `stale` flags on results + `status` + MCP `index_status`; `--watch` for the sensitive. |
| Name/npm squatting | Register the chosen name + `@scope` at M0. |

## 9. Naming

npm availability checked 2026-06-13 (`rcode` is taken):

| Candidate | npm | Take |
|---|---|---|
| **codesift** (selected) | ✅ free | Descriptive, obvious binary name, scoped packages read well (`@codesift/core`). |
| **dowse** | ✅ free | Evocative (dowsing for code), short, memorable; less self-explanatory. |
| **deepgrep** | ✅ free | Instantly communicates the pitch; "deep" reads slightly dated, semgrep adjacency. |
| **codescout** / **semseek** | ✅ free | Solid backups. |

Decision needed at review; M0 registers it.

## 10. Post-MVP roadmap (ordered)

1. **Reranking** — local cross-encoder (e.g., jina-reranker ONNX) or Cohere/Voyage rerank API behind the `Reranker` interface; expect the biggest single quality jump.
2. **Team server** — multi-repo routing, API keys/OIDC, shared central index; turns `serve` into a real deployment target.
3. **Scale backend** — LanceDB (ANN) `StorageBackend` for monorepos; parallel embedding workers.
4. **More query types** — code→similar-code, error-trace→code.
5. **Ecosystem** — VS Code extension over the SDK, GitHub Action to ship prebuilt indexes with releases.

## 11. Open questions for review

1. Name (§9) — **resolved: `codesift`**.
2. npm shape: unscoped `codesift` CLI + `@codesift/*` scoped packages — OK?
3. Node ≥ 20 / ESM-only baseline — OK?
4. Default `k` for MCP `search_code` (proposal: 8, compact format) — agents over-fetch otherwise.
5. Telemetry: proposal is **none** (OSS trust matters more than usage data) — confirm.
6. Eval benchmark repos — any preferred OSS repos to use as golden-set targets?

---

## 12. Strategic correction & future nuances (post-audit, 2026-06-13)

> This section is the output of a structured nuance audit (full detail in **`NUANCES.md`**;
> milestone-scoped implementation deltas in **`M0_ADDENDUM.md`** and **`M1_ADDENDUM.md`**, kept
> separate so the M0/M1 implementation work doesn't collide here). It **updates** the plan above.
> Where it conflicts with an earlier section, this section wins; superseded statements are called out.

### 12.1 Positioning correction — *subsume grep, don't complement it* (supersedes §3)

§3 frames codesift as *"a complement [to ripgrep], not a competitor."* That framing caps the product.
The goal is for codesift to be **undeniably better than grep** — *the only search tool an agent ever
reaches for.* The moment an agent must **choose** between codesift and its always-present, zero-config
built-in grep, codesift has already lost. So the thesis is **subsumption**:

> codesift must do **everything grep does, at least as well** — including literal/regex/exact-string
> match — *plus* semantic, behind one tool surface, so there is never a reason to keep grep wired in.

### 12.2 "Undeniable" as a measurable contract (new — gates v0.1)

Define superiority as a per-axis contract, proven head-to-head vs ripgrep on a pinned benchmark:

| Axis | Contract |
|---|---|
| Recall (exact) | If a string/identifier exists, codesift returns it. `recall@k = 1.0` on the exact-identifier + string-literal golden sets. **Any miss is a release blocker.** |
| Recall (concept) | NL→code recall@5 ≥ a real-embedding baseline. |
| Tokens | Median *tokens-to-resolution* ≤ ½ of ripgrep-only on the agent-task set. |
| Latency (common case) | Exact/identifier queries answer in single-digit ms and **never load a model**; cold-first-query competitive with `rg` cold. |
| Latency (concept) | Warm p50 < 150 ms; cold-first-query a *separately published* number. |
| Trust | Never confidently wrong: stale/branch-drift flagged; results deterministic; no secret leakage. |

### 12.3 New & amended goals (extends §2)

- **G8 — Grep subsumption.** A first-class literal/regex/exact primitive (`repo.grep`) over raw file
  bytes, exposed via CLI (`codesift grep`) and MCP (`grep_code`), with grep flag-parity
  (`-i -w -A/-B/-C -l -c`, include/exclude globs). Reframes the §2 references/call-graph non-goal:
  no semantic call graph, but **occurrence-level recall parity with grep is required**.
- **G9 — Token economics as a first-class, measured metric.** Tokens-to-resolution (TTR) vs ripgrep is
  the headline metric, measured in the eval harness, gating every retrieval change.
- **G10 — Query-intent routing.** Core classifies each query (literal/regex · identifier-exact · NL)
  and routes; identifier-exact queries skip embedding entirely.
- **G11 — Honest capability labelling.** The word "semantic"/"hybrid" is gated behind a real learned
  embedding provider. The fake `local-hash-v1` is **never** the published default (supersedes the
  optimism in §5.3 / README about a shipped semantic default).

### 12.4 Architecture additions

**§5.7 Latency contract & the cold-start problem (supersedes §5.5's single "p50 < 300 ms warm" target
and §5.6's "No separate daemon lifecycle").** Agents spawn `npx codesift mcp` per repo over stdio, so
there is **no resident model** — the "300 ms warm" number measures a state that never occurs. Replace
with three published numbers: (a) **cold-first-query** (the real agent path: spawn → first result),
(b) **warm-query** p50 < 150 ms, (c) **daemon-cold-start** (model+ext load, amortized once per machine).
Decision: a **persistent per-machine daemon** (one long-lived process, model + DB + prepared statements
resident, multiple indexes addressed by repo root) that stdio/HTTP MCP shims connect to over a socket;
the `npx codesift mcp` shim becomes a thin, fast-starting client. The daemon also owns background
incremental sync (pulls part of §5.6/M4 forward) and a multi-repo/workspace query.

**§5.8 Staged, model-free-first retrieval (amends §5.5).** Retrieval is not "always run both arms then
RRF." It is: (1) classify the query; (2) for literal/identifier queries, answer from FTS5 + symbols +
literal scan **without loading the embedding model**; (3) load the model lazily only for conceptual
queries or when lexical confidence is low; (4) fuse via RRF, with an **exact-match candidate set
(FTS-exact ∪ symbol-exact) UNION-ed into the pool independent of the vector top-k** so an exact match is
never truncated away; (5) push `lang`/`path`/`kind` into SQL predicates *before* truncation; (6) dedup
overlapping chunks; (7) optional reranker over top-N behind a latency budget. Vectors use a real
sqlite-vec **`vec0` virtual table** (not a blob-column `ORDER BY` scan), with a data-driven chunk-count
threshold above which ANN becomes mandatory.

**§5.9 Token-efficient result contract (new).** A single terse line format shared by `--compact` and
MCP (compact is the MCP default; never pretty-printed JSON): `id`, `path:Lstart-end`, symbol breadcrumb,
a **query-centered, token-bounded** snippet, and a 1-token match-reason tag (`=`/`~`/`+`) instead of a
raw float score. A working `read_chunk(id)` / `readRange` expand-on-demand loop backed by **stable
content-addressed ids**. A `maxTokens` budget on search (k becomes a ceiling). A single-best-answer mode
for identifier-exact queries.

**§5.10 Trust & safety (new).** Real staleness from `(mtime,size)` + git HEAD/branch (structured reason,
not a bool); schema-version migration gate on open; provider/dims guard → guided `--rebuild`;
`busy_timeout` + shadow-generation atomic swap for read-during-rebuild; secret-scan + redaction before
any cloud-embedding send; self-gitignored index; determinism guarantee. Telemetry: **none** (resolves
OQ#5), enforced by a network-egress CI test.

### 12.5 Revised roadmap notes

- **M2 is the make-or-break milestone** and absorbs the load-bearing subsumption work: real MCP
  transport + routing `instructions`; literal/regex `grep_code`; exact-identifier recall floor = 1.0;
  query routing; working `read_chunk` + token budget + dedup + terse format; `vec0` table;
  content-hash embedding cache; the daemon decision + zero-model fast-path. **The TTR + cold-latency
  eval is pulled in to M2** (not deferred to M6) so every retrieval change ships measured.
- **§10 post-MVP roadmap, re-ordered for the thesis:** (1) the **agent-loop integration** lever — tuned,
  eval-gated MCP `instructions` and a recipe to de-prioritize the built-in grep (this is where adoption
  is actually won); (2) reranking; (3) ANN scale backend (threshold set by M2 data); (4) team server;
  (5) more query types; (6) ecosystem. Reranking's latency cost is gated and measured, not assumed.
- **M6 ships a public head-to-head scorecard**, including a checked-in `losses.json` of queries where
  grep still wins — honesty is part of "undeniable."

### 12.6 New risks (extends §8)

| Risk | Mitigation |
|---|---|
| Per-spawn cold-start makes codesift categorically slower than grep on its best queries | Zero-model lexical/exact fast-path (single-digit ms) + persistent daemon; cold-first-query as a published, gated metric. |
| Shipping the fake `local-hash-v1` as "semantic" destroys trust and poisons the eval | Hard gate: never the published default; "semantic" wording gated behind a learned provider; honest "lexical search" until then. |
| Native-dep (`better-sqlite3`/`sqlite-vec`) install failure silently kills the MCP server | Lazy-load `sqlite-vec` so lexical survives; expanded CI matrix (musl/Alpine, Win-ARM) + clean-install smoke test asserting no source compile. |
| Secrets indexed and shipped to cloud embedders | Secret-scan + redaction pass; cloud path refuses without `--allow-secrets`; expanded default ignores. |
| Confidently-wrong stale/cross-branch results | Real staleness (mtime + git HEAD), structured reason, per-hit `stale`, agent self-heal via `index_status`. |
| The benchmark proves the wrong thing (recall-only, no grep baseline) | Head-to-head TTR + cold-latency vs ripgrep; query-type-balanced golden sets incl. exact-identifier; paired-delta CI gates. |

### 12.7 Resolved open questions (from §11)

- **OQ#4** (default `k` for MCP) → **budget-first**: unify default `k=8` in core as a *ceiling*; add a
  `maxTokens` budget; report `tokensReturned`.
- **OQ#5** (telemetry) → **none**, enforced by a network-egress CI test.
- Default local `index` / `search` / `sym` / `status` flows are expected to remain fully offline; any outbound network use on that path is treated as a regression.

### 12.8 M2 latency decisions recorded (2026-06-13)

**Measured M2 corpus.** The M2 benchmark now clones pinned OSS repos at fixed refs (`jshttp/cookie`,
`pallets/itsdangerous`, `sindresorhus/escape-string-regexp`) instead of local-only fixtures. Current
indexed sizes are small (8 / 74 / 162 chunks), so M2 proves the agent path and publishes the cold gap; it
is not a monorepo-scale vector benchmark.

**`vec0` / ANN crossover.** Decision: when a learned embedding provider becomes a default-supported path,
the vector arm moves off blob-column `ORDER BY vec_distance_cosine(...)` and onto sqlite-vec `vec0` for
all learned-vector indexes. Brute-force `vec0` is the v0.1 local backend through **50k chunks**. At
**100k chunks** (or earlier if the 50k synthetic warm vector p50 exceeds 150 ms), ANN becomes mandatory
before claiming semantic/vector support for that repo size. Until then, large repos may keep exact/lexical
search enabled while vector search is reported as degraded in `index_status`.

**Daemon timing.** Decision: the persistent daemon does **not** land in M2. M2 now measures the honest
stdio path (`codesift mcp` spawn → JSON-RPC initialize → first tool result) and records the cold latency
startup tax in `packages/eval/losses.json`; this is accepted for M2 because MCP clients are expected to
keep the stdio server alive, so the cost is paid once per repo/client session rather than once per
search. Warm in-process queries are already faster than `rg` on the M2 set. The daemon landed with the
M4 freshness/watch work as a local-socket stdio shim that shares a long-lived process and repo handles;
future M5/M6 work can extend that process with HTTP and learned-model residency.

### 12.9 M3 start recorded (2026-06-13)

First M3 implementation slice landed locally: structural chunk/symbol extraction for Go, Java, Ruby,
and Rust; heading-aware Markdown chunks; top-level key/section-aware JSON/YAML/TOML chunks; nested
`.gitignore` / `.codesiftignore` handling; default vendor/third-party ignores; generated/minified-source
flagging with search down-ranking; and oversized structural chunk splitting. This was intentionally a
pragmatic structural parser slice and not the final M3 sign-off.

### 12.10 M3 completed (2026-06-13)

M3 is signed off with an explicit parser-quality decision: do **not** add tree-sitter WASM yet. The
available path would add grammar packaging and install-surface risk before codesift has learned-vector
quality to justify it. Instead, M3 accepts hardened deterministic structural scanners for Go, Java, Ruby,
and Rust: C-style comment/string masking for brace languages, Ruby block balancing, nested parent
containers, duplicate-range suppression, and symbol extraction for modules/classes/types/interfaces/traits,
functions/methods, constants, and variables where sensible.

The proof gate is now checked in: local M3 fixture repos for Go, Java, Ruby, and Rust exercise
`search_code`, `find_symbol`, and `grep_code` through the eval harness; core M3 tests cover parser edge
cases, generated/minified down-ranking + public annotations, nested ignore behavior, Markdown/config
chunking, and oversized chunk distribution. Tree-sitter remains a future migration option, not an M3 open
item.
