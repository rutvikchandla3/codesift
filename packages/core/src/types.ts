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

export interface Range {
  startLine: number
  endLine: number
}

export interface SearchHit {
  id: string
  file: string
  range: Range
  score: number
  snippet: string
  language?: string
  symbol?: string
  kind?: SymbolKind
  stale?: boolean
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
}

export interface FindSymbolOptions {
  kind?: SymbolKind | SymbolKind[]
  pathGlob?: string
}

export interface SyncOptions {
  rebuild?: boolean
  signal?: AbortSignal
}

export interface SyncResult {
  indexedFiles: number
  skippedFiles: number
  removedFiles: number
  durationMs: number
}

export interface WatchOptions {
  debounceMs?: number
  signal?: AbortSignal
}

export type StopWatching = () => Promise<void>

export interface RepoStatus {
  root: string
  indexPath: string
  indexed: boolean
  stale: boolean
  chunkCount: number
  symbolCount: number
  provider: {
    id: string
    model?: string
    dims?: number
  } | null
}

export interface Repo {
  readonly root: string
  sync(options?: SyncOptions): Promise<SyncResult>
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>
  findSymbol(name: string, options?: FindSymbolOptions): Promise<SymbolDefinition[]>
  status(): Promise<RepoStatus>
  watch(options?: WatchOptions): Promise<StopWatching>
}

export interface EmbeddingProvider {
  id: string
  dims: number
  maxTokens: number
  embedBatch(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
}
