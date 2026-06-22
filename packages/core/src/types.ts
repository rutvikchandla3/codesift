export const DEFAULT_SEARCH_K = 8

export type SymbolKind =
  | 'class'
  | 'constant'
  | 'enum'
  | 'file'
  | 'function'
  | 'interface'
  | 'method'
  | 'module'
  | 'namespace'
  | 'type'
  | 'variable'

export type EmbeddingRole = 'query' | 'document'

export interface Range {
  startLine: number
  endLine: number
}

export type SearchReasonTag = '=' | '~' | '+'

export type EdgeKind = 'ref' | 'call' | 'import' | 'implements' | 'extends'

export type EdgeResolution = 'import-resolved' | 'name-only'

export interface Edge {
  id?: number
  srcFile: string
  srcLine: number
  srcSymbol?: string
  dstName: string
  dstFile?: string
  edgeKind: EdgeKind
  resolution: EdgeResolution
  language?: string
}

export interface SymbolUsage {
  file: string
  range: Range
  line: number
  snippet: string
  language?: string
  /**
   * Honest provenance marker: usages are import-resolved or name-only, never type-resolved.
   */
  resolution: EdgeResolution
}

export interface SymbolNeighbor {
  name: string
  file: string
  range: Range
  kind: SymbolKind
  parent?: string
  language?: string
}

export interface SymbolRelations {
  /**
   * Top caller/reference sites for the resolved definition. These reuse the
   * persisted edge rows and stay honest about resolution confidence.
   */
  sites: EdgeResult[]
  /**
   * Nearby same-file symbols around the resolved definition for quick local context.
   */
  neighbors: SymbolNeighbor[]
  /**
   * Additional relation items omitted by the bounded read-side bundle.
   */
  omitted?: number
}

export interface ResultMetadata {
  notIndexed?: boolean
  emptyReason?: 'not_indexed' | 'no_definition' | 'no_edges'
  definitionCount?: number
  ambiguousDefCount?: number
  partialMatchCount?: number
  nameOnlyUnscoped?: number
  nameOnlyLimit?: number
}

export type ResultList<T> = T[] & {
  meta?: ResultMetadata
}

export interface SearchHit {
  id: string
  file: string
  range: Range
  score: number
  reason: SearchReasonTag
  snippet: string
  snippetRange: Range
  tokensReturned: number
  /**
   * Full enclosing-symbol source for an INLINED hit. The block's common leading
   * indentation is stripped (dedented) and runs of blank lines collapsed to one;
   * code is never reordered, dropped, or per-line trimmed. The MCP renderer
   * re-adds `NN | ` line-number prefixes so absolute location stays recoverable.
   * Absent on compact hits.
   */
  body?: string
  /**
   * Optional top-N usage sites for a DEFINITION hit. Supported only for
   * TS/JS + Python and resolved via imports/local bindings, not a type checker.
   */
  usages?: SymbolUsage[]
  /**
   * Bounded relation bundle for a confident definition hit. This is the same
   * persisted-edge payload used by find_symbol, attached only when budget allows.
   */
  relations?: SymbolRelations
  language?: string
  symbol?: string
  parent?: string
  kind?: SymbolKind
  generated?: boolean
  stale?: boolean
  /**
   * Set on the TOP hit only when an identifier-shaped query collides across this many
   * distinct definitions. single_best deliberately does NOT collapse such a lookup to
   * one result; instead it returns a small candidate set and flags the collision so
   * the caller disambiguates in the same call rather than trusting a silent winner.
   */
  ambiguousDefCount?: number
}

export interface GrepHit {
  file: string
  range: Range
  line: number
  column: number
  match: string
  snippet: string
  snippetRange?: Range
  language?: string
}

export interface SymbolDefinition {
  id: string
  name: string
  file: string
  range: Range
  kind: SymbolKind
  signature?: string
  parent?: string
  language?: string
  matchQuality?: 'exact' | 'partial'
  ambiguousDefCount?: number
  /**
   * Full enclosing-symbol source for the top exact match when body inlining is
   * enabled. Dedented and blank-collapsed, then capped like a search hit body
   * (see {@link SearchHit.body}). Present only on the top definition of an
   * unambiguous lookup so the caller resolves the identifier in one call. Absent
   * on compact/ambiguous rows.
   */
  body?: string
  /**
   * OPT-IN bounded relational context for the top exact match: top caller/ref
   * sites plus same-file neighbors. Present only when requested and only on the
   * top exact row of an unambiguous lookup.
   */
  relations?: SymbolRelations
}

export interface SearchOptions {
  k?: number
  lang?: string[]
  pathGlob?: string
  kind?: SymbolKind | SymbolKind[]
  maxTokens?: number
  singleBest?: boolean
  /**
   * Body-inlining policy. `'body'` inlines bodies wherever the budget allows;
   * `'sig'` never inlines (compact only); `undefined` is AUTO — inline rank-1
   * always, rank-2 only if within the score margin of rank-1.
   */
  context?: 'auto' | 'min' | 'sig' | 'body' | 'graph'
  /**
   * Attach a bounded relation bundle to a confident top definition. Undefined
   * means AUTO: enabled for single-best definition hits when budget allows.
   */
  withRelations?: boolean
  /**
   * Bundle top-N usage sites for the top DEFINITION hit when supported. Honest
   * scope: import-resolved/local only, currently TS/JS + Python.
   */
  withUsages?: boolean
  /**
   * OPT-IN reranker re-scoring of the fused candidates. Off by default; gated to
   * NL-concept-shaped queries and only active when a reranker is configured (via
   * `CODESIFT_RERANKER` env or `.codesift/config.json` `reranker`). RRF remains the
   * candidate generator — rerank only reorders the head. Fail-safe: any rerank
   * error falls back to the fused order. The default local path never enables it.
   */
  rerank?: boolean
}

export interface GrepOptions {
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

export interface FindSymbolOptions {
  kind?: SymbolKind | SymbolKind[]
  pathGlob?: string
  /**
   * Inline the verbatim enclosing-symbol body for the top exact match, so the
   * caller resolves an identifier in a SINGLE call (no follow-up read). Default
   * true. The body is attached only to the top match and only when the lookup is
   * unambiguous (≤3 exact rows); partial/fuzzy matches and broader collisions stay
   * compact. Capped like search bodies. Set false for a compact name→location list.
   */
  withBody?: boolean
  /**
   * OPT-IN bounded relational addendum for the top exact match: top caller/ref
   * sites plus same-file neighbors. Default false.
   */
  withCallers?: boolean
  /**
   * Approx output token budget used to decide whether default-on relations fit.
   */
  maxTokens?: number
  /**
   * Detail tier for the top exact definition. `sig` keeps the response compact
   * and skips body inlining; `body` is the default one-call mode.
   */
  detail?: 'sig' | 'body'
}

export interface FindEdgeOptions {
  /**
   * Target definition kind filter used while resolving the destination symbol.
   */
  kind?: SymbolKind | SymbolKind[]
  /**
   * Target definition path glob used for collision disambiguation, e.g. `src/schema/**`.
   */
  pathGlob?: string
  /**
   * Approx output token budget for the returned edge rows.
   */
  maxTokens?: number
  /**
   * Optional hard cap for relation rows before token budgeting.
   */
  maxResults?: number
}

export interface FindImportersOptions {
  /**
   * Approx output token budget for the returned importer rows.
   */
  maxTokens?: number
}

export interface ImpactOptions extends FindEdgeOptions {
  /**
   * Caller depth to traverse: 0=direct callers only, 1=callers of callers, etc.
   * Default 2.
   */
  depth?: number
  /**
   * Hard cap on returned graph nodes. Default 50.
   */
  maxNodes?: number
}

export interface EdgeResult {
  file: string
  range: Range
  line: number
  snippet: string
  srcSymbol?: string
  edgeKind: EdgeKind
  resolution: EdgeResolution
  language?: string
}

export interface ImpactNode extends EdgeResult {
  /**
   * Symbol name traversed at this node. Falls back to `top-level` when the edge
   * originates outside an enclosing symbol.
   */
  name: string
  depth: number
}

export interface ImpactResult {
  nodes: ImpactNode[]
  notIndexed?: boolean
  emptyReason?: ResultMetadata['emptyReason']
  impactTruncated?: boolean
  depthCapped?: boolean
  nodesCapped?: boolean
  depthLimit: number
  maxNodes: number
}

export interface ChangesetFileContext {
  file: string
  symbols: SymbolDefinition[]
  callers: EdgeResult[]
  importers: EdgeResult[]
  omitted?: number
  omittedLowerBound?: boolean
}

export interface ChangesetContextOptions {
  maxFiles?: number
  maxEdgesPerFile?: number
  maxTokens?: number
}

export interface ChangesetContextResult {
  files: ChangesetFileContext[]
  stale?: boolean
  truncated?: boolean
  notIndexed?: boolean
}

export interface SyncProgressEvent {
  phase: 'batch'
  batch: number
  totalBatches: number
  completedChunks: number
  totalChunks: number
}

export interface SyncOptions {
  rebuild?: boolean
  signal?: AbortSignal
  onProgress?: (event: SyncProgressEvent) => void
  /**
   * Permit a cloud (learned) provider's document embed when secret-shaped content is detected.
   * When false (the default), a detected secret aborts the sync; when true, the content is redacted
   * before it is sent. Ignored on the local provider path, which never performs network egress.
   */
  allowSecrets?: boolean
}

export interface RepoOptions {
  /**
   * Explicit embedding provider id. Highest precedence in resolution:
   * explicit `providerId` > `CODESIFT_EMBEDDING_PROVIDER` env > `.codesift/config.json` `provider`
   * > the built-in local default.
   */
  providerId?: string
}

export interface SyncResult {
  indexedFiles: number
  skippedFiles: number
  skippedSymlinks: number
  removedFiles: number
  durationMs: number
}

export type RepoSyncState = 'idle' | 'running' | 'completed' | 'failed' | 'aborted'

export interface RepoSyncStatus {
  state: RepoSyncState
  startedAt?: string
  completedAt?: string
  error?: string
  completedChunks?: number
  totalChunks?: number
}

export interface WatchOptions {
  debounceMs?: number
  signal?: AbortSignal
}

export type StopWatching = () => Promise<void>

export interface VectorSearchStatus {
  available: boolean
  state: 'lazy' | 'ready' | 'unavailable'
  reason?: 'native-dependency-unavailable'
  message?: string
  detail?: string
}

export interface RepoStatusProvider {
  id: string
  model?: string
  modelVersion?: string
  dims?: number
}

export type RepoStaleReasonCode = 'file_added' | 'file_modified' | 'file_removed' | 'git_branch_changed' | 'git_head_changed'

export interface RepoStaleReason {
  code: RepoStaleReasonCode
  message: string
  count?: number
  files?: string[]
  indexed?: string
  current?: string
}

export interface IndexCompatibilitySnapshot {
  schemaVersion?: string
  providerId?: string
  providerDims?: number
  modelVersion?: string
}

export interface IndexCompatibilityStatus {
  ok: boolean
  code?: 'schema_version_mismatch' | 'provider_mismatch' | 'provider_dims_mismatch' | 'model_version_mismatch'
  message?: string
  expected?: IndexCompatibilitySnapshot
  actual?: IndexCompatibilitySnapshot
}

export interface RepoStatus {
  root: string
  indexPath: string
  indexExists: boolean
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

export interface ReadChunkOptions {
  contextLines?: number
}

export interface ReadRangeOptions {
  contextLines?: number
}

export interface Repo {
  readonly root: string
  sync(options?: SyncOptions): Promise<SyncResult>
  search(query: string, options?: SearchOptions): Promise<ResultList<SearchHit>>
  grep(pattern: string, options?: GrepOptions): Promise<ResultList<GrepHit>>
  findSymbol(name: string, options?: FindSymbolOptions): Promise<ResultList<SymbolDefinition>>
  findCallers(name: string, options?: FindEdgeOptions): Promise<ResultList<EdgeResult>>
  impact(name: string, options?: ImpactOptions): Promise<ImpactResult>
  findReferences(name: string, options?: FindEdgeOptions): Promise<ResultList<EdgeResult>>
  findImplementers(name: string, options?: FindEdgeOptions): Promise<ResultList<EdgeResult>>
  findImporters(file: string, options?: FindImportersOptions): Promise<ResultList<EdgeResult>>
  changesetContext(files: string[], options?: ChangesetContextOptions): Promise<ChangesetContextResult>
  readChunk(id: string, options?: ReadChunkOptions): Promise<string>
  readRange(file: string, startLine: number, endLine: number, options?: ReadRangeOptions): Promise<string>
  status(): Promise<RepoStatus>
  watch(options?: WatchOptions): Promise<StopWatching>
  close(): Promise<void>
}

export interface EmbeddingBatchOptions {
  role: EmbeddingRole
}

export interface EmbeddingProvider {
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

export interface RerankResult {
  /** Index into the `documents` array passed to {@link Reranker.rerank}. */
  index: number
  /** Relevance score; higher is more relevant. Magnitude is provider-specific. */
  score: number
}

export interface RerankOptions {
  /** Keep only the top-K results (by score). Undefined returns all scored documents. */
  topK?: number
  signal?: AbortSignal
}

/**
 * A relevance reranker, symmetric with {@link EmbeddingProvider}. Always opt-in
 * (never the default), selected explicitly via `CODESIFT_RERANKER` or
 * `.codesift/config.json` `reranker`. Cloud providers perform network I/O only
 * inside `rerank`, never at import/registration.
 */
export interface Reranker {
  id: string
  model?: string
  /**
   * Score `documents` against `query`, returning `{ index, score }` for the
   * matched documents (higher score = more relevant). Order is not guaranteed.
   */
  rerank(query: string, documents: string[], options?: RerankOptions): Promise<RerankResult[]>
}
