export type {
  EmbeddingProvider,
  FindSymbolOptions,
  Range,
  Repo,
  RepoStatus,
  SearchHit,
  SearchOptions,
  StopWatching,
  SymbolDefinition,
  SymbolKind,
  SyncOptions,
  SyncResult,
  WatchOptions
} from './types.js'

export {
  DEFAULT_EMBEDDING_PROVIDER_ID,
  getDefaultEmbeddingProvider,
  getEmbeddingProvider,
  listEmbeddingProviders,
  registerEmbeddingProvider
} from './embedding.js'

export { SqliteRepo } from './repo.js'

import { SqliteRepo } from './repo.js'
import type { Repo } from './types.js'

export async function openRepo(root: string): Promise<Repo> {
  if (!root.trim()) {
    throw new Error('openRepo requires a repository path')
  }

  return new SqliteRepo(root)
}
