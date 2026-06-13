import { resolve } from 'node:path'

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

const embeddingProviders = new Map<string, EmbeddingProvider>()

class ScaffoldRepo implements Repo {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  async sync(_options?: SyncOptions): Promise<SyncResult> {
    return {
      indexedFiles: 0,
      skippedFiles: 0,
      removedFiles: 0,
      durationMs: 0
    }
  }

  async search(_query: string, _options?: SearchOptions): Promise<SearchHit[]> {
    return []
  }

  async findSymbol(_name: string, _options?: FindSymbolOptions): Promise<SymbolDefinition[]> {
    return []
  }

  async status(): Promise<RepoStatus> {
    return {
      root: this.root,
      indexPath: resolve(this.root, '.codesift', 'index.db'),
      indexed: false,
      stale: false,
      chunkCount: 0,
      symbolCount: 0,
      provider: null
    }
  }

  async watch(_options?: WatchOptions): Promise<StopWatching> {
    return async () => undefined
  }
}

export async function openRepo(root: string): Promise<Repo> {
  if (!root.trim()) {
    throw new Error('openRepo requires a repository path')
  }

  return new ScaffoldRepo(root)
}

export function registerEmbeddingProvider(provider: EmbeddingProvider): void {
  if (!provider.id.trim()) {
    throw new Error('Embedding provider id is required')
  }

  if (provider.dims <= 0) {
    throw new Error('Embedding provider dims must be greater than zero')
  }

  if (provider.maxTokens <= 0) {
    throw new Error('Embedding provider maxTokens must be greater than zero')
  }

  if (embeddingProviders.has(provider.id)) {
    throw new Error(`Embedding provider already registered: ${provider.id}`)
  }

  embeddingProviders.set(provider.id, provider)
}

export function getEmbeddingProvider(id: string): EmbeddingProvider | undefined {
  return embeddingProviders.get(id)
}

export function listEmbeddingProviders(): EmbeddingProvider[] {
  return [...embeddingProviders.values()]
}
