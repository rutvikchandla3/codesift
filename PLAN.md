# codesift — Plan

> Chosen name: **codesift**. See [§9 Naming](#9-naming) for the final comparison and npm availability check.

Hybrid (lexical + semantic) code search for repositories, shipped as one TypeScript core with three thin interfaces: a **CLI** for humans, an **SDK** for programs, and an **MCP server** for AI agents. Open source, MIT.

**Status**: M1 walking skeleton implemented and now in final polish before sign-off.

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
  → chunk: AST (tree-sitter, 6 langs) | fallback line-windows (others)
  → extract symbols (defs: name, kind, signature, range, parent)
  → build embedding text: path + symbol breadcrumb + leading comment + code
  → embedBatch via provider (local ONNX default)
  → store chunks + vectors + FTS rows + symbols + file manifest  (one SQLite transaction per file batch)
```

- **Chunking**: top-level functions/classes/methods become chunks; oversized nodes split at child boundaries with overlap; tiny siblings merged. Target 256–512 tokens/chunk. Each chunk carries file, range, language, symbol name/kind/parent. Fallback: ~60-line windows, 15-line overlap.
- **tree-sitter via WASM** (`web-tree-sitter`): no node-gyp/native build pain across platforms; parsing speed is not the bottleneck (embedding is). Grammars for the 6 launch languages bundled as `.wasm` lazy-loaded.
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
- `--watch`: chokidar with 500 ms debounce, batched through the same incremental path. No separate daemon lifecycle — it's the foreground process.
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
| Native dep pain (`better-sqlite3`, `sqlite-vec` prebuilds) | Both ship prebuilt binaries; CI matrix on mac/linux/win catches breakage; tree-sitter is WASM so it's not a third native dep. |
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
