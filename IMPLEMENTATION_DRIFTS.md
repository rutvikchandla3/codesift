# Implementation drifts and incomplete areas

Snapshot: current repo state after M0 scaffold + M1 walking skeleton / final polish work.

## Executive summary

This repo is usable as a prototype, but it does not fully match the plan yet.

- **M0** is mostly complete in practice, but not complete by the strict PLAN exit criteria.
- **M1** is implemented in spirit, but several core pieces were simplified or substituted.

## M0 drifts from PLAN

### 1. npm name was not actually registered
PLAN says M0 includes name registration on npm.

Current state:
- `codesift` was chosen and used in package names
- npm availability was checked informally
- the name was **not actually registered/published/reserved**

Impact:
- M0 is not strictly complete by the PLAN exit criteria.

### 2. GitHub CI was scaffolded but not proven green remotely
PLAN says M0 exits with CI green.

Current state:
- `.github/workflows/ci.yml` exists
- local `pnpm build` / `pnpm test` were run
- the GitHub Actions matrix was **not verified in GitHub** as part of M0 completion

Impact:
- CI exists, but M0 did not fully prove the remote matrix.

### 3. Package scaffold was not publish-validated
Current state:
- workspace/packages exist
- build/test/type setup exists
- package publish/install flows were **not validated**

Impact:
- acceptable for a scaffold, but below a strict release-ready interpretation.

## M1 drifts from PLAN

### 1. Local embeddings are heuristic, not a real ONNX embedding model
PLAN intent:
- local-first semantic retrieval with a real embedding model

Current state:
- `packages/core/src/embedding.ts` implements `local-hash-v1`
- this is token hashing + stemming + trigram/synonym heuristics
- this is **not** a true ML embedding model

Impact:
- retrieval is semantic-ish, not true semantic embeddings
- quality will be more brittle than the PLAN target implies

### 2. Python chunking is not AST chunking
PLAN says M1 should have AST chunking for TS/JS and Python.

Current state:
- TS/JS uses the TypeScript compiler API
- Python uses regex + indentation-based structure extraction
- Python is **not** AST-based today

Impact:
- Python support is useful but below the planned fidelity.

### 3. TS/JS chunking does not use tree-sitter
PLAN architecture describes tree-sitter WASM.

Current state:
- TS/JS chunking uses the TypeScript compiler API
- this is a deliberate shortcut / substitution

Impact:
- workable for now, but it drifts from the planned parser architecture.

### 4. Storage schema is simpler than planned
PLAN storage describes:
- `files`
- `chunks`
- `chunks_fts`
- `vecs`
- `symbols`
- `meta`

Current state:
- `files`
- `chunks`
- `symbols`
- `meta`

Missing:
- **FTS5 table**
- separate **vector table**

Impact:
- current storage is a prototype layout, not the planned hybrid-search layout.

### 5. Retrieval is vector-only, not hybrid
PLAN retrieval describes:
- BM25 over lexical text
- vector KNN
- RRF fusion
- exact symbol boost
- SQL-native filters

Current state:
- vector-distance search only
- some hand-tuned ranking boosts/penalties
- symbol lookup exists separately via `sym`

Missing:
- **FTS5 / BM25**
- **RRF fusion**
- **exact symbol boost in ranking**
- **SQL-native path filtering**

Impact:
- current search works as a prototype but is materially simpler than the PLAN.

### 6. Ranking heuristics compensate for weak embeddings
Current state:
- code/symbol chunks are mildly favored
- docs/project-metadata files can be mildly penalized for code-focused queries

Impact:
- this improves results, but it is a heuristic patch rather than the planned retrieval architecture.

### 7. `sync()` is a rebuild, not true incremental indexing
PLAN later expects manifest-diff incremental freshness.

Current state:
- scanning happens each run
- chunk/symbol tables are cleared and rebuilt
- `removedFiles` is not a real deletion diff

Impact:
- simple and reliable for now, but not aligned with the planned freshness model.

### 8. `watch()` is still not implemented
PLAN has watch mode later, but current code still leaves it as a no-op.

Current state:
- `watch()` returns a no-op stop handler
- CLI still says watch is reserved for M4

Impact:
- expected for milestone sequencing, but still incomplete vs overall product plan.

### 9. Staleness reporting is not real yet
PLAN mentions stale flags / freshness checks.

Current state:
- `status().stale` is always `false`
- no mtime/hash freshness checks are exposed at query time

Impact:
- status is not yet trustworthy for freshness.

### 10. MCP package is still mostly scaffolded
Current state:
- tool names and router wiring exist
- search/symbol routing reuses core repo APIs
- transport/server behavior is still scaffold-level
- `read_chunk` is still placeholder text

Impact:
- the package exists, but this is not a complete MCP server implementation yet.

## Places where the repo is ahead in surface area

These are useful, but they do not erase the architectural drifts:

- `sym` command already exists
- symbol extraction already exists for TS/JS and Python
- CLI search has repo/lang/path filters
- end-to-end tests cover indexing/search/symbol flows on synthetic repos

## Honest status against PLAN

### M0
- **Practical status:** mostly done
- **Strict PLAN status:** not fully complete

### M1
- **Practical status:** useful walking skeleton / prototype
- **Strict PLAN status:** partially complete and drifted

## Biggest technical shortcuts

If only a few items matter most, these are the main ones:

1. heuristic local embedder instead of a real local embedding model
2. Python structural chunking instead of Python AST chunking
3. no FTS5 / BM25 / hybrid fusion yet
4. simplified storage schema
5. rebuild-style sync instead of true incremental indexing

## Recommended fix order

1. add real lexical search with FTS5
2. implement hybrid retrieval (BM25 + vector fusion)
3. add exact symbol boost in search ranking
4. replace / upgrade the local embedding provider
5. replace Python chunking with true AST chunking
6. move path filtering into SQL / retrieval pipeline
7. implement manifest-diff incremental sync
8. implement real MCP transport + `read_chunk`

## Additional drifts found in follow-up audit

These were not captured above. Not all of them are M0/M1 blockers, but they are real PLAN drift.

### 1. CLI search surface is still behind the PLAN contract
PLAN CLI/search surface includes:
- `--kind`
- `--compact`
- scored, breadcrumb-rich default output

Current state:
- `packages/cli/src/program.ts` search supports `--lang`, `--path`, and `--json`
- search does **not** support `--kind`
- search does **not** support `--compact`
- default hit formatting does **not** include score or parent breadcrumb

Impact:
- the CLI surface is still narrower than the planned user contract.

### 2. Core SDK does not yet expose the primitive needed for MCP `read_chunk`
PLAN MCP design expects a follow-up expansion flow from compact hit ids.

Current state:
- `@codesift/core` exposes `search`, `findSymbol`, `status`, and `watch`
- it does **not** expose a chunk lookup / expansion API by chunk id
- `@codesift/mcp` therefore cannot implement real `read_chunk` yet and falls back to placeholder text

Impact:
- this is more than an MCP transport gap; the core SDK contract is still missing a required read primitive.

### 3. MCP commands are scaffold-only in a stronger sense than the current note suggests
Current state:
- `packages/mcp/src/index.ts` has no real stdio MCP transport
- `packages/mcp/src/index.ts` has no real HTTP server
- `codesift mcp` / `codesift serve` print readiness text but do not start a usable long-running server
- `serve --token` accepts a bearer token option, but the token is not used anywhere

Impact:
- MCP is not just incomplete; the CLI surface currently suggests runtime behavior that does not exist yet.

### 4. Provider metadata is stored but not enforced
PLAN says provider/model/dims are recorded in the index and provider switches should force a guided rebuild.

Current state:
- provider id and dims are written into `meta`
- sync/search do **not** validate provider compatibility against an existing index
- switching provider implementations would not trigger a guided rebuild path

Impact:
- the provider lifecycle contract described in the PLAN is not implemented yet.

### 5. Eval package is still a scaffold, not a runnable harness
PLAN describes a real evaluation harness with:
- pinned benchmark repos
- golden query sets
- recall@k / MRR computation
- CI regression outputs

Current state:
- `packages/eval/src/index.ts` contains only manifest/result types and empty helpers
- there is no runner, dataset loader, benchmark manifest, or metrics pipeline

Impact:
- the repo has an eval package name and shell, but not the evaluation system the PLAN describes.

## Suggested interpretation going forward

Treat the current codebase as:
- a **working prototype** for M1 behavior
- **not yet** a faithful implementation of the PLAN architecture
- a reasonable base for completing true M1/M2 work
