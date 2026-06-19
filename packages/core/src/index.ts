export type {
  EmbeddingBatchOptions,
  EmbeddingProvider,
  EmbeddingRole,
  FindSymbolOptions,
  GrepHit,
  GrepOptions,
  IndexCompatibilitySnapshot,
  IndexCompatibilityStatus,
  Range,
  ReadChunkOptions,
  ReadRangeOptions,
  RerankOptions,
  RerankResult,
  Reranker,
  Repo,
  RepoOptions,
  RepoStaleReason,
  RepoStaleReasonCode,
  RepoStatus,
  RepoStatusProvider,
  RepoSyncState,
  RepoSyncStatus,
  SearchHit,
  SearchOptions,
  SearchReasonTag,
  StopWatching,
  SymbolDefinition,
  SymbolKind,
  SymbolUsage,
  SyncOptions,
  SyncProgressEvent,
  SyncResult,
  VectorSearchStatus,
  WatchOptions
} from './types.js'

export { DEFAULT_SEARCH_K } from './types.js'

export {
  CLOUD_EMBEDDING_PROVIDER_IDS,
  DEFAULT_EMBEDDING_PROVIDER_ID,
  LOCAL_HASH_EMBEDDING_PROVIDER_ID,
  getDefaultEmbeddingProvider,
  getDefaultEmbeddingProviderId,
  getEmbeddingProvider,
  isCloudEmbeddingProvider,
  isLearnedEmbeddingProvider,
  listEmbeddingProviders,
  registerCloudEmbeddingProviders,
  registerEmbeddingProvider
} from './embedding.js'

export {
  FIXTURE_RERANKER_ID,
  getReranker,
  listRerankers,
  registerCloudRerankers,
  registerFixtureReranker,
  registerReranker,
  resolveReranker
} from './reranker.js'

export { OpenAIEmbeddingProvider, OPENAI_EMBEDDING_PROVIDER_ID } from './providers/openai.js'
export { VoyageEmbeddingProvider, VOYAGE_EMBEDDING_PROVIDER_ID } from './providers/voyage.js'
export { VoyageReranker, VOYAGE_RERANK_PROVIDER_ID } from './providers/voyage-rerank.js'

export {
  prepareForCloud,
  redactSecrets,
  scanSecrets,
  type PrepareForCloudOptions,
  type SecretFinding,
  type SecretKind
} from './secret-scan.js'

export {
  CONFIG_KEYS,
  getConfigPath,
  isConfigKey,
  readConfig,
  setConfigValue,
  writeConfig,
  type CodesiftConfig,
  type CodesiftConfigKey
} from './config.js'

export { IndexCompatibilityError, SqliteRepo, setVectorExtensionLoaderForTests } from './repo.js'

import { SqliteRepo } from './repo.js'
import type { Repo, RepoOptions } from './types.js'

export async function openRepo(root: string, options?: RepoOptions): Promise<Repo> {
  if (!root.trim()) {
    throw new Error('openRepo requires a repository path')
  }

  const repo = new SqliteRepo(root, options)
  await repo.initialize()
  return repo
}
