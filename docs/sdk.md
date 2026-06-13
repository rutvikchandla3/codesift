# `@codesift/core` SDK

Local-first lexical code search as a library. The SDK is the same engine that
backs the `codesift` CLI and the `@codesift/mcp` server — one TypeScript core,
no hidden services.

> **v0.1 public API surface is frozen.** Everything documented on this page is
> re-exported from `@codesift/core` (`packages/core/src/index.ts`) and is
> covered by `packages/core/test/sdk-quickstart.test.ts`, which executes the
> quickstart below against a real temp repo. Additive changes (new optional
> options, new exports) are allowed in later minors; renames and removals are
> breaking and gated behind a major.

## Trust posture

- **Local and offline by default.** Opening a repo, syncing, searching,
  grepping, finding symbols, reading chunks, and `status()` make **zero network
  calls**. The default embedding path is purely on-device.
- **Telemetry: none.**
- The `.codesift/` index directory self-installs a local `.gitignore` with `*`
  on first open, so the index never appears in `git status`.

Cloud embedding providers (Voyage, OpenAI) are opt-in and only ever reach the
network when an explicitly-configured learned provider's `embedBatch` runs,
after a secret scan. Switching to a learned provider requires reindexing with
`--rebuild`. See the CLI `config` command for that flow; this page documents the
default local path only.

## Install

```bash
pnpm add @codesift/core
```

## Quickstart

```ts
import { openRepo } from '@codesift/core'

// 1. Open a repository. The index lives under `<root>/.codesift/`.
const repo = await openRepo('/path/to/repo')

// 2. Build (or incrementally refresh) the index. Cheap to call repeatedly —
//    only changed, added, and removed files are reprocessed.
const sync = await repo.sync()
console.log(`indexed ${sync.indexedFiles} files in ${sync.durationMs}ms`)

// 3. Concept / behavior search. Returns compact, token-budgeted hits.
const hits = await repo.search('validate jwt tokens before requests', { k: 5 })
for (const hit of hits) {
  console.log(`${hit.file}:${hit.range.startLine}  (score ${hit.score})`)
  console.log(hit.snippet)
}

// 4. Read the full source behind a hit, using its stable id.
if (hits[0]) {
  const source = await repo.readChunk(hits[0].id)
  console.log(source)
}

// 5. Exact-string / regex grep, when you already know the literal.
const grepHits = await repo.grep('TokenVerifier', { pathGlob: 'src/**', contextLines: 1 })

// 6. Jump to a definition by identifier.
const symbols = await repo.findSymbol('verifyJwtToken')
console.log(symbols[0]?.file, symbols[0]?.kind)

// 7. Read an explicit line range from a file.
const range = await repo.readRange('src/auth/jwt.ts', 1, 20, { contextLines: 2 })

// 8. Inspect index freshness, provider, and vector-search mode.
const status = await repo.status()
console.log(status.indexed, status.stale, status.chunkCount, status.provider?.id)
```

### Routing policy

Pick the tool that matches what you already know:

- `findSymbol(name)` — you have an identifier or want a definition.
- `grep(pattern, opts)` — you have an exact string or a regex.
- `search(query, opts)` — you have a behavior or concept, not a literal.

`search` is compact by default; pass `maxTokens` to enforce a strict context
budget.

## API reference

### `openRepo(root, options?): Promise<Repo>`

Opens (and lazily initializes) a repository at the absolute or relative `root`
path, returning a `Repo` handle. Throws if `root` is empty/whitespace. No
network I/O on the default local provider.

```ts
const repo = await openRepo('/path/to/repo')                 // local default provider
const cloud = await openRepo('/path/to/repo', { providerId: 'voyage-code-3' })
```

`RepoOptions.providerId` is optional. Provider resolution precedence:
`options.providerId` > `CODESIFT_EMBEDDING_PROVIDER` env > `.codesift/config.json`
`provider` > the built-in local default. The id must be a registered provider
(`listEmbeddingProviders()`); cloud providers (`voyage-code-3`,
`openai-text-embedding-3-small`) are registered but read their API key lazily
and only egress when an embed is actually performed.

### `Repo`

```ts
interface Repo {
  readonly root: string
  sync(options?: SyncOptions): Promise<SyncResult>
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>
  grep(pattern: string, options?: GrepOptions): Promise<GrepHit[]>
  findSymbol(name: string, options?: FindSymbolOptions): Promise<SymbolDefinition[]>
  readChunk(id: string, options?: ReadChunkOptions): Promise<string>
  readRange(file: string, startLine: number, endLine: number, options?: ReadRangeOptions): Promise<string>
  status(): Promise<RepoStatus>
  watch(options?: WatchOptions): Promise<StopWatching>
}
```

#### `repo.sync(options?)`

Incrementally indexes the repository: scans for changed/added/removed files,
re-chunks them, and updates the index via an atomic shadow-DB swap (a failed
rebuild leaves the previous index readable). Idempotent and cheap on a clean
tree.

```ts
interface SyncOptions {
  rebuild?: boolean // full rebuild instead of incremental
  signal?: AbortSignal
  onProgress?: (event: SyncProgressEvent) => void
}

interface SyncResult {
  indexedFiles: number
  skippedFiles: number
  skippedSymlinks: number
  removedFiles: number
  durationMs: number
}
```

`--rebuild` (the `rebuild: true` option) is the path you take when switching
embedding providers; it re-embeds every chunk under the new provider.

#### `repo.search(query, options?)`

Concept/behavior search. Returns `SearchHit[]` ordered best-first, token-budgeted
and overlap-deduped.

```ts
interface SearchOptions {
  k?: number                       // max hits (default DEFAULT_SEARCH_K = 8)
  lang?: string[]                  // restrict to languages, e.g. ['typescript']
  pathGlob?: string                // restrict to a path glob, e.g. 'src/**'
  kind?: SymbolKind | SymbolKind[] // restrict to symbol kinds
  maxTokens?: number               // strict token budget for the returned set
  singleBest?: boolean             // collapse to the single best identifier answer
}

interface SearchHit {
  id: string              // stable id, e.g. 'src/auth/jwt.ts:1-6@<64-hex>'
  file: string            // repo-relative path
  range: Range            // { startLine, endLine } of the chunk
  score: number
  reason: '=' | '~' | '+' // exact / fuzzy / supplemental
  snippet: string         // query-centered excerpt
  snippetRange: Range
  tokensReturned: number
  language?: string
  symbol?: string
  parent?: string
  kind?: SymbolKind
  generated?: boolean     // true for generated/minified sources (down-ranked)
  stale?: boolean         // true if the underlying file drifted since indexing
}

interface Range {
  startLine: number
  endLine: number
}
```

The `id` on each `SearchHit` is stable across syncs (as long as the chunk's
content is unchanged) and is what you pass to `readChunk`.

#### `repo.grep(pattern, options?)`

Literal / regex grep over indexed files.

```ts
interface GrepOptions {
  regex?: boolean
  ignoreCase?: boolean
  wholeWord?: boolean
  multiline?: boolean
  lang?: string[]
  pathGlob?: string
  contextLines?: number
  beforeContextLines?: number
  afterContextLines?: number
  maxMatches?: number
}

interface GrepHit {
  file: string
  range: Range
  line: number
  column: number
  match: string
  snippet: string
  language?: string
}
```

#### `repo.findSymbol(name, options?)`

Resolves a definition by identifier.

```ts
interface FindSymbolOptions {
  kind?: SymbolKind | SymbolKind[]
  pathGlob?: string
}

interface SymbolDefinition {
  id: string
  name: string
  file: string
  range: Range
  kind: SymbolKind
  signature?: string
  parent?: string
  language?: string
}
```

#### `repo.readChunk(id, options?)`

Reads the full source for a chunk id (e.g. one from a `SearchHit.id`) directly
from disk.

```ts
interface ReadChunkOptions {
  contextLines?: number
}
```

#### `repo.readRange(file, startLine, endLine, options?)`

Reads an explicit 1-based, inclusive line range from a repo-relative file path.

```ts
interface ReadRangeOptions {
  contextLines?: number
}
```

#### `repo.status()`

Returns index freshness, provider, sync crash-state, counts, and vector-search
mode.

```ts
interface RepoStatus {
  root: string
  indexPath: string
  indexed: boolean
  stale: boolean
  staleReasons?: RepoStaleReason[]
  sync: RepoSyncStatus
  chunkCount: number
  symbolCount: number
  generatedFileCount: number
  generatedChunkCount: number
  indexGeneration: number
  provider: RepoStatusProvider | null
  compatibility: IndexCompatibilityStatus
  vectorSearch: VectorSearchStatus
}
```

#### `repo.watch(options?)`

Starts a native `fs.watch`-based watcher (with a safety poll fallback) that
refreshes the index through the same incremental path. Returns a `StopWatching`
function — call and await it to tear the watcher down.

```ts
interface WatchOptions {
  debounceMs?: number
  signal?: AbortSignal
}

type StopWatching = () => Promise<void>
```

```ts
const stop = await repo.watch({ debounceMs: 100 })
// ... edits flow into the index automatically ...
await stop()
```

### Embedding providers

The default local path needs no provider configuration. To register a custom
provider (for tests or a bespoke learned backend), implement `EmbeddingProvider`
and register it before opening the repo:

```ts
import { registerEmbeddingProvider } from '@codesift/core'
import type { EmbeddingProvider } from '@codesift/core'

const provider: EmbeddingProvider = {
  id: 'my-provider',
  dims: 8,
  maxTokens: 8192,
  isLearned: true,
  async embedBatch(texts, options) {
    // options.role is 'query' or 'document'
    return texts.map(() => new Float32Array(8))
  }
}

registerEmbeddingProvider(provider)
```

```ts
interface EmbeddingProvider {
  id: string
  dims: number
  maxTokens: number
  maxBatch?: number
  maxBatchTokens?: number
  model?: string
  modelVersion?: string
  isLearned?: boolean
  embedBatch(texts: string[], options: EmbeddingBatchOptions, signal?: AbortSignal): Promise<Float32Array[]>
}

interface EmbeddingBatchOptions {
  role: 'query' | 'document'
}
```

Provider registry helpers also exported from `@codesift/core`:
`getEmbeddingProvider`, `getDefaultEmbeddingProvider`,
`getDefaultEmbeddingProviderId`, `listEmbeddingProviders`,
`isLearnedEmbeddingProvider`, plus the ids `DEFAULT_EMBEDDING_PROVIDER_ID` and
`LOCAL_HASH_EMBEDDING_PROVIDER_ID`.

### Errors

`IndexCompatibilityError` is thrown when the on-disk index was built with an
incompatible provider/dimensions/schema/model — for example after switching
providers without `sync({ rebuild: true })`. Catch it to surface guided-rebuild
messaging.

## Generated API reference

A full typedoc reference is generated into `docs/api/` from the frozen public
entry point:

```bash
pnpm run docs
```
