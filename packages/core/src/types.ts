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

export interface SearchHit {
  id: string
  file: string
  range: Range
  score: number
  reason: SearchReasonTag
  snippet: string
  snippetRange: Range
  tokensReturned: number
  language?: string
  symbol?: string
  kind?: SymbolKind
  stale?: boolean
}

export interface GrepHit {
  file: string
  range: Range
  line: number
  column: number
  match: string
  snippet: string
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
}

export interface SearchOptions {
  k?: number
  lang?: string[]
  pathGlob?: string
  kind?: SymbolKind | SymbolKind[]
  maxTokens?: number
  singleBest?: boolean
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
}

export interface SyncResult {
  indexedFiles: number
  skippedFiles: number
  skippedSymlinks: number
  removedFiles: number
  durationMs: number
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
  indexed: boolean
  stale: boolean
  chunkCount: number
  symbolCount: number
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
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>
  grep(pattern: string, options?: GrepOptions): Promise<GrepHit[]>
  findSymbol(name: string, options?: FindSymbolOptions): Promise<SymbolDefinition[]>
  readChunk(id: string, options?: ReadChunkOptions): Promise<string>
  readRange(file: string, startLine: number, endLine: number, options?: ReadRangeOptions): Promise<string>
  status(): Promise<RepoStatus>
  watch(options?: WatchOptions): Promise<StopWatching>
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
