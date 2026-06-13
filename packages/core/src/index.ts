export type {
  EmbeddingBatchOptions,
  EmbeddingProvider,
  EmbeddingRole,
  FindSymbolOptions,
  IndexCompatibilitySnapshot,
  IndexCompatibilityStatus,
  Range,
  ReadChunkOptions,
  ReadRangeOptions,
  Repo,
  RepoStatus,
  RepoStatusProvider,
  SearchHit,
  SearchOptions,
  StopWatching,
  SymbolDefinition,
  SymbolKind,
  SyncOptions,
  SyncProgressEvent,
  SyncResult,
  VectorSearchStatus,
  WatchOptions
} from './types.js'

export { DEFAULT_SEARCH_K } from './types.js'

export {
  DEFAULT_EMBEDDING_PROVIDER_ID,
  LOCAL_HASH_EMBEDDING_PROVIDER_ID,
  getDefaultEmbeddingProvider,
  getDefaultEmbeddingProviderId,
  getEmbeddingProvider,
  isLearnedEmbeddingProvider,
  listEmbeddingProviders,
  registerEmbeddingProvider
} from './embedding.js'

export { IndexCompatibilityError, SqliteRepo, setVectorExtensionLoaderForTests } from './repo.js'

import { SqliteRepo } from './repo.js'
import type { Repo } from './types.js'

export async function openRepo(root: string): Promise<Repo> {
  if (!root.trim()) {
    throw new Error('openRepo requires a repository path')
  }

  const repo = new SqliteRepo(root)
  await repo.initialize()
  return repo
}
