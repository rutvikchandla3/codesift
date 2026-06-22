import { createHash } from 'node:crypto'
import ts from 'typescript'
import { existsSync, watch as watchFs, type FSWatcher } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix as pathPosix, resolve } from 'node:path'

import Database from 'better-sqlite3'
import { minimatch } from 'minimatch'
import * as sqliteVec from 'sqlite-vec'

import { buildChunks, getCachedTypeScriptSourceFile, maskCStyleSyntax, type ChunkRecord } from './chunking.js'
import { readConfig } from './config.js'
import { DEFAULT_EMBEDDING_PROVIDER_ID, expandTermToOrGroup, getEmbeddingProvider, isCloudEmbeddingProvider, isLearnedEmbeddingProvider } from './embedding.js'
import { isCodeLanguage, isDocumentationLanguage, isGoLike, isJavaLike, isPythonLike, isRubyLike, isRustLike, isTypeScriptLike } from './languages.js'
import { resolveReranker } from './reranker.js'
import { scanRepository, scanRepositoryManifest, type ScannedFile } from './scan.js'
import { prepareForCloud } from './secret-scan.js'
import {
  DEFAULT_SEARCH_K,
  type ChangesetContextOptions,
  type ChangesetContextResult,
  type ChangesetFileContext,
  type Edge,
  type EdgeResult,
  type EmbeddingProvider,
  type FindEdgeOptions,
  type FindImportersOptions,
  type FindSymbolOptions,
  type GrepHit,
  type GrepOptions,
  type ImpactNode,
  type ImpactOptions,
  type ImpactResult,
  type IndexCompatibilitySnapshot,
  type IndexCompatibilityStatus,
  type ReadChunkOptions,
  type ReadRangeOptions,
  type Repo,
  type RepoOptions,
  type RepoStaleReason,
  type RepoStatus,
  type RepoSyncStatus,
  type ResultList,
  type ResultMetadata,
  type RerankResult,
  type SearchHit,
  type SearchOptions,
  type SearchReasonTag,
  type StopWatching,
  type SymbolDefinition,
  type SymbolKind,
  type SymbolNeighbor,
  type SymbolRelations,
  type SymbolUsage,
  type SyncOptions,
  type SyncResult,
  type VectorSearchStatus,
  type WatchOptions
} from './types.js'

interface ChunkRow {
  id: string
  file_path: string
  start_line: number
  end_line: number
  snippet: string
  language: string | null
  symbol: string | null
  kind: SymbolKind | null
  parent: string | null
  signature: string | null
  generated: number | null
}

interface ChunkLocationRow {
  file_path: string
  start_line: number
  end_line: number
}

interface RepoCountRow {
  chunk_count: number
  symbol_count: number
  generated_file_count: number
  generated_chunk_count: number
}

interface TableInfoRow {
  name: string
}

interface IndexedChunkRecord extends ChunkRecord {
  id: string
}

interface SymbolRow {
  id: number
  name: string
  file_path: string
  start_line: number
  end_line: number
  kind: SymbolKind
  signature: string | null
  parent: string | null
  language: string | null
}

interface RankedChunkRow {
  row: ChunkRow
  score: number
  reasons: Set<SearchReasonTag>
}

interface SourceSymbolRange {
  startLine: number
  endLine: number
  symbol?: string
  kind?: SymbolKind | null
}

interface EdgeUsageRow {
  id: number
  src_file: string
  src_line: number
  language: string | null
  resolution: Edge['resolution']
}

interface EdgeResultRow {
  id: number
  src_file: string
  src_line: number
  src_symbol: string | null
  edge_kind: Edge['edgeKind']
  resolution: Edge['resolution']
  language: string | null
}

interface ImpactNodeRow extends EdgeResultRow {
  name: string
  depth: number
}

interface EdgeBinding {
  dstName: string
  dstFile?: string
  resolution: Edge['resolution']
}

interface DefinitionEdgeTarget {
  names: string[]
  resolutionMode: Edge['resolution']
  file?: string
}

interface DefinitionEdgeQueryStats {
  nameOnlyUnscoped?: number
}

interface DefinitionEdgeSelectOptions {
  limit?: number
  nameOnlyLimit?: number
  stats?: DefinitionEdgeQueryStats
}

interface ReadRowsResult<T> {
  items: T[]
  tokenTruncated: boolean
  readFailures: number
}

interface IndexedFileRow {
  path: string
  language: string
  hash: string
  size: number
  mtime: number
  generated: number
}

type StoredEmbedding = Float32Array | Buffer

interface EmbeddedChunkRecord {
  row: IndexedChunkRecord
  embedding: StoredEmbedding
}

interface EmbeddingCacheKey {
  providerId: string
  providerDims: number
  modelVersion: string
  contentHash: string
}

interface EmbeddingCacheRow {
  content_hash: string
  embedding: Buffer
}

interface GitSnapshot {
  branch: string
  head: string
}

interface IndexFreshnessStatus {
  stale: boolean
  reasons: RepoStaleReason[]
}

interface SyncDiff {
  changedFiles: ScannedFile[]
  touchedFiles: ScannedFile[]
  removedPaths: string[]
}

interface SyncApplyContext {
  diff: SyncDiff
  embeddedChunks: EmbeddedChunkRecord[]
  provider: {
    id: string
    dims: number
    modelVersion: string
  }
  previousGeneration: number
  gitSnapshot: GitSnapshot | null
  syncStartedAt: string
  completedAt: string
}

const SCHEMA_VERSION = '8'
const DEFAULT_RRF_K = 60
const DEFAULT_VECTOR_LIMIT = 50
const DEFAULT_PATH_FILTERED_LIMIT = 200
const DEFAULT_SNIPPET_TOKEN_BUDGET = 48
const DEFAULT_SNIPPET_CONTEXT_LINES = 0
const DEFAULT_SNIPPET_LINE_CHAR_LIMIT = 40
const SEARCH_HIT_TOKEN_OVERHEAD = 12
const INLINE_BODY_MAX_TOKENS = 400
const INLINE_BODY_MAX_LINES = 50
// Approximate token cost of the `NN | ` line-number prefix the MCP renderer
// prepends to every emitted body/snippet line. Folding it into the token math
// keeps the budget honest about what the agent actually receives.
const PREFIX_TOKEN_COST = 2
// The MCP compact (no-body) snippet renderer caps at this many lines; the token
// estimate mirrors it so prefix cost is not over-counted for compact hits.
const COMPACT_SNIPPET_MAX_LINES = 4
const INLINE_BODY_TRUNCATION_MARKER = (locator: string) => `… (truncated — read_chunk ${locator} for full)`
const INLINE_RANK2_SCORE_MARGIN = 0.6
// Below this lexical-row count, an over-constrained FTS query is progressively
// relaxed (drop-rarest term, then full OR) so a concept phrased with a word the
// target lacks still recalls it. ~3 keeps a handful of candidates for fusion.
const MIN_RELAXATION_ROWS = 3
// find_symbol inlines the top match's body only when the lookup is unambiguous.
// Above this many exact rows the identifier collides across the repo, so picking
// one body to inline would be misleading — keep every row compact instead.
const FIND_SYMBOL_INLINE_MAX_EXACT_ROWS = 3
const FIND_SYMBOL_RELATION_MAX_SITES = 5
const FIND_SYMBOL_RELATION_MAX_NEIGHBORS = 4
const FIND_SYMBOL_RELATION_MIN_BUDGET = 180
const SEARCH_RELATION_MIN_BUDGET = 220
const NAME_ONLY_EDGE_DEFAULT_LIMIT = 25
const DEFAULT_CHANGESET_MAX_FILES = 40
const DEFAULT_CHANGESET_MAX_EDGES_PER_FILE = 12
const DEFAULT_IMPACT_DEPTH = 2
const DEFAULT_IMPACT_MAX_NODES = 50
const HARD_MAX_IMPACT_BOUND = 50
// When an identifier-shaped query collides across ≥2 definitions, single_best does
// NOT collapse to one (that would hide the collision and silently pick a winner);
// instead it returns up to this many candidates with an "ambiguous: N defs" hint so
// the caller can disambiguate in the same call. Capped low to stay terse.
const AMBIGUOUS_IDENTIFIER_MAX_K = 3
const RERANK_CANDIDATE_LIMIT = 25
const RERANK_SNIPPET_CHAR_LIMIT = 1000
const VECTOR_SEARCH_UNAVAILABLE_MESSAGE = 'vector search unavailable (native dep), lexical/symbol still works'
const MTIME_TOLERANCE_MS = 2
const DEFAULT_WATCH_DEBOUNCE_MS = 500
const WATCH_SAFETY_POLL_INTERVAL_MS = 1000

let vectorExtensionLoader: (db: Database.Database) => void = (db) => sqliteVec.load(db)

export class IndexCompatibilityError extends Error {
  readonly code = 'INDEX_REBUILD_REQUIRED'

  constructor(readonly compatibility: IndexCompatibilityStatus) {
    super(compatibility.message ?? 'Index rebuild required')
    this.name = 'IndexCompatibilityError'
  }
}

export function setVectorExtensionLoaderForTests(loader?: (db: Database.Database) => void): void {
  vectorExtensionLoader = loader ?? ((db) => sqliteVec.load(db))
}

const DEFAULT_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'be',
  'by',
  'do',
  'does',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'what',
  'where',
  'which',
  'who',
  'why',
  'with'
])

export class SqliteRepo implements Repo {
  readonly root: string
  private readonly indexDirectoryPath: string
  private readonly indexGitignorePath: string
  private readonly indexPath: string
  private db: Database.Database | undefined
  private vectorExtensionLoaded = false
  private vectorSearchFailure: VectorSearchStatus | null = null
  private activeDatabaseUsers = 0
  private readonly databaseIdleResolvers: Array<() => void> = []
  private databaseGate: Promise<void> = Promise.resolve()

  private readonly explicitProviderId: string | undefined

  constructor(root: string, options: RepoOptions = {}) {
    this.root = resolve(root)
    this.indexDirectoryPath = resolve(this.root, '.codesift')
    this.indexGitignorePath = resolve(this.indexDirectoryPath, '.gitignore')
    this.indexPath = resolve(this.indexDirectoryPath, 'index.db')
    this.explicitProviderId = options.providerId?.trim() || undefined
  }

  /**
   * Resolve the active embedding provider. Precedence: explicit `RepoOptions.providerId` >
   * `CODESIFT_EMBEDDING_PROVIDER` env > `.codesift/config.json` `provider` > the built-in local
   * default. Read on every sync/search so a `config set provider` (or rebuild) is picked up without
   * reopening the repo — important for the long-lived daemon's cached handles.
   */
  private resolveProvider(): EmbeddingProvider {
    const envId = process.env.CODESIFT_EMBEDDING_PROVIDER?.trim()
    const configuredId = readConfig(this.root).provider?.trim()
    const providerId = this.explicitProviderId || envId || configuredId || DEFAULT_EMBEDDING_PROVIDER_ID
    const provider = getEmbeddingProvider(providerId)
    if (!provider) {
      throw new Error(`Embedding provider not registered: ${providerId}`)
    }

    return provider
  }

  /**
   * OPT-IN rerank stage. Re-scores the top ~25 fused candidates with a configured
   * reranker and reorders them, leaving the tail order intact. Runs only when
   * `options.rerank === true`, a reranker resolves, and the query is NL-concept
   * shaped (same gate as vector search). RRF stays the candidate generator — this
   * only reorders the head. Fail-safe: any reranker error (missing key, network,
   * bad shape) falls back to the fused order and never throws out of `search()`.
   */
  private async applyRerankStage(
    query: string,
    rows: RankedChunkRow[],
    options: SearchOptions | undefined
  ): Promise<RankedChunkRow[]> {
    if (options?.rerank !== true || rows.length < 2 || !queryShouldUseVectorSearch(query)) {
      return rows
    }

    const reranker = resolveReranker(this.root)
    if (!reranker) {
      return rows
    }

    const head = rows.slice(0, RERANK_CANDIDATE_LIMIT)
    const tail = rows.slice(RERANK_CANDIDATE_LIMIT)
    const documents = head.map((ranked) => rerankDocumentForRow(ranked.row))

    try {
      const results = await reranker.rerank(query, documents, { topK: head.length })
      const reordered = reorderByRerankResults(head, results)
      return [...reordered, ...tail]
    } catch {
      return rows
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.indexDirectoryPath, { recursive: true })
    await writeFile(this.indexGitignorePath, '*\n', 'utf8')
  }

  async sync(options?: SyncOptions): Promise<SyncResult> {
    const startedAt = Date.now()
    const syncStartedAt = new Date().toISOString()
    const provider = this.resolveProvider()
    const modelVersion = provider.modelVersion ?? provider.model ?? provider.id
    const sendsToCloud = isCloudEmbeddingProvider(provider)
    const allowSecrets = options?.allowSecrets ?? readConfig(this.root).allowSecrets ?? false

    if (options?.rebuild) {
      await this.runExclusiveDatabaseChange(() => this.resetDatabaseFile())
    }

    await this.initialize()

    let db = this.openDatabase()
    const compatibility = this.getIndexCompatibility(db)
    if (!compatibility.ok) {
      await this.resetDatabaseFile()
      await this.initialize()
      db = this.openDatabase()
    }

    writeSyncStatus(db, { state: 'running', startedAt: syncStartedAt })

    try {
      const previousGeneration = readMetaNumber(db, 'index_generation') ?? 0
      const previousGitSnapshot = readIndexedGitSnapshot(db)
      const indexedFiles = selectIndexedFileRows(db)
      const gitSnapshot = await readGitSnapshot(this.root)
      const gitSnapshotChanged = !gitSnapshotsEqual(previousGitSnapshot, gitSnapshot)
      const knownByPath = gitSnapshotChanged
        ? undefined
        : new Map(indexedFiles.map((file) => [file.path, file]))
      const { files, skippedFiles, skippedSymlinks } = await scanRepository(this.root, knownByPath)
      const diff = diffScannedFiles(files, indexedFiles)

      const chunkRows: IndexedChunkRecord[] = diff.changedFiles.flatMap((file) =>
        buildChunks(file).map((chunk) => ({
          ...chunk,
          id: createChunkId(chunk)
        }))
      )

      const cacheKey: Omit<EmbeddingCacheKey, 'contentHash'> = {
        providerId: provider.id,
        providerDims: provider.dims,
        modelVersion
      }
      const cachedEmbeddings = selectCachedEmbeddings(db, cacheKey, chunkRows)
      const pendingByContentHash = new Map<string, IndexedChunkRecord[]>()
      const chunksToEmbed: IndexedChunkRecord[] = []
      const embeddedChunks: EmbeddedChunkRecord[] = []
      let completedChunks = 0
      const totalChunks = chunkRows.length

      for (const chunk of chunkRows) {
        const contentHash = contentHashForChunk(chunk)
        const cached = cachedEmbeddings.get(contentHash)
        if (cached) {
          embeddedChunks.push({ row: chunk, embedding: cached })
          completedChunks += 1
          continue
        }

        const pending = pendingByContentHash.get(contentHash)
        if (pending) {
          pending.push(chunk)
          continue
        }

        pendingByContentHash.set(contentHash, [chunk])
        chunksToEmbed.push(chunk)
      }

      const batches = buildEmbeddingBatches(chunksToEmbed, provider.maxBatch, provider.maxBatchTokens)
      writeSyncStatus(db, { state: 'running', startedAt: syncStartedAt, completedChunks, totalChunks })

      for (let index = 0; index < batches.length; index += 1) {
        throwIfAborted(options?.signal)

        const batch = batches[index] ?? []
        const batchTexts = batch.map((chunk) => chunk.embeddingText)
        // Secret-scan only the cloud (learned) document-embed path: this is the egress vector for
        // repository secrets. The local provider never leaves the machine, so it is never gated.
        // Throws (aborting the sync, leaving the previous index intact) on a detected secret unless
        // allowSecrets is set, in which case the content is redacted before it is sent.
        const texts = sendsToCloud ? prepareForCloud(batchTexts, { allowSecrets }) : batchTexts
        const embeddings = await provider.embedBatch(texts, { role: 'document' }, options?.signal)

        throwIfAborted(options?.signal)

        for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
          const representative = batch[batchIndex]!
          const contentHash = contentHashForChunk(representative)
          const embedding = embeddings[batchIndex] ?? new Float32Array(provider.dims)
          const pendingChunks = pendingByContentHash.get(contentHash) ?? [representative]

          for (const chunk of pendingChunks) {
            embeddedChunks.push({ row: chunk, embedding })
          }

          completedChunks += pendingChunks.length
        }

        options?.onProgress?.({
          phase: 'batch',
          batch: index + 1,
          totalBatches: batches.length,
          completedChunks,
          totalChunks
        })
        writeSyncStatus(db, { state: 'running', startedAt: syncStartedAt, completedChunks, totalChunks })
      }

      const metadataMissing = readMeta(db, 'schema_version') !== SCHEMA_VERSION
      const hasDatabaseChanges =
        diff.changedFiles.length > 0 ||
        diff.touchedFiles.length > 0 ||
        diff.removedPaths.length > 0 ||
        gitSnapshotChanged ||
        metadataMissing

      if (hasDatabaseChanges) {
        const shadow = await this.createShadowDatabase(db)
        let shadowClosed = false
        try {
          applySyncChanges(shadow.db, {
            diff,
            embeddedChunks,
            provider: {
              id: provider.id,
              dims: provider.dims,
              modelVersion
            },
            previousGeneration,
            gitSnapshot,
            syncStartedAt,
            completedAt: new Date().toISOString()
          })
          shadow.db.close()
          shadowClosed = true
          await this.runExclusiveDatabaseChange(() => this.swapDatabase(shadow.path))
        } finally {
          if (!shadowClosed) {
            shadow.db.close()
          }
          await removeDatabaseSidecars(shadow.path)
          await rm(shadow.path, { force: true })
        }
      } else {
        writeSyncStatus(db, {
          state: 'completed',
          startedAt: syncStartedAt,
          completedAt: new Date().toISOString()
        })
      }

      const result = {
        indexedFiles: diff.changedFiles.length,
        skippedFiles,
        skippedSymlinks,
        removedFiles: diff.removedPaths.length,
        durationMs: Date.now() - startedAt
      }
      this.closeIdleDatabaseOnWindows()
      return result
    } catch (error) {
      const state = isAbortError(error) ? 'aborted' : 'failed'
      try {
        writeSyncStatus(this.openDatabase(), {
          state,
          startedAt: syncStartedAt,
          completedAt: new Date().toISOString(),
          error: extractErrorMessage(error)
        })
      } catch {
        // Best-effort crash/partial-state metadata only; preserve the original sync error.
      }

      this.closeIdleDatabaseOnWindows()
      throw error
    }
  }

  async search(query: string, options?: SearchOptions): Promise<ResultList<SearchHit>> {
    if (!query.trim()) {
      return []
    }
    if (!existsSync(this.indexPath)) {
      return withResultMetadata([], { notIndexed: true, emptyReason: 'not_indexed' })
    }

    const releaseDatabase = await this.enterDatabaseUser()
    try {
      const db = this.openDatabase()
      this.ensureIndexCompatibleForQueries(db)
      const freshness = await this.getFreshness(db)

    const requestedK = options?.k ?? DEFAULT_SEARCH_K
    const limit = Math.max(requestedK * 10, DEFAULT_VECTOR_LIMIT)
    const { whereSql, params } = buildChunkSearchFilters(options)
    const exactRows = selectExactCandidateRows(db, query, options, Math.max(requestedK * 10, DEFAULT_PATH_FILTERED_LIMIT))

    const lexicalRows = selectRelaxedLexicalRows(db, query, whereSql, params, limit)

    const provider = this.resolveProvider()
    const shouldUseVectorSearch = isLearnedEmbeddingProvider(provider) && queryShouldUseVectorSearch(query)
    let vectorRows: ChunkRow[] = []

    if (shouldUseVectorSearch && this.ensureVectorExtension(db)) {
      const [embedding] = await provider.embedBatch([query], { role: 'query' })

      vectorRows = embedding
        ? db
            .prepare<unknown[], ChunkRow>(
              `
                select
                  id,
                  file_path,
                  start_line,
                  end_line,
                  snippet,
                  language,
                  symbol,
                  kind,
                  parent,
                  signature,
                  generated
                from chunks
                ${whereSql}
                order by vec_distance_cosine(embedding, ?) asc, file_path asc, start_line asc, id asc
                limit ${limit}
              `
            )
            .all(...params, embedding)
        : []
    }

    const fusedRows = fuseRankedRows(query, exactRows, vectorRows, lexicalRows)
    const dedupedRows = dedupeContainedRows(fusedRows)
    const distinctRows = await this.applyRerankStage(query, dedupedRows, options)

    // Confidence-gated single_best (#7): an identifier-shaped lookup collapses to the
    // one best answer ONLY when it resolves to a single definition. When the identifier
    // collides across ≥2 definitions, collapsing would silently pick a winner and hide
    // the ambiguity, so return a capped candidate set plus an "ambiguous: N defs" hint
    // instead. An explicit options.singleBest always wins (a caller can force k=1).
    const singleTokenIdentifier = isSingleBestIdentifierQuery(query)
    const exactDefCount = singleTokenIdentifier ? distinctExactSymbolDefinitions(exactRows, query) : 0
    const ambiguousIdentifier = options?.singleBest === undefined && singleTokenIdentifier && exactDefCount >= 2
    const autoSingleBest = exactRows.length > 0 && singleTokenIdentifier && !ambiguousIdentifier
    const effectiveK = (options?.singleBest ?? autoSingleBest)
      ? 1
      : ambiguousIdentifier
        ? Math.min(requestedK, AMBIGUOUS_IDENTIFIER_MAX_K)
        : requestedK

      const budgetedHits = await buildBudgetedSearchHits(
        query,
        distinctRows,
        effectiveK,
        options?.maxTokens,
        options?.context,
        (file, startLine, endLine) => this.readRange(file, startLine, endLine)
      )
      const staleHits = markStaleHits(budgetedHits, freshness)
      // Surface the collision count on the top hit so the caller knows the set is
      // "one of N same-named definitions", not a single confident answer.
      if (ambiguousIdentifier && staleHits.length > 0) {
        staleHits[0]!.ambiguousDefCount = exactDefCount
      }
      if (options?.withUsages) {
        await attachUsagesToTopDefinitionHit(db, this.root, staleHits, options)
      }
      if (shouldAttachSearchRelations(options, autoSingleBest)) {
        await attachRelationsToTopDefinitionHit(db, this.root, staleHits, options, (definition) =>
          this.readFindSymbolRelations(db, definition)
        )
      }
      return staleHits
    } finally {
      releaseDatabase()
    }
  }

  async grep(pattern: string, options?: GrepOptions): Promise<ResultList<GrepHit>> {
    if (!pattern) {
      return []
    }
    if (!existsSync(this.indexPath)) {
      return withResultMetadata([], { notIndexed: true, emptyReason: 'not_indexed' })
    }

    const releaseDatabase = await this.enterDatabaseUser()
    let candidateFiles: Array<{ path: string; language: string }>
    try {
      const db = this.openDatabase()
      this.ensureIndexCompatibleForQueries(db)
      candidateFiles = selectGrepCandidateFiles(db, options)
    } finally {
      releaseDatabase()
    }

    const matcher = buildGrepMatcher(pattern, options)
    const beforeContextLines = normalizeContextLines(options?.beforeContextLines ?? options?.contextLines)
    const afterContextLines = normalizeContextLines(options?.afterContextLines ?? options?.contextLines)
    const maxMatches = normalizeMaxMatches(options?.maxMatches)
    const hits: GrepHit[] = []

    for (const file of candidateFiles) {
      if (hits.length >= maxMatches) {
        break
      }

      let content: string
      try {
        content = await readFile(resolve(this.root, file.path), 'utf8')
      } catch {
        continue
      }

      const lines = splitLines(content)
      const lineStarts = buildLineStarts(content)
      matcher.lastIndex = 0
      const seenRanges = new Set<string>()
      let match: RegExpExecArray | null

      while ((match = matcher.exec(content)) !== null) {
        const matchedText = match[0]
        if (matchedText.length === 0) {
          matcher.lastIndex += 1
          continue
        }

        const startOffset = match.index
        const endOffset = startOffset + matchedText.length
        const startLine = lineNumberForOffset(lineStarts, startOffset)
        const endLine = lineNumberForOffset(lineStarts, Math.max(startOffset, endOffset - 1))
        const rangeKey = `${startLine}:${endLine}`

        if (!seenRanges.has(rangeKey)) {
          seenRanges.add(rangeKey)
          const snippetStartLine = Math.max(1, startLine - beforeContextLines)
          const snippetEndLine = Math.min(lines.length, endLine + afterContextLines)
          const hit: GrepHit = {
            file: file.path,
            range: { startLine, endLine },
            line: startLine,
            column: startOffset - lineStarts[startLine - 1]! + 1,
            match: matchedText,
            snippet: lines.slice(snippetStartLine - 1, snippetEndLine).join('\n'),
            snippetRange: { startLine: snippetStartLine, endLine: snippetEndLine }
          }

          if (file.language) {
            hit.language = file.language
          }

          hits.push(hit)
          if (hits.length >= maxMatches) {
            break
          }
        }
      }
    }

    return hits
  }

  async findSymbol(name: string, options?: FindSymbolOptions): Promise<ResultList<SymbolDefinition>> {
    if (!name.trim()) {
      return []
    }
    if (!existsSync(this.indexPath)) {
      return withResultMetadata([], { notIndexed: true, emptyReason: 'not_indexed' })
    }

    const releaseDatabase = await this.enterDatabaseUser()
    try {
      const db = this.openDatabase()
      this.ensureIndexCompatibleForQueries(db)

      const kinds = normalizeKinds(options?.kind)
      const exactWhere = ['lower(name) = lower(?)']
      const exactParams: string[] = [name]
      if (kinds.length > 0) {
        exactWhere.push(`kind in (${kinds.map(() => '?').join(', ')})`)
        exactParams.push(...kinds)
      }
      if (options?.pathGlob) {
        exactWhere.push('codesift_minimatch(file_path, ?) = 1')
        exactParams.push(options.pathGlob)
      }

      const exactRows = db
        .prepare<unknown[], SymbolRow>(
          `
            select id, name, file_path, start_line, end_line, kind, signature, parent, language
            from symbols
            where ${exactWhere.join(' and ')}
            order by file_path asc, start_line asc
          `
        )
        .all(...exactParams)

      const partialRows =
        exactRows.length > 0
          ? []
          : selectPartialSymbolRows(db, name, kinds, options?.pathGlob)

      const rows = [...exactRows, ...partialRows]

      const canEnrichTopExactRow = exactRows.length > 0 && exactRows.length <= FIND_SYMBOL_INLINE_MAX_EXACT_ROWS
      const ambiguousDefCount = countDistinctDefinitionSites(exactRows)

      // One-call moat: inline the verbatim enclosing-symbol body for the top exact
      // match when the lookup is unambiguous, so an identifier query resolves
      // without a mandatory follow-up read. Disk-fresh, capped, never throws.
      let topBody: string | undefined
      if (options?.withBody !== false && options?.detail !== 'sig' && canEnrichTopExactRow) {
        const top = exactRows[0]!
        try {
          const source = await this.readRange(top.file_path, top.start_line, top.end_line)
          const { body } = capInlineBody(source, chunkLocator(top.file_path, top.start_line, top.end_line))
          if (body) {
            topBody = body
          }
        } catch {
          // A disk failure or out-of-range read leaves every row compact.
        }
      }

      let topRelations: SymbolRelations | undefined
      if (shouldAttachFindSymbolRelations(options, canEnrichTopExactRow)) {
        try {
          const candidateRelations = await this.readFindSymbolRelations(db, exactRows[0]!)
          if (
            options?.withCallers === true ||
            relationsFitBudget(candidateRelations, options?.maxTokens, estimateSymbolBodyTokens(topBody))
          ) {
            topRelations = candidateRelations
          }
        } catch {
          // Relation bundling is best-effort and must never fail the base lookup.
        }
      }

      const definitions = rows.map((row, index) => {
        const exact = index < exactRows.length
        const definition: SymbolDefinition = {
          id: String(row.id),
          name: row.name,
          file: row.file_path,
          range: {
            startLine: row.start_line,
            endLine: row.end_line
          },
          kind: row.kind,
          matchQuality: exact ? 'exact' : 'partial'
        }

        if (row.signature) {
          definition.signature = row.signature
        }

        if (row.parent) {
          definition.parent = row.parent
        }

        if (row.language) {
          definition.language = row.language
        }

        if (index === 0 && ambiguousDefCount >= 2) {
          definition.ambiguousDefCount = ambiguousDefCount
        }

        // Only the top exact row (rows[0] when exactRows is non-empty) carries
        // the optional single-call enrichments.
        if (index === 0 && topBody !== undefined) {
          definition.body = topBody
        }

        if (index === 0 && topRelations !== undefined) {
          definition.relations = topRelations
        }

        return definition
      })
      return withResultMetadata(definitions, {
        definitionCount: exactRows.length,
        ...(ambiguousDefCount >= 2 ? { ambiguousDefCount } : {}),
        ...(partialRows.length > 0 ? { partialMatchCount: partialRows.length } : {})
      })
    } finally {
      releaseDatabase()
    }
  }

  async findCallers(name: string, options?: FindEdgeOptions): Promise<EdgeResult[]> {
    return this.findDefinitionEdges(name, options, ['call'], true)
  }

  async findReferences(name: string, options?: FindEdgeOptions): Promise<EdgeResult[]> {
    return this.findDefinitionEdges(name, options, ['call', 'ref'], false)
  }

  async findImplementers(name: string, options?: FindEdgeOptions): Promise<EdgeResult[]> {
    return this.findDefinitionEdges(name, options, ['implements', 'extends'], false)
  }

  async findImporters(file: string, options?: FindImportersOptions): Promise<ResultList<EdgeResult>> {
    if (!file.trim()) {
      return []
    }
    if (!existsSync(this.indexPath)) {
      return withResultMetadata([], { notIndexed: true, emptyReason: 'not_indexed' })
    }

    const releaseDatabase = await this.enterDatabaseUser()
    let rows: EdgeResultRow[] = []
    try {
      const db = this.openDatabase()
      this.ensureIndexCompatibleForQueries(db)
      rows = selectImporterEdgeRows(db, file)
    } finally {
      releaseDatabase()
    }

    return (await readEdgeResultsFromRows(this.root, rows, options?.maxTokens)).items
  }

  async impact(name: string, options?: ImpactOptions): Promise<ImpactResult> {
    const depthLimit = normalizeImpactDepth(options?.depth)
    const maxNodes = normalizeImpactMaxNodes(options?.maxNodes)
    if (!name.trim()) {
      return { nodes: [], depthLimit, maxNodes }
    }
    if (!existsSync(this.indexPath)) {
      return { nodes: [], depthLimit, maxNodes, notIndexed: true, emptyReason: 'not_indexed' }
    }

    const releaseDatabase = await this.enterDatabaseUser()
    let rows: ImpactNodeRow[] = []
    let depthCapped = false
    let nodesCapped = false
    try {
      const db = this.openDatabase()
      this.ensureIndexCompatibleForQueries(db)

      const initialDefinitions = selectExactDefinitionRows(db, name, normalizeKinds(options?.kind), options?.pathGlob)
      if (initialDefinitions.length === 0) {
        return { nodes: [], depthLimit, maxNodes, emptyReason: 'no_definition' }
      }

      const defaultExportCache = new Map<string, Promise<Set<string>>>()
      const queue: Array<{ name: string; targetFiles: string[]; depth: number }> = [
        { name, targetFiles: [...new Set(initialDefinitions.map((definition) => definition.file_path))], depth: 0 }
      ]
      const visitedTargets = new Set(initialDefinitions.map((definition) => `${definition.name.toLowerCase()}\u0000${definition.file_path}`))

      while (queue.length > 0 && rows.length < maxNodes) {
        const current = queue.shift()!
        const remainingNodes = maxNodes - rows.length
        const currentTargets = await resolveDefinitionEdgeTargetsForNameAndFiles(
          db,
          this.root,
          current.name,
          current.targetFiles,
          defaultExportCache
        )
        if (currentTargets.length === 0) {
          continue
        }

        const edgeRows = selectDefinitionEdgeRows(db, currentTargets, ['call'], true, remainingNodes + 1)

        if (edgeRows.length > remainingNodes) {
          nodesCapped = true
        }

        for (const edgeRow of edgeRows.slice(0, remainingNodes)) {
          const nodeName = edgeRow.src_symbol?.trim() || 'top-level'
          rows.push({ ...edgeRow, name: nodeName, depth: current.depth })

          if (current.depth >= depthLimit) {
            if (edgeRow.src_symbol) {
              depthCapped = true
            }
            continue
          }

          if (!edgeRow.src_symbol) {
            continue
          }

          const nextKey = `${edgeRow.src_symbol.toLowerCase()}\u0000${edgeRow.src_file}`
          if (visitedTargets.has(nextKey)) {
            continue
          }

          visitedTargets.add(nextKey)
          queue.push({
            name: edgeRow.src_symbol,
            targetFiles: [edgeRow.src_file],
            depth: current.depth + 1
          })
        }

        if (nodesCapped) {
          break
        }
      }

      if (queue.length > 0) {
        nodesCapped = true
      }
    } finally {
      releaseDatabase()
    }

    const { items: nodes, tokenTruncated } = await readImpactNodesFromRows(this.root, rows, options?.maxTokens)
    return {
      nodes,
      impactTruncated: nodesCapped || tokenTruncated,
      depthCapped,
      nodesCapped,
      depthLimit,
      maxNodes
    }
  }

  async changesetContext(files: string[], options?: ChangesetContextOptions): Promise<ChangesetContextResult> {
    const requestedFiles = normalizeChangesetFiles(files)
    const maxFiles = normalizeChangesetMaxFiles(options?.maxFiles)
    const maxEdgesPerFile = normalizeChangesetMaxEdges(options?.maxEdgesPerFile)
    if (requestedFiles.length === 0) {
      return { files: [] }
    }
    if (!existsSync(this.indexPath)) {
      return { files: [], notIndexed: true }
    }

    const selectedFiles = requestedFiles.slice(0, maxFiles)
    const releaseDatabase = await this.enterDatabaseUser()
    const contexts: ChangesetFileContext[] = []
    let stale = false
    let truncated = requestedFiles.length > selectedFiles.length
    try {
      const db = this.openDatabase()
      this.ensureIndexCompatibleForQueries(db)
      stale = (await this.getFreshness(db)).stale

      for (const file of selectedFiles) {
        const symbolRows = selectSymbolRowsByFile(db, file)
        const symbols = symbolRows.map((row) => buildSymbolDefinition(row, 'exact'))
        const targets = await resolveDefinitionEdgeTargets(this.root, symbolRows)
        const callerRows = selectDefinitionEdgeRows(db, targets, ['call', 'ref'], true, {
          limit: maxEdgesPerFile + 1,
          nameOnlyLimit: Math.min(NAME_ONLY_EDGE_DEFAULT_LIMIT, maxEdgesPerFile + 1)
        })
        const importerRows = selectImporterEdgeRows(db, file).slice(0, maxEdgesPerFile + 1)
        const callerRead = await readEdgeResultsFromRows(this.root, callerRows.slice(0, maxEdgesPerFile), options?.maxTokens)
        const importerRead = await readEdgeResultsFromRows(this.root, importerRows.slice(0, maxEdgesPerFile), options?.maxTokens)
        const omitted = Math.max(0, callerRows.length - callerRead.items.length) + Math.max(0, importerRows.length - importerRead.items.length)
        const omittedLowerBound = callerRows.length > maxEdgesPerFile || importerRows.length > maxEdgesPerFile
        if (omitted > 0 || omittedLowerBound) {
          truncated = true
        }
        contexts.push({
          file,
          symbols,
          callers: callerRead.items,
          importers: importerRead.items,
          ...(omitted > 0 ? { omitted } : {}),
          ...(omittedLowerBound ? { omittedLowerBound } : {})
        })
      }
    } finally {
      releaseDatabase()
    }

    return {
      files: contexts,
      ...(stale ? { stale } : {}),
      ...(truncated ? { truncated } : {})
    }
  }

  private async readFindSymbolRelations(db: Database.Database, definition: SymbolRow): Promise<SymbolRelations | undefined> {
    const targets = await resolveDefinitionEdgeTargets(this.root, [definition])
    const siteRows = selectDefinitionEdgeRows(db, targets, ['call', 'ref'], true, FIND_SYMBOL_RELATION_MAX_SITES)
    const { items: sites } = await readEdgeResultsFromRows(this.root, siteRows, undefined)
    const totalSites = countDefinitionEdgeRows(db, targets, ['call', 'ref'])

    const neighborRows = selectSameFileNeighborRows(
      db,
      definition.file_path,
      definition.id,
      definition.start_line,
      FIND_SYMBOL_RELATION_MAX_NEIGHBORS
    )
    const neighbors = neighborRows.map((row) => buildSymbolNeighbor(row))
    const totalNeighbors = countSameFileNeighborRows(db, definition.file_path, definition.id)
    const omitted = Math.max(0, totalSites - siteRows.length) + Math.max(0, totalNeighbors - neighbors.length)

    if (sites.length === 0 && neighbors.length === 0 && omitted === 0) {
      return undefined
    }

    const relations: SymbolRelations = { sites, neighbors }
    if (omitted > 0) {
      relations.omitted = omitted
    }

    return relations
  }

  private async findDefinitionEdges(
    name: string,
    options: FindEdgeOptions | undefined,
    edgeKinds: ReadonlyArray<Edge['edgeKind']>,
    preferCallsFirst: boolean
  ): Promise<ResultList<EdgeResult>> {
    if (!name.trim()) {
      return []
    }
    if (!existsSync(this.indexPath)) {
      return withResultMetadata([], { notIndexed: true, emptyReason: 'not_indexed' })
    }

    const releaseDatabase = await this.enterDatabaseUser()
    let rows: EdgeResultRow[] = []
    let metadata: ResultMetadata = {}
    try {
      const db = this.openDatabase()
      this.ensureIndexCompatibleForQueries(db)

      const definitions = selectExactDefinitionRows(db, name, normalizeKinds(options?.kind), options?.pathGlob)
      if (definitions.length === 0) {
        return withResultMetadata([], { emptyReason: 'no_definition' })
      }

      const targets = await resolveDefinitionEdgeTargets(this.root, definitions)
      const stats: DefinitionEdgeQueryStats = {}
      const selectOptions: DefinitionEdgeSelectOptions = {
        nameOnlyLimit: NAME_ONLY_EDGE_DEFAULT_LIMIT,
        stats
      }
      if (options?.maxResults !== undefined) {
        selectOptions.limit = options.maxResults
      }
      rows = selectDefinitionEdgeRows(db, targets, edgeKinds, preferCallsFirst, selectOptions)
      const ambiguousDefCount = countDistinctDefinitionSites(definitions)
      metadata = {
        definitionCount: definitions.length,
        ...(ambiguousDefCount >= 2 ? { ambiguousDefCount } : {}),
        ...(rows.length === 0 ? { emptyReason: 'no_edges' as const } : {}),
        ...(stats.nameOnlyUnscoped !== undefined ? { nameOnlyUnscoped: stats.nameOnlyUnscoped, nameOnlyLimit: NAME_ONLY_EDGE_DEFAULT_LIMIT } : {})
      }
    } finally {
      releaseDatabase()
    }

    return withResultMetadata((await readEdgeResultsFromRows(this.root, rows, options?.maxTokens)).items, metadata)
  }

  async readChunk(id: string, options?: ReadChunkOptions): Promise<string> {
    if (!existsSync(this.indexPath)) {
      throw new Error('not_indexed; run: codesift index')
    }

    const releaseDatabase = await this.enterDatabaseUser()
    let parsedChunkId: { file: string; startLine: number; endLine: number } | null
    try {
      parsedChunkId = parseChunkId(id) ?? this.lookupChunkLocation(id)
    } finally {
      releaseDatabase()
    }

    if (!parsedChunkId) {
      throw new Error(`Unknown chunk id: ${id}`)
    }

    return this.readRange(parsedChunkId.file, parsedChunkId.startLine, parsedChunkId.endLine, options)
  }

  async readRange(file: string, startLine: number, endLine: number, options?: ReadRangeOptions): Promise<string> {
    if (!file.trim()) {
      throw new Error('readRange requires a file path')
    }

    if (startLine <= 0 || endLine <= 0 || endLine < startLine) {
      throw new Error(`Invalid line range: ${startLine}-${endLine}`)
    }

    const absolutePath = resolve(this.root, file)
    if (!isPathInsideRoot(this.root, absolutePath)) {
      throw new Error(`File is outside repo root: ${file}`)
    }

    const fileContent = await readFile(absolutePath, 'utf8')
    const lines = splitLines(fileContent)
    const contextLines = normalizeContextLines(options?.contextLines)
    const slicedStartLine = Math.max(1, startLine - contextLines)
    const slicedEndLine = Math.min(lines.length, endLine + contextLines)

    return lines.slice(slicedStartLine - 1, slicedEndLine).join('\n')
  }

  async status(): Promise<RepoStatus> {
    if (!existsSync(this.indexPath)) {
      return {
        root: this.root,
        indexPath: this.indexPath,
        indexExists: false,
        indexed: false,
        stale: false,
        sync: { state: 'idle' },
        chunkCount: 0,
        symbolCount: 0,
        generatedFileCount: 0,
        generatedChunkCount: 0,
        indexGeneration: 0,
        provider: null,
        compatibility: { ok: true },
        vectorSearch: this.getVectorSearchStatus()
      }
    }

    const releaseDatabase = await this.enterDatabaseUser()
    try {
      const db = this.openDatabase()
      const counts =
        db
        .prepare<[], RepoCountRow>(
          `
            select
              (select count(*) from chunks) as chunk_count,
              (select count(*) from symbols) as symbol_count,
              (select count(*) from files where generated = 1) as generated_file_count,
              (select count(*) from chunks where generated = 1) as generated_chunk_count
          `
        )
        .get() ?? { chunk_count: 0, symbol_count: 0, generated_file_count: 0, generated_chunk_count: 0 }

    const providerId = readMeta(db, 'provider_id')
    const providerDims = readMetaNumber(db, 'provider_dims')
    const modelVersion = readMeta(db, 'model_version')
    const indexGeneration = readMetaNumber(db, 'index_generation') ?? 0
    const indexed = counts.chunk_count > 0

    const provider = indexed && providerId
      ? {
          id: providerId,
          ...(modelVersion ? { modelVersion } : {}),
          ...(providerDims !== undefined ? { dims: providerDims } : {})
        }
      : null
    const freshness = indexed ? await this.getFreshness(db) : createFreshIndexStatus()
    const sync = readSyncStatus(db)

      return {
        root: this.root,
        indexPath: this.indexPath,
        indexExists: true,
        indexed,
        stale: freshness.stale,
        ...(freshness.reasons.length > 0 ? { staleReasons: freshness.reasons } : {}),
        sync,
        chunkCount: counts.chunk_count,
        symbolCount: counts.symbol_count,
        generatedFileCount: counts.generated_file_count,
        generatedChunkCount: counts.generated_chunk_count,
        indexGeneration,
        provider,
        compatibility: this.getIndexCompatibility(db, indexed),
        vectorSearch: this.getVectorSearchStatus()
      }
    } finally {
      releaseDatabase()
    }
  }

  async close(): Promise<void> {
    await this.databaseGate
    await this.waitForDatabaseIdle()
    if (this.db) {
      this.db.close()
      this.db = undefined
      this.vectorExtensionLoaded = false
    }
  }

  async watch(options?: WatchOptions): Promise<StopWatching> {
    const debounceMs = normalizeWatchDebounceMs(options?.debounceMs)
    const syncController = new AbortController()
    const watchers = new Map<string, FSWatcher>()
    let disposed = false
    let syncing = false
    let pending = false
    let debounceTimer: NodeJS.Timeout | undefined
    let safetyInterval: NodeJS.Timeout | undefined

    const closeWatchers = () => {
      for (const watcher of watchers.values()) {
        watcher.close()
      }
      watchers.clear()
    }

    const stop = async () => {
      if (disposed) {
        return
      }

      disposed = true
      syncController.abort()
      if (debounceTimer) {
        clearTimeout(debounceTimer)
      }
      if (safetyInterval) {
        clearInterval(safetyInterval)
      }
      closeWatchers()
    }

    const refreshWatchers = async () => {
      if (disposed) {
        return
      }

      const directories = await getWatchDirectories(this.root)
      for (const [directory, watcher] of watchers) {
        if (!directories.has(directory)) {
          watcher.close()
          watchers.delete(directory)
        }
      }

      for (const directory of directories) {
        if (watchers.has(directory)) {
          continue
        }

        try {
          const watcher = watchFs(directory, { persistent: true }, (_eventType, fileName) => {
            if (fileName && isIgnoredWatchEvent(String(fileName))) {
              return
            }
            scheduleSync()
          })
          watcher.on('error', () => {
            watcher.close()
            watchers.delete(directory)
          })
          watchers.set(directory, watcher)
        } catch {
          // Some directories can disappear or be unwatchable during write bursts; the next refresh retries.
        }
      }
    }

    const runSync = async (onlyIfStale: boolean) => {
      if (disposed) {
        return
      }

      if (syncing) {
        pending = true
        return
      }

      syncing = true
      try {
        if (onlyIfStale) {
          const status = await this.status()
          if (status.indexed && !status.stale) {
            return
          }
        }

        await this.sync({ signal: syncController.signal })
        await refreshWatchers()
      } catch {
        // Keep the foreground watcher alive; the next event or safety poll will retry after transient write bursts.
      } finally {
        syncing = false
        if (pending && !disposed) {
          pending = false
          scheduleSync()
        }
      }
    }

    const scheduleSync = () => {
      if (disposed) {
        return
      }

      if (debounceTimer) {
        clearTimeout(debounceTimer)
      }

      debounceTimer = setTimeout(() => {
        debounceTimer = undefined
        void runSync(false)
      }, debounceMs)
    }

    await refreshWatchers()
    void runSync(true)

    safetyInterval = setInterval(() => {
      void runSync(true)
    }, WATCH_SAFETY_POLL_INTERVAL_MS)

    if (options?.signal) {
      if (options.signal.aborted) {
        await stop()
      } else {
        options.signal.addEventListener('abort', () => void stop(), { once: true })
      }
    }

    return stop
  }

  private async getFreshness(db: Database.Database): Promise<IndexFreshnessStatus> {
    return getIndexFreshness(this.root, db)
  }

  private async enterDatabaseUser(): Promise<() => void> {
    await this.databaseGate
    this.activeDatabaseUsers += 1
    let released = false

    return () => {
      if (released) {
        return
      }

      released = true
      this.activeDatabaseUsers = Math.max(0, this.activeDatabaseUsers - 1)
      if (this.activeDatabaseUsers === 0) {
        for (const resolveIdle of this.databaseIdleResolvers.splice(0)) {
          resolveIdle()
        }
        this.closeIdleDatabaseOnWindows()
      }
    }
  }

  private closeIdleDatabaseOnWindows(): void {
    if (process.platform !== 'win32' || this.activeDatabaseUsers !== 0 || !this.db) {
      return
    }

    this.db.close()
    this.db = undefined
    this.vectorExtensionLoaded = false
  }

  private async runExclusiveDatabaseChange<T>(action: () => Promise<T>): Promise<T> {
    let releaseGate!: () => void
    const previousGate = this.databaseGate
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate
    })

    this.databaseGate = previousGate.then(() => gate)
    await previousGate
    await this.waitForDatabaseIdle()

    try {
      return await action()
    } finally {
      releaseGate()
    }
  }

  private async waitForDatabaseIdle(): Promise<void> {
    if (this.activeDatabaseUsers === 0) {
      return
    }

    await new Promise<void>((resolveIdle) => {
      this.databaseIdleResolvers.push(resolveIdle)
    })
  }

  private openDatabase(): Database.Database {
    if (this.db) {
      return this.db
    }

    const db = new Database(this.indexPath)
    this.configureDatabase(db, 'WAL')
    this.vectorExtensionLoaded = false
    this.db = db
    return db
  }

  private configureDatabase(db: Database.Database, journalMode: 'WAL' | 'DELETE'): void {
    db.pragma(`journal_mode = ${journalMode}`)
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    registerSqlFunctions(db)
    this.ensureSchema(db)
  }

  private async createShadowDatabase(sourceDb: Database.Database): Promise<{ path: string; db: Database.Database }> {
    const shadowPath = join(this.indexDirectoryPath, `index.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.shadow.db`)

    sourceDb.pragma('wal_checkpoint(TRUNCATE)')
    await copyFile(this.indexPath, shadowPath).catch((error: unknown) => {
      if (!isNodeErrorCode(error, 'ENOENT')) {
        throw error
      }
    })

    const shadowDb = new Database(shadowPath)
    this.configureDatabase(shadowDb, 'DELETE')
    return { path: shadowPath, db: shadowDb }
  }

  private async swapDatabase(shadowPath: string): Promise<void> {
    if (this.db) {
      this.db.close()
      this.db = undefined
    }

    this.vectorExtensionLoaded = false
    this.vectorSearchFailure = null
    await removeDatabaseSidecars(this.indexPath)

    try {
      await rename(shadowPath, this.indexPath)
    } catch (error) {
      if (!isNodeErrorCode(error, 'EEXIST') && !isNodeErrorCode(error, 'EPERM')) {
        throw error
      }

      await rm(this.indexPath, { force: true })
      await rename(shadowPath, this.indexPath)
    }
  }

  private ensureVectorExtension(db: Database.Database): boolean {
    if (this.vectorExtensionLoaded) {
      return true
    }

    if (this.vectorSearchFailure) {
      return false
    }

    try {
      vectorExtensionLoader(db)
      this.vectorExtensionLoaded = true
      return true
    } catch (error) {
      this.vectorSearchFailure = {
        available: false,
        state: 'unavailable',
        reason: 'native-dependency-unavailable',
        message: VECTOR_SEARCH_UNAVAILABLE_MESSAGE,
        detail: extractErrorMessage(error)
      }
      return false
    }
  }

  private getVectorSearchStatus(): VectorSearchStatus {
    if (this.vectorSearchFailure) {
      return this.vectorSearchFailure
    }

    return {
      available: true,
      state: this.vectorExtensionLoaded ? 'ready' : 'lazy'
    }
  }

  private ensureSchema(db: Database.Database): void {
    db.exec(`
      create table if not exists meta(
        key text primary key,
        value text not null
      );

      create table if not exists files(
        path text primary key,
        language text not null,
        hash text not null,
        size integer not null,
        mtime real not null,
        generated integer not null default 0
      );

      create table if not exists chunks(
        id text primary key,
        file_path text not null references files(path) on delete cascade,
        language text not null,
        start_line integer not null,
        end_line integer not null,
        symbol text,
        kind text,
        parent text,
        signature text,
        snippet text not null,
        generated integer not null default 0,
        embedding blob not null
      );

      create index if not exists idx_chunks_language on chunks(language);
      create index if not exists idx_chunks_symbol on chunks(symbol);
      create index if not exists idx_chunks_kind on chunks(kind);
      create index if not exists idx_chunks_file_range on chunks(file_path, start_line, end_line);

      create virtual table if not exists chunks_fts using fts5(
        chunk_id UNINDEXED,
        search_text,
        symbol,
        parent,
        signature,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );

      create table if not exists symbols(
        id integer primary key autoincrement,
        name text not null,
        kind text not null,
        file_path text not null references files(path) on delete cascade,
        start_line integer not null,
        end_line integer not null,
        parent text,
        signature text,
        language text
      );

      create index if not exists idx_symbols_name on symbols(name);
      create index if not exists idx_symbols_kind on symbols(kind);

      create table if not exists edges(
        id integer primary key autoincrement,
        src_file text not null references files(path) on delete cascade,
        src_line integer not null,
        src_symbol text,
        dst_name text not null,
        dst_file text,
        edge_kind text not null,
        resolution text not null,
        language text
      );

      create index if not exists idx_edges_dst on edges(dst_name, dst_file);
      create index if not exists idx_edges_src on edges(src_file);
      create index if not exists idx_edges_kind on edges(edge_kind);

      create table if not exists embedding_cache(
        provider_id text not null,
        provider_dims integer not null,
        model_version text not null,
        content_hash text not null,
        embedding blob not null,
        updated_at text not null,
        primary key(provider_id, provider_dims, model_version, content_hash)
      );
    `)

    ensureColumn(db, 'files', 'generated', 'integer not null default 0')
    ensureColumn(db, 'chunks', 'generated', 'integer not null default 0')
  }

  private clearIndex(db: Database.Database): void {
    db.exec(`
      delete from symbols;
      delete from edges;
      delete from chunks_fts;
      delete from chunks;
      delete from files;
      delete from embedding_cache;
      delete from meta;
    `)
  }

  private lookupChunkLocation(id: string): { file: string; startLine: number; endLine: number } | null {
    if (!existsSync(this.indexPath)) {
      return null
    }

    const db = this.openDatabase()
    const row = db
      .prepare<[string], ChunkLocationRow>(
        'select file_path, start_line, end_line from chunks where id = ? limit 1'
      )
      .get(id)

    if (!row) {
      return null
    }

    return {
      file: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line
    }
  }

  private ensureIndexCompatibleForQueries(db: Database.Database): void {
    const compatibility = this.getIndexCompatibility(db)
    if (!compatibility.ok) {
      throw new IndexCompatibilityError(compatibility)
    }
  }

  private getIndexCompatibility(db: Database.Database, indexedOverride?: boolean): IndexCompatibilityStatus {
    const indexed = indexedOverride ?? readChunkCount(db) > 0
    if (!indexed) {
      return { ok: true }
    }

    const provider = this.resolveProvider()
    const expected: IndexCompatibilitySnapshot = {
      schemaVersion: SCHEMA_VERSION,
      providerId: provider.id,
      providerDims: provider.dims,
      modelVersion: provider.modelVersion ?? provider.model ?? provider.id
    }
    const actualSchemaVersion = readMeta(db, 'schema_version')
    const actualProviderId = readMeta(db, 'provider_id')
    const actualProviderDims = readMetaNumber(db, 'provider_dims')
    const actualModelVersion = readMeta(db, 'model_version')
    const actual: IndexCompatibilitySnapshot = {
      ...(actualSchemaVersion ? { schemaVersion: actualSchemaVersion } : {}),
      ...(actualProviderId ? { providerId: actualProviderId } : {}),
      ...(actualProviderDims !== undefined ? { providerDims: actualProviderDims } : {}),
      ...(actualModelVersion ? { modelVersion: actualModelVersion } : {})
    }

    if (actual.schemaVersion !== expected.schemaVersion) {
      return buildCompatibilityMismatch('schema_version_mismatch', actual, expected)
    }

    if (actual.providerId !== expected.providerId) {
      return buildCompatibilityMismatch('provider_mismatch', actual, expected)
    }

    if (actual.providerDims !== expected.providerDims) {
      return buildCompatibilityMismatch('provider_dims_mismatch', actual, expected)
    }

    if ((actual.modelVersion ?? undefined) !== (expected.modelVersion ?? undefined)) {
      return buildCompatibilityMismatch('model_version_mismatch', actual, expected)
    }

    return { ok: true }
  }

  private async resetDatabaseFile(): Promise<void> {
    if (this.db) {
      this.db.close()
      this.db = undefined
    }

    this.vectorExtensionLoaded = false
    this.vectorSearchFailure = null
    await Promise.all([
      rm(this.indexPath, { force: true }),
      removeDatabaseSidecars(this.indexPath)
    ])
  }
}

function applySyncChanges(db: Database.Database, context: SyncApplyContext): void {
  const insertFile = db.prepare(
    `
      insert into files(path, language, hash, size, mtime, generated)
      values (@path, @language, @hash, @size, @mtime, @generated)
    `
  )
  const updateFileManifest = db.prepare(
    `
      update files
      set language = @language,
          hash = @hash,
          size = @size,
          mtime = @mtime,
          generated = @generated
      where path = @path
    `
  )
  const insertChunk = db.prepare(
    `
      insert into chunks(
        id,
        file_path,
        language,
        start_line,
        end_line,
        symbol,
        kind,
        parent,
        signature,
        snippet,
        generated,
        embedding
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
  const insertChunkFts = db.prepare(
    `
      insert into chunks_fts(chunk_id, search_text, symbol, parent, signature)
      values (?, ?, ?, ?, ?)
    `
  )
  const insertSymbol = db.prepare(
    `
      insert into symbols(name, kind, file_path, start_line, end_line, parent, signature, language)
      values (?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
  const insertEdge = db.prepare(
    `
      insert into edges(src_file, src_line, src_symbol, dst_name, dst_file, edge_kind, resolution, language)
      values (?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
  const upsertEmbeddingCache = db.prepare(
    `
      insert into embedding_cache(provider_id, provider_dims, model_version, content_hash, embedding, updated_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(provider_id, provider_dims, model_version, content_hash)
      do update set embedding = excluded.embedding, updated_at = excluded.updated_at
    `
  )
  const setMeta = db.prepare(`
    insert into meta(key, value)
    values (?, ?)
    on conflict(key) do update set value = excluded.value
  `)
  const deleteMeta = db.prepare('delete from meta where key = ?')
  const selectChunkIdsByFile = db.prepare<[string], { id: string }>('select id from chunks where file_path = ?')
  const deleteChunkFts = db.prepare<[string]>('delete from chunks_fts where chunk_id = ?')
  const deleteSymbolsByFile = db.prepare<[string]>('delete from symbols where file_path = ?')
  const deleteEdgesBySrcFile = db.prepare<[string]>('delete from edges where src_file = ?')
  const deleteEdgesByDstFile = db.prepare<[string]>('delete from edges where dst_file = ?')
  const deleteChunksByFile = db.prepare<[string]>('delete from chunks where file_path = ?')
  const deleteFile = db.prepare<[string]>('delete from files where path = ?')
  const replacementPaths = [...context.diff.removedPaths, ...context.diff.changedFiles.map((file) => file.relativePath)]
  const symbolRangesByFile = groupSymbolRangesByFile(context.embeddedChunks)

  db.transaction(() => {
    for (const filePath of replacementPaths) {
      for (const { id } of selectChunkIdsByFile.all(filePath)) {
        deleteChunkFts.run(id)
      }

      deleteSymbolsByFile.run(filePath)
      deleteEdgesBySrcFile.run(filePath)
      deleteChunksByFile.run(filePath)
      deleteFile.run(filePath)
    }

    for (const removedPath of context.diff.removedPaths) {
      deleteEdgesByDstFile.run(removedPath)
    }

    for (const file of context.diff.touchedFiles) {
      updateFileManifest.run(fileToManifestRow(file))
    }

    for (const file of context.diff.changedFiles) {
      insertFile.run(fileToManifestRow(file))

      for (const edge of extractEdges(file, symbolRangesByFile.get(file.relativePath) ?? [])) {
        insertEdge.run(
          edge.srcFile,
          edge.srcLine,
          edge.srcSymbol ?? null,
          edge.dstName,
          edge.dstFile ?? null,
          edge.edgeKind,
          edge.resolution,
          edge.language ?? null
        )
      }
    }

    for (const { row, embedding } of context.embeddedChunks) {
      insertChunk.run(
        row.id,
        row.file,
        row.language,
        row.startLine,
        row.endLine,
        row.symbol ?? null,
        row.kind ?? null,
        row.parent ?? null,
        row.signature ?? null,
        row.content,
        row.generated ? 1 : 0,
        embedding
      )

      insertChunkFts.run(
        row.id,
        buildLexicalSearchText(row),
        row.symbol ?? '',
        row.parent ?? '',
        row.signature ?? ''
      )

      upsertEmbeddingCache.run(
        context.provider.id,
        context.provider.dims,
        context.provider.modelVersion,
        contentHashForChunk(row),
        embedding,
        context.completedAt
      )

      if (row.symbol && row.kind && row.kind !== 'file') {
        insertSymbol.run(
          row.symbol,
          row.kind,
          row.file,
          row.startLine,
          row.endLine,
          row.parent ?? null,
          row.signature ?? null,
          row.language
        )
      }
    }

    setMeta.run('schema_version', SCHEMA_VERSION)
    setMeta.run('provider_id', context.provider.id)
    setMeta.run('provider_dims', String(context.provider.dims))
    setMeta.run('model_version', context.provider.modelVersion)
    setMeta.run('indexed_at', context.completedAt)
    setMeta.run('index_generation', String(context.previousGeneration + 1))
    writeGitSnapshotMeta(setMeta, deleteMeta, context.gitSnapshot)
    writeSyncStatusWithStatements(setMeta, deleteMeta, {
      state: 'completed',
      startedAt: context.syncStartedAt,
      completedAt: context.completedAt
    })
  })()
}

function extractEdges(file: ScannedFile, symbolRanges: SourceSymbolRange[]): Edge[] {
  if (isTypeScriptLike(file.language)) {
    return extractTypeScriptEdges(file, symbolRanges)
  }

  if (isPythonLike(file.language)) {
    return extractPythonEdges(file, symbolRanges)
  }

  if (isGoLike(file.language) || isJavaLike(file.language) || isRubyLike(file.language) || isRustLike(file.language)) {
    return extractNameOnlyCallEdges(file, symbolRanges)
  }

  return []
}

function groupSymbolRangesByFile(records: EmbeddedChunkRecord[]): Map<string, SourceSymbolRange[]> {
  const rangesByFile = new Map<string, SourceSymbolRange[]>()

  for (const { row } of records) {
    if (!row.symbol || !row.kind || row.kind === 'file') {
      continue
    }

    const ranges = rangesByFile.get(row.file) ?? []
    ranges.push({
      startLine: row.startLine,
      endLine: row.endLine,
      symbol: row.symbol,
      kind: row.kind
    })
    rangesByFile.set(row.file, ranges)
  }

  return rangesByFile
}

function fileToManifestRow(file: ScannedFile): IndexedFileRow {
  return {
    path: file.relativePath,
    language: file.language,
    hash: file.hash,
    size: file.size,
    mtime: file.mtime,
    generated: file.generated ? 1 : 0
  }
}

function selectIndexedFileRows(db: Database.Database): IndexedFileRow[] {
  return db
    .prepare<[], IndexedFileRow>(
      `
        select path, language, hash, size, mtime, generated
        from files
        order by path asc
      `
    )
    .all()
}

function selectCachedEmbeddings(
  db: Database.Database,
  key: Omit<EmbeddingCacheKey, 'contentHash'>,
  chunks: IndexedChunkRecord[]
): Map<string, Buffer> {
  const contentHashes = [...new Set(chunks.map(contentHashForChunk))]
  const result = new Map<string, Buffer>()
  const batchSize = 900

  for (let index = 0; index < contentHashes.length; index += batchSize) {
    const batch = contentHashes.slice(index, index + batchSize)
    if (batch.length === 0) {
      continue
    }

    const selectCached = db.prepare<unknown[], EmbeddingCacheRow>(
      `
        select content_hash, embedding
        from embedding_cache
        where provider_id = ?
          and provider_dims = ?
          and model_version = ?
          and content_hash in (${batch.map(() => '?').join(', ')})
      `
    )

    for (const row of selectCached.all(key.providerId, key.providerDims, key.modelVersion, ...batch)) {
      result.set(row.content_hash, row.embedding)
    }
  }

  return result
}

function contentHashForChunk(chunk: Pick<ChunkRecord, 'content'>): string {
  return hashText(chunk.content)
}

function diffScannedFiles(files: ScannedFile[], indexedFiles: IndexedFileRow[]): SyncDiff {
  const indexedByPath = new Map(indexedFiles.map((file) => [file.path, file]))
  const scannedPaths = new Set<string>()
  const changedFiles: ScannedFile[] = []
  const touchedFiles: ScannedFile[] = []

  for (const file of files) {
    scannedPaths.add(file.relativePath)
    const indexed = indexedByPath.get(file.relativePath)
    const generated = file.generated ? 1 : 0

    if (!indexed) {
      changedFiles.push(file)
      continue
    }

    if (indexed.hash !== file.hash || indexed.language !== file.language || indexed.generated !== generated) {
      changedFiles.push(file)
      continue
    }

    if (indexed.size !== file.size || !mtimeEqual(indexed.mtime, file.mtime)) {
      touchedFiles.push(file)
    }
  }

  const removedPaths = indexedFiles
    .map((file) => file.path)
    .filter((filePath) => !scannedPaths.has(filePath))

  return { changedFiles, touchedFiles, removedPaths }
}

function createFreshIndexStatus(): IndexFreshnessStatus {
  return {
    stale: false,
    reasons: []
  }
}

function readSyncStatus(db: Database.Database): RepoSyncStatus {
  const state = readMeta(db, 'last_sync_status') as RepoSyncStatus['state'] | null
  if (!state) {
    return { state: 'idle' }
  }

  const startedAt = readMeta(db, 'last_sync_started_at')
  const completedAt = readMeta(db, 'last_sync_completed_at')
  const error = readMeta(db, 'last_sync_error')
  const completedChunks = readMetaNumber(db, 'last_sync_completed_chunks')
  const totalChunks = readMetaNumber(db, 'last_sync_total_chunks')

  return {
    state,
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(error ? { error } : {}),
    ...(completedChunks !== undefined ? { completedChunks } : {}),
    ...(totalChunks !== undefined ? { totalChunks } : {})
  }
}

function writeSyncStatus(db: Database.Database, status: RepoSyncStatus): void {
  const setMeta = db.prepare(`
    insert into meta(key, value)
    values (?, ?)
    on conflict(key) do update set value = excluded.value
  `)
  const deleteMeta = db.prepare('delete from meta where key = ?')

  db.transaction(() => {
    writeSyncStatusWithStatements(setMeta, deleteMeta, status)
  })()
}

function writeSyncStatusWithStatements(
  setMeta: { run(key: string, value: string): unknown },
  deleteMeta: { run(key: string): unknown },
  status: RepoSyncStatus
): void {
  setMeta.run('last_sync_status', status.state)

  if (status.startedAt) {
    setMeta.run('last_sync_started_at', status.startedAt)
  } else {
    deleteMeta.run('last_sync_started_at')
  }

  if (status.completedAt) {
    setMeta.run('last_sync_completed_at', status.completedAt)
  } else {
    deleteMeta.run('last_sync_completed_at')
  }

  if (status.error) {
    setMeta.run('last_sync_error', status.error)
  } else {
    deleteMeta.run('last_sync_error')
  }

  if (status.completedChunks !== undefined) {
    setMeta.run('last_sync_completed_chunks', String(status.completedChunks))
  } else {
    deleteMeta.run('last_sync_completed_chunks')
  }

  if (status.totalChunks !== undefined) {
    setMeta.run('last_sync_total_chunks', String(status.totalChunks))
  } else {
    deleteMeta.run('last_sync_total_chunks')
  }
}

async function getIndexFreshness(root: string, db: Database.Database): Promise<IndexFreshnessStatus> {
  const indexedFiles = selectIndexedFileRows(db)
  if (indexedFiles.length === 0) {
    return createFreshIndexStatus()
  }

  const currentManifest = await scanRepositoryManifest(root)
  const indexedByPath = new Map(indexedFiles.map((file) => [file.path, file]))
  const currentByPath = new Map(currentManifest.files.map((file) => [file.relativePath, file]))
  const addedPaths: string[] = []
  const modifiedPaths: string[] = []
  const removedPaths: string[] = []

  for (const file of currentManifest.files) {
    const indexed = indexedByPath.get(file.relativePath)
    if (!indexed) {
      addedPaths.push(file.relativePath)
      continue
    }

    if (indexed.size !== file.size || !mtimeEqual(indexed.mtime, file.mtime)) {
      modifiedPaths.push(file.relativePath)
    }
  }

  for (const file of indexedFiles) {
    if (!currentByPath.has(file.path)) {
      removedPaths.push(file.path)
    }
  }

  const reasons: RepoStaleReason[] = []
  if (addedPaths.length > 0) {
    reasons.push(buildFileStaleReason('file_added', addedPaths, 'new indexable files are not indexed'))
  }

  if (modifiedPaths.length > 0) {
    reasons.push(buildFileStaleReason('file_modified', modifiedPaths, 'indexed files changed on disk'))
  }

  if (removedPaths.length > 0) {
    reasons.push(buildFileStaleReason('file_removed', removedPaths, 'indexed files were removed'))
  }

  const indexedGit = readIndexedGitSnapshot(db)
  const currentGit = await readGitSnapshot(root)
  if (!gitSnapshotsEqual(indexedGit, currentGit)) {
    if (indexedGit?.branch !== currentGit?.branch) {
      reasons.push(buildGitStaleReason('git_branch_changed', 'git branch changed since indexing', indexedGit?.branch, currentGit?.branch))
    }

    if (indexedGit?.head !== currentGit?.head) {
      reasons.push(buildGitStaleReason('git_head_changed', 'git HEAD changed since indexing', indexedGit?.head, currentGit?.head))
    }
  }

  return {
    stale: reasons.length > 0,
    reasons
  }
}

function buildFileStaleReason(code: RepoStaleReason['code'], files: string[], label: string): RepoStaleReason {
  return {
    code,
    message: `${files.length} ${label}`,
    count: files.length,
    files: files.slice(0, 8)
  }
}

function buildGitStaleReason(code: RepoStaleReason['code'], message: string, indexed: string | undefined, current: string | undefined): RepoStaleReason {
  return {
    code,
    message,
    ...(indexed ? { indexed } : {}),
    ...(current ? { current } : {})
  }
}

function readIndexedGitSnapshot(db: Database.Database): GitSnapshot | null {
  const branch = readMeta(db, 'git_branch')
  const head = readMeta(db, 'git_head')
  return branch && head ? { branch, head } : null
}

async function readGitSnapshot(root: string): Promise<GitSnapshot | null> {
  const gitDirectory = await findGitDirectory(root)
  if (!gitDirectory) {
    return null
  }

  const headContent = await readOptionalText(join(gitDirectory, 'HEAD'))
  const headValue = headContent?.trim()
  if (!headValue) {
    return null
  }

  if (!headValue.startsWith('ref:')) {
    return /^[a-f0-9]{40,64}$/i.test(headValue) ? { branch: 'HEAD', head: headValue } : null
  }

  const ref = headValue.slice(4).trim()
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
  const looseRef = await readOptionalText(join(gitDirectory, ref))
  const head = looseRef?.trim() ?? (await readPackedRef(gitDirectory, ref))

  return head ? { branch, head } : null
}

export async function findRepoRoot(startPath = process.cwd()): Promise<string> {
  let current = resolve(startPath)

  while (true) {
    const dotGit = join(current, '.git')
    if (existsSync(dotGit)) {
      return current
    }

    const parent = dirname(current)
    if (parent === current) {
      return resolve(startPath)
    }

    current = parent
  }
}

async function findGitDirectory(root: string): Promise<string | null> {
  let current = resolve(root)

  while (true) {
    const dotGit = join(current, '.git')
    if (existsSync(dotGit)) {
      const gitFile = await readOptionalText(dotGit)
      if (gitFile?.startsWith('gitdir:')) {
        const gitDir = gitFile.slice('gitdir:'.length).trim()
        return isAbsolute(gitDir) ? gitDir : resolve(current, gitDir)
      }

      return dotGit
    }

    const parent = dirname(current)
    if (parent === current) {
      return null
    }

    current = parent
  }
}

async function readPackedRef(gitDirectory: string, ref: string): Promise<string | null> {
  const packedRefs = await readOptionalText(join(gitDirectory, 'packed-refs'))
  if (!packedRefs) {
    return null
  }

  for (const line of packedRefs.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('^')) {
      continue
    }

    const [sha, packedRef] = line.trim().split(/\s+/, 2)
    if (packedRef === ref && sha && /^[a-f0-9]{40,64}$/i.test(sha)) {
      return sha
    }
  }

  return null
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function gitSnapshotsEqual(left: GitSnapshot | null, right: GitSnapshot | null): boolean {
  if (!left && !right) {
    return true
  }

  return left?.branch === right?.branch && left?.head === right?.head
}

function writeGitSnapshotMeta(
  setMeta: { run(key: string, value: string): unknown },
  deleteMeta: { run(key: string): unknown },
  snapshot: GitSnapshot | null
): void {
  if (!snapshot) {
    deleteMeta.run('git_branch')
    deleteMeta.run('git_head')
    return
  }

  setMeta.run('git_branch', snapshot.branch)
  setMeta.run('git_head', snapshot.head)
}

function markStaleHits(hits: SearchHit[], freshness: IndexFreshnessStatus): SearchHit[] {
  if (!freshness.stale) {
    return hits
  }

  return hits.map((hit) => ({
    ...hit,
    stale: true
  }))
}

async function getWatchDirectories(root: string): Promise<Set<string>> {
  const manifest = await scanRepositoryManifest(root)
  const rootPath = resolve(root)
  const directories = new Set<string>([rootPath])

  for (const file of manifest.files) {
    let directory = dirname(resolve(rootPath, file.relativePath))
    while (isPathInsideRoot(rootPath, directory)) {
      directories.add(directory)
      if (normalizePath(directory) === normalizePath(rootPath)) {
        break
      }
      directory = dirname(directory)
    }
  }

  return directories
}

function isIgnoredWatchEvent(fileName: string): boolean {
  const normalized = fileName.replace(/\\/g, '/')
  return normalized === '.codesift' || normalized.startsWith('.codesift/') || normalized === '.git' || normalized.startsWith('.git/')
}

function normalizeWatchDebounceMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_WATCH_DEBOUNCE_MS
  }

  return Math.max(100, Math.floor(value))
}

function mtimeEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= MTIME_TOLERANCE_MS
}

function normalizeKinds(kind: SearchOptions['kind'] | FindSymbolOptions['kind'] | undefined): SymbolKind[] {
  if (!kind) {
    return []
  }

  return Array.isArray(kind) ? kind : [kind]
}

function withResultMetadata<T>(items: T[], metadata: ResultMetadata): ResultList<T> {
  if (Object.keys(metadata).length === 0) {
    return items as ResultList<T>
  }

  Object.defineProperty(items, 'meta', {
    value: metadata,
    enumerable: false,
    configurable: true
  })
  return items as ResultList<T>
}

function countDistinctDefinitionSites(rows: SymbolRow[]): number {
  return new Set(rows.map((row) => `${row.file_path}\u0000${row.kind}`)).size
}

function shouldAttachFindSymbolRelations(options: FindSymbolOptions | undefined, canEnrichTopExactRow: boolean): boolean {
  if (!canEnrichTopExactRow || options?.withCallers === false) {
    return false
  }

  if (options?.withCallers === true) {
    return true
  }

  return options?.maxTokens === undefined || options.maxTokens >= FIND_SYMBOL_RELATION_MIN_BUDGET
}

function shouldAttachSearchRelations(options: SearchOptions | undefined, autoSingleBest: boolean): boolean {
  if (options?.withRelations === false) {
    return false
  }

  if (options?.withRelations === true || options?.context === 'graph') {
    return true
  }

  if (options?.context === 'min' || options?.context === 'sig') {
    return false
  }

  return autoSingleBest
}

async function attachRelationsToTopDefinitionHit(
  db: Database.Database,
  _root: string,
  hits: SearchHit[],
  options: SearchOptions | undefined,
  readRelations: (definition: SymbolRow) => Promise<SymbolRelations | undefined>
): Promise<void> {
  const topHit = hits[0]
  if (!topHit?.symbol || !topHit.kind || topHit.kind === 'file') {
    return
  }

  if (options?.maxTokens !== undefined && options.maxTokens < SEARCH_RELATION_MIN_BUDGET) {
    return
  }

  const definition = selectDefinitionRowForSearchHit(db, topHit)
  if (!definition) {
    return
  }

  const relations = await readRelations(definition)
  if (!relations || !relationsFitBudget(relations, options?.maxTokens, hits.reduce((sum, hit) => sum + hit.tokensReturned, 0))) {
    return
  }

  topHit.relations = relations
  topHit.tokensReturned += estimateSymbolRelationsTokens(relations)
}

function relationsFitBudget(relations: SymbolRelations | undefined, maxTokens: number | undefined, tokensUsed: number): relations is SymbolRelations {
  if (!relations) {
    return false
  }

  if (maxTokens === undefined) {
    return true
  }

  return tokensUsed + estimateSymbolRelationsTokens(relations) <= maxTokens
}

function estimateSymbolBodyTokens(body: string | undefined): number {
  return body ? estimateTokenCount(body) : 0
}

function estimateSymbolRelationsTokens(relations: SymbolRelations): number {
  const siteTokens = relations.sites.reduce((sum, site) => sum + estimateEdgeResultTokens(site), 0)
  const neighborTokens = relations.neighbors.reduce((sum, neighbor) => {
    const header = `${neighbor.file}:${neighbor.range.startLine}-${neighbor.range.endLine} ${neighbor.name} ${neighbor.kind}`
    return sum + SEARCH_HIT_TOKEN_OVERHEAD + estimateTokenCount(header)
  }, 0)
  const omittedTokens = relations.omitted ? estimateTokenCount(`relations_omitted=${relations.omitted}`) : 0
  return siteTokens + neighborTokens + omittedTokens
}

function selectDefinitionRowForSearchHit(db: Database.Database, hit: SearchHit): SymbolRow | undefined {
  if (!hit.symbol || !hit.kind) {
    return undefined
  }

  return db
    .prepare<unknown[], SymbolRow>(
      `
        select id, name, file_path, start_line, end_line, kind, signature, parent, language
        from symbols
        where file_path = ?
          and lower(name) = lower(?)
          and kind = ?
        order by
          case when start_line = ? and end_line = ? then 0 else 1 end,
          abs(start_line - ?) asc,
          id asc
        limit 1
      `
    )
    .get(hit.file, hit.symbol, hit.kind, hit.range.startLine, hit.range.endLine, hit.range.startLine)
}

function normalizeChangesetFiles(files: string[]): string[] {
  const normalized = new Set<string>()
  for (const file of files) {
    const candidate = normalizeRelativeRepoPath(file.trim())
    if (!candidate || candidate === '.' || candidate.startsWith('../') || candidate === '..') {
      continue
    }
    normalized.add(candidate)
  }
  return [...normalized]
}

function normalizeChangesetMaxFiles(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_CHANGESET_MAX_FILES
  }

  return Math.min(Math.floor(value), DEFAULT_CHANGESET_MAX_FILES)
}

function normalizeChangesetMaxEdges(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_CHANGESET_MAX_EDGES_PER_FILE
  }

  return Math.min(Math.floor(value), NAME_ONLY_EDGE_DEFAULT_LIMIT)
}

type RangeReader = (file: string, startLine: number, endLine: number) => Promise<string>

async function buildBudgetedSearchHits(
  query: string,
  rows: RankedChunkRow[],
  requestedK: number,
  maxTokens: number | undefined,
  context: SearchOptions['context'],
  readRange: RangeReader
): Promise<SearchHit[]> {
  const tokenBudget = normalizeSearchTokenBudget(maxTokens)
  const hits: SearchHit[] = []
  let tokensUsed = 0
  const topScore = rows[0] ? rows[0].score * scoreBoostForRow(rows[0].row, query) : 0

  for (let index = 0; index < rows.length; index += 1) {
    if (hits.length >= requestedK) {
      break
    }

    const ranked = rows[index]!
    const remainingTokens = tokenBudget === undefined ? undefined : tokenBudget - tokensUsed
    if (remainingTokens !== undefined && remainingTokens <= SEARCH_HIT_TOKEN_OVERHEAD) {
      break
    }

    const snippetTokenBudget = remainingTokens === undefined
      ? DEFAULT_SNIPPET_TOKEN_BUDGET
      : Math.max(8, Math.min(DEFAULT_SNIPPET_TOKEN_BUDGET, remainingTokens - SEARCH_HIT_TOKEN_OVERHEAD))
    const hit = buildSearchHit(ranked, query, snippetTokenBudget)

    if (
      shouldInlineHit(context, index, hit.score, topScore) &&
      (await tryInlineBody(hit, ranked, readRange, {
        tokenBudget,
        tokensUsed,
        isFirstHit: hits.length === 0,
        hasMoreRows: index + 1 < rows.length && hits.length + 1 < requestedK
      }))
    ) {
      hits.push(hit)
      tokensUsed += hit.tokensReturned
      continue
    }

    if (tokenBudget !== undefined && tokensUsed + hit.tokensReturned > tokenBudget) {
      if (hits.length > 0) {
        break
      }

      const forcedSnippetBudget = Math.max(0, tokenBudget - SEARCH_HIT_TOKEN_OVERHEAD)
      const forcedHit = buildSearchHit(ranked, query, forcedSnippetBudget)
      hits.push(forcedHit)
      break
    }

    hits.push(hit)
    tokensUsed += hit.tokensReturned
  }

  return hits
}

function shouldInlineHit(
  context: SearchOptions['context'],
  index: number,
  hitScore: number,
  topScore: number
): boolean {
  if (context === 'sig') {
    return false
  }

  if (context === 'min' || context === 'graph') {
    return false
  }

  if (context === 'body') {
    return true
  }

  if (index === 0) {
    return true
  }

  if (index === 1) {
    return topScore > 0 && hitScore >= INLINE_RANK2_SCORE_MARGIN * topScore
  }

  return false
}

/**
 * Attach a verbatim, disk-fresh enclosing-symbol body to {@link hit} when the
 * token budget allows, returning true on success. Mutates `hit.body` and
 * `hit.tokensReturned`. Never throws: a disk failure, an out-of-range read, or
 * a budget overflow leaves the compact hit untouched and returns false so the
 * caller keeps the existing query-centered snippet.
 */
async function tryInlineBody(
  hit: SearchHit,
  ranked: RankedChunkRow,
  readRange: RangeReader,
  budget: {
    tokenBudget: number | undefined
    tokensUsed: number
    isFirstHit: boolean
    hasMoreRows: boolean
  }
): Promise<boolean> {
  let source: string
  try {
    source = await readRange(hit.file, hit.range.startLine, hit.range.endLine)
  } catch {
    return false
  }

  const { body, tokens } = capInlineBody(source, chunkLocator(hit.file, hit.range.startLine, hit.range.endLine))
  if (!body) {
    return false
  }

  const header = `${hit.file}:${hit.range.startLine}-${hit.range.endLine} ${ranked.row.symbol ?? ''} ${ranked.row.kind ?? ''}`
  const bodyTokensReturned = SEARCH_HIT_TOKEN_OVERHEAD + estimateTokenCount(header) + tokens

  if (budget.tokenBudget !== undefined) {
    const projected = budget.tokensUsed + bodyTokensReturned
    // Hit-1's body alone must never consume the whole budget when more hits
    // could otherwise appear; reserve room for at least one compact tail hit.
    const reserve = budget.isFirstHit && budget.hasMoreRows ? SEARCH_HIT_TOKEN_OVERHEAD + 8 : 0
    if (projected + reserve > budget.tokenBudget) {
      return false
    }
  }

  hit.body = body
  hit.tokensReturned = bodyTokensReturned
  return true
}

/**
 * Cap an inlined body to ~{@link INLINE_BODY_MAX_TOKENS} tokens OR
 * ~{@link INLINE_BODY_MAX_LINES} lines, whichever is smaller, appending a
 * truncation marker when the source overflows. Before capping, runs of blank
 * lines are collapsed to one and the leading indentation common to the whole
 * block is stripped (dedented) — code is never reordered, dropped, or per-line
 * trimmed. The MCP renderer re-adds `NN | ` line prefixes, so absolute column
 * stays recoverable from the line number, and that prefix cost is folded into
 * the returned token count.
 */
function capInlineBody(source: string, locator: string): { body: string; tokens: number } {
  if (!source) {
    return { body: '', tokens: 0 }
  }

  let lines = collapseBlankRuns(source.split('\n'))
  const dedent = commonLeadingWhitespace(lines)
  if (dedent) {
    lines = lines.map((line) => (line.startsWith(dedent) ? line.slice(dedent.length) : line))
  }

  let truncated = false
  let kept = lines

  if (kept.length > INLINE_BODY_MAX_LINES) {
    kept = kept.slice(0, INLINE_BODY_MAX_LINES)
    truncated = true
  }

  while (renderedBodyTokens(kept.join('\n')) > INLINE_BODY_MAX_TOKENS && kept.length > 1) {
    kept = kept.slice(0, -1)
    truncated = true
  }

  const body = truncated ? `${kept.join('\n')}\n${INLINE_BODY_TRUNCATION_MARKER(locator)}` : kept.join('\n')
  return { body, tokens: renderedBodyTokens(body) }
}

function chunkLocator(file: string, startLine: number, endLine: number): string {
  return `${file}:${startLine}-${endLine}`
}

/** Token count of a body INCLUDING the per-line `NN | ` render prefix. */
function renderedBodyTokens(text: string): number {
  if (!text) {
    return 0
  }
  return estimateTokenCount(text) + text.split('\n').length * PREFIX_TOKEN_COST
}

/** Collapse runs of 2+ consecutive blank lines into a single blank line. */
function collapseBlankRuns(lines: string[]): string[] {
  const out: string[] = []
  let lastBlank = false
  for (const line of lines) {
    const blank = line.trim() === ''
    if (blank && lastBlank) {
      continue
    }
    out.push(line)
    lastBlank = blank
  }
  return out
}

/** Longest leading-whitespace prefix shared by every non-blank line. */
function commonLeadingWhitespace(lines: string[]): string {
  let prefix: string | null = null
  for (const line of lines) {
    if (line.trim() === '') {
      continue
    }
    const leading = /^[ \t]*/.exec(line)![0]
    if (prefix === null) {
      prefix = leading
      continue
    }
    let index = 0
    const max = Math.min(prefix.length, leading.length)
    while (index < max && prefix[index] === leading[index]) {
      index += 1
    }
    prefix = prefix.slice(0, index)
    if (prefix === '') {
      break
    }
  }
  return prefix ?? ''
}

function buildSearchHit(ranked: RankedChunkRow, query: string, snippetTokenBudget: number): SearchHit {
  const row = ranked.row
  const score = ranked.score * scoreBoostForRow(row, query)
  const snippet = buildQueryCenteredSnippet(row, query, snippetTokenBudget)
  const reason = reasonTagForRankedRow(ranked)

  const hit: SearchHit = {
    id: row.id,
    file: row.file_path,
    range: {
      startLine: row.start_line,
      endLine: row.end_line
    },
    score,
    reason,
    snippet: snippet.text,
    snippetRange: snippet.range,
    tokensReturned: estimateSearchHitTokens(row, snippet.text)
  }

  if (row.language) {
    hit.language = row.language
  }

  if (row.symbol) {
    hit.symbol = row.symbol
  }

  if (row.parent) {
    hit.parent = row.parent
  }

  if (row.generated === 1) {
    hit.generated = true
  }

  if (row.kind) {
    hit.kind = row.kind
  }

  return hit
}

function normalizeSearchTokenBudget(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined
  }

  return Math.floor(value)
}

function normalizeImpactDepth(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_IMPACT_DEPTH
  }

  return Math.min(Math.floor(value), HARD_MAX_IMPACT_BOUND)
}

function normalizeImpactMaxNodes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_IMPACT_MAX_NODES
  }

  return Math.min(Math.floor(value), HARD_MAX_IMPACT_BOUND)
}

function estimateSearchHitTokens(row: ChunkRow, snippet: string): number {
  const header = `${row.file_path}:${row.start_line}-${row.end_line} ${row.symbol ?? ''} ${row.kind ?? ''}`
  // The compact renderer emits up to COMPACT_SNIPPET_MAX_LINES lines, each with a
  // `NN | ` prefix; reflect that prefix cost so the budget matches the output.
  const snippetLines = snippet ? Math.min(snippet.split('\n').length, COMPACT_SNIPPET_MAX_LINES) : 0
  return (
    SEARCH_HIT_TOKEN_OVERHEAD +
    estimateTokenCount(header) +
    estimateTokenCount(snippet) +
    snippetLines * PREFIX_TOKEN_COST
  )
}

function estimateTokenCount(value: string): number {
  if (!value.trim()) {
    return 0
  }

  return Math.max(1, Math.ceil(value.length / 4))
}

function buildQueryCenteredSnippet(
  row: ChunkRow,
  query: string,
  tokenBudget: number
): { text: string; range: { startLine: number; endLine: number } } {
  if (tokenBudget <= 0) {
    return { text: '', range: { startLine: row.start_line, endLine: row.start_line } }
  }

  const lines = splitLines(row.snippet)
  if (lines.length === 0) {
    return { text: '', range: { startLine: row.start_line, endLine: row.start_line } }
  }

  const centerIndex = bestSnippetCenterLine(lines, query)
  let startIndex = Math.max(0, centerIndex - DEFAULT_SNIPPET_CONTEXT_LINES)
  let endIndex = Math.min(lines.length - 1, centerIndex + DEFAULT_SNIPPET_CONTEXT_LINES)
  let selected = trimSnippetLines(lines.slice(startIndex, endIndex + 1))

  while (estimateTokenCount(selected.join('\n')) > tokenBudget && endIndex > startIndex) {
    const removeBefore = centerIndex - startIndex >= endIndex - centerIndex
    if (removeBefore && startIndex < centerIndex) {
      startIndex += 1
    } else {
      endIndex -= 1
    }
    selected = trimSnippetLines(lines.slice(startIndex, endIndex + 1))
  }

  let text = selected.join('\n').trim()
  if (estimateTokenCount(text) > tokenBudget) {
    text = truncateToTokenBudget(text, tokenBudget)
  }

  return {
    text,
    range: {
      startLine: row.start_line + startIndex,
      endLine: row.start_line + endIndex
    }
  }
}

function bestSnippetCenterLine(lines: string[], query: string): number {
  const queryTerms = new Set([...buildNormalizedTerms(query), ...extractSymbolCandidates(query)])
  if (queryTerms.size === 0) {
    return 0
  }

  let bestIndex = 0
  let bestScore = Number.NEGATIVE_INFINITY

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const normalizedLine = line.toLowerCase()
    const lineTerms = new Set(buildNormalizedTerms(line))
    let score = 0

    for (const term of queryTerms) {
      if (lineTerms.has(term) || normalizedLine.includes(term.toLowerCase())) {
        score += term.length > 3 ? 2 : 1
      }
    }

    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  }

  return bestIndex
}

function trimSnippetLines(lines: string[]): string[] {
  return lines
    .map((line) => {
      const trimmedRight = line.trimEnd()
      return trimmedRight.length > DEFAULT_SNIPPET_LINE_CHAR_LIMIT
        ? `${trimmedRight.slice(0, DEFAULT_SNIPPET_LINE_CHAR_LIMIT - 1)}…`
        : trimmedRight
    })
    .filter((line, index, all) => line.trim() || (index > 0 && index < all.length - 1))
}

function truncateToTokenBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0) {
    return ''
  }

  const maxChars = Math.max(1, tokenBudget * 4)
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

function reasonTagForRankedRow(row: RankedChunkRow): SearchReasonTag {
  if (row.reasons.has('=')) {
    return '='
  }

  if (row.reasons.has('~')) {
    return '~'
  }

  return '+'
}

function dedupeContainedRows(rows: RankedChunkRow[]): RankedChunkRow[] {
  const kept: RankedChunkRow[] = []

  for (const candidate of rows) {
    const isContained = kept.some((existing) => chunksOverlapOrContain(existing.row, candidate.row))
    if (!isContained) {
      kept.push(candidate)
    }
  }

  return kept
}

function chunksOverlapOrContain(left: ChunkRow, right: ChunkRow): boolean {
  if (left.file_path !== right.file_path) {
    return false
  }

  const overlapStart = Math.max(left.start_line, right.start_line)
  const overlapEnd = Math.min(left.end_line, right.end_line)
  if (overlapEnd < overlapStart) {
    return false
  }

  const leftLength = left.end_line - left.start_line + 1
  const rightLength = right.end_line - right.start_line + 1
  const overlapLength = overlapEnd - overlapStart + 1

  return overlapLength === Math.min(leftLength, rightLength)
}

function isSingleBestIdentifierQuery(query: string): boolean {
  const trimmed = query.trim()
  if (!trimmed || /\s/.test(trimmed)) {
    return false
  }

  return extractSymbolCandidates(trimmed).some((candidate) => candidate === trimmed.toLowerCase())
}

function buildChunkSearchFilters(options?: SearchOptions): { whereSql: string; params: string[] } {
  const whereClauses: string[] = []
  const params: string[] = []

  if (options?.lang && options.lang.length > 0) {
    whereClauses.push(`language in (${options.lang.map(() => '?').join(', ')})`)
    params.push(...options.lang)
  }

  const kinds = normalizeKinds(options?.kind)
  if (kinds.length > 0) {
    whereClauses.push(`kind in (${kinds.map(() => '?').join(', ')})`)
    params.push(...kinds)
  }

  if (options?.pathGlob) {
    whereClauses.push('codesift_minimatch(file_path, ?) = 1')
    params.push(options.pathGlob)
  }

  return {
    whereSql: whereClauses.length > 0 ? `where ${whereClauses.join(' and ')}` : '',
    params
  }
}

async function attachUsagesToTopDefinitionHit(
  db: Database.Database,
  root: string,
  hits: SearchHit[],
  options?: SearchOptions
): Promise<void> {
  const topDefinitionHit = hits.find((hit) => hit.symbol && hit.kind && hit.kind !== 'file' && hit.language)
  if (!topDefinitionHit?.symbol || !topDefinitionHit.kind || !topDefinitionHit.language) {
    return
  }

  const usages = await findImportResolvedUsages(db, root, topDefinitionHit, options)
  if (usages.length > 0) {
    topDefinitionHit.usages = usages
    topDefinitionHit.tokensReturned += usages.reduce((sum, usage) => sum + estimateTokenCount(`${usage.file}:${usage.line} ${usage.snippet}`), 0)
  }
}

const MAX_ATTACHED_USAGES = 5

async function findImportResolvedUsages(
  db: Database.Database,
  root: string,
  definition: SearchHit,
  options?: SearchOptions
): Promise<SymbolUsage[]> {
  if (
    !definition.symbol ||
    !definition.language ||
    (!isTypeScriptLike(definition.language) && !isPythonLike(definition.language))
  ) {
    return []
  }

  const targets = await resolveDefinitionEdgeTargets(root, [
    {
      name: definition.symbol,
      file_path: definition.file,
      language: definition.language
    }
  ])
  if (targets.length === 0) {
    return []
  }

  const rows = selectDefinitionUsageRows(db, targets, {
    excludedSrcFile: definition.file,
    excludedStartLine: definition.range.startLine,
    excludedEndLine: definition.range.endLine,
    ...(options?.pathGlob ? { pathGlob: options.pathGlob } : {}),
    limit: MAX_ATTACHED_USAGES
  })

  return readUsagesFromEdgeRows(root, rows)
}

async function readUsagesFromEdgeRows(root: string, rows: EdgeUsageRow[]): Promise<SymbolUsage[]> {
  const linesByFile = new Map<string, string[]>()
  const usages: SymbolUsage[] = []

  for (const row of rows) {
    let lines = linesByFile.get(row.src_file)
    if (!lines) {
      try {
        lines = splitLines(await readFile(resolve(root, row.src_file), 'utf8'))
        linesByFile.set(row.src_file, lines)
      } catch {
        continue
      }
    }

    const usage: SymbolUsage = {
      file: row.src_file,
      range: { startLine: row.src_line, endLine: row.src_line },
      line: row.src_line,
      snippet: (lines[row.src_line - 1] ?? '').trimEnd(),
      resolution: row.resolution
    }

    if (row.language) {
      usage.language = row.language
    }

    usages.push(usage)
  }

  return usages
}

function extractTypeScriptEdges(file: ScannedFile, symbolRanges: SourceSymbolRange[]): Edge[] {
  const sourceFile =
    getCachedTypeScriptSourceFile(file) ??
    ts.createSourceFile(file.relativePath, file.content, ts.ScriptTarget.Latest, true, scriptKindFromPath(file.relativePath))
  const directBindings = new Map<string, EdgeBinding>()
  const namespaceBindings = new Map<string, EdgeBinding>()
  const sameFileSymbols = collectSameFileSymbols(symbolRanges)
  const scopeDeclarations = collectTypeScriptUsageScopeDeclarations(sourceFile)
  const scopeStack: Array<Set<string>> = []
  const edgesByKey = new Map<string, Edge>()

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue
    }

    const moduleSpecifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null
    const dstFile = moduleSpecifier ? resolveTypeScriptModuleTarget(file, moduleSpecifier) : null
    const clause = statement.importClause
    if (!clause) {
      continue
    }

    if (clause.name && dstFile) {
      directBindings.set(clause.name.text, { dstName: 'default', dstFile, resolution: 'import-resolved' })
      pushEdge(
        edgesByKey,
        buildEdge({
          srcFile: file.relativePath,
          srcLine: lineNumberForOffsetInSourceFile(sourceFile, clause.name.getStart(sourceFile)),
          srcSymbol: selectEnclosingSourceSymbol(symbolRanges, lineNumberForOffsetInSourceFile(sourceFile, clause.name.getStart(sourceFile))),
          dstName: 'default',
          dstFile,
          edgeKind: 'import',
          resolution: 'import-resolved',
          language: file.language
        })
      )
    }

    const namedBindings = clause.namedBindings
    if (!namedBindings) {
      continue
    }

    if (ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        const importedName = (element.propertyName ?? element.name).text
        if (!dstFile) {
          continue
        }

        directBindings.set(element.name.text, {
          dstName: importedName,
          dstFile,
          resolution: 'import-resolved'
        })
        const srcLine = lineNumberForOffsetInSourceFile(sourceFile, element.name.getStart(sourceFile))
        pushEdge(
          edgesByKey,
          buildEdge({
            srcFile: file.relativePath,
            srcLine,
            srcSymbol: selectEnclosingSourceSymbol(symbolRanges, srcLine),
            dstName: importedName,
            dstFile,
            edgeKind: 'import',
            resolution: 'import-resolved',
            language: file.language
          })
        )
      }
      continue
    }

    if (ts.isNamespaceImport(namedBindings) && dstFile) {
      namespaceBindings.set(namedBindings.name.text, {
        dstName: '*',
        dstFile,
        resolution: 'import-resolved'
      })
      const srcLine = lineNumberForOffsetInSourceFile(sourceFile, namedBindings.name.getStart(sourceFile))
      pushEdge(
        edgesByKey,
        buildEdge({
          srcFile: file.relativePath,
          srcLine,
          srcSymbol: selectEnclosingSourceSymbol(symbolRanges, srcLine),
          dstName: '*',
          dstFile,
          edgeKind: 'import',
          resolution: 'import-resolved',
          language: file.language
        })
      )
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) {
      continue
    }

    for (const clause of statement.heritageClauses ?? []) {
      const edgeKind = clause.token === ts.SyntaxKind.ImplementsKeyword
        ? 'implements'
        : clause.token === ts.SyntaxKind.ExtendsKeyword
          ? 'extends'
          : null
      if (!edgeKind) {
        continue
      }

      for (const typeNode of clause.types) {
        const binding = resolveTypeScriptHeritageTarget(typeNode.expression, directBindings, namespaceBindings, sameFileSymbols, file)
        if (!binding) {
          continue
        }

        const srcLine = lineNumberForOffsetInSourceFile(sourceFile, typeNode.expression.getStart(sourceFile))
        pushEdge(
          edgesByKey,
          buildEdge({
            srcFile: file.relativePath,
            srcLine,
            srcSymbol: selectEnclosingSourceSymbol(symbolRanges, srcLine),
            dstName: binding.dstName,
            ...(binding.dstFile ? { dstFile: binding.dstFile } : {}),
            edgeKind,
            resolution: binding.resolution,
            language: file.language
          })
        )
      }
    }
  }

  const visit = (node: ts.Node): void => {
    const declarations = scopeDeclarations.get(node)
    if (declarations) {
      scopeStack.push(declarations)
    }

    try {
      if ((ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) && ts.isIdentifier(node.expression)) {
        const binding = namespaceBindings.get(node.expression.text)
        if (binding?.dstFile) {
          const srcLine = lineNumberForOffsetInSourceFile(sourceFile, node.name.getStart(sourceFile))
          pushEdge(
            edgesByKey,
            buildEdge({
              srcFile: file.relativePath,
              srcLine,
              srcSymbol: selectEnclosingSourceSymbol(symbolRanges, srcLine),
              dstName: node.name.text,
              dstFile: binding.dstFile,
              edgeKind: isTypeScriptCallTarget(node) ? 'call' : 'ref',
              resolution: binding.resolution,
              language: file.language
            })
          )
        }
      }

      if (ts.isIdentifier(node) && isUsageIdentifier(node)) {
        const binding = directBindings.get(node.text)
        const srcLine = lineNumberForOffsetInSourceFile(sourceFile, node.getStart(sourceFile))
        if (binding?.dstFile) {
          pushEdge(
            edgesByKey,
            buildEdge({
              srcFile: file.relativePath,
              srcLine,
              srcSymbol: selectEnclosingSourceSymbol(symbolRanges, srcLine),
              dstName: binding.dstName,
              dstFile: binding.dstFile,
              edgeKind: isTypeScriptCallTarget(node) ? 'call' : 'ref',
              resolution: binding.resolution,
              language: file.language
            })
          )
        } else if (sameFileSymbols.has(node.text) && !isTypeScriptSameFileReferenceShadowed(node.text, scopeStack)) {
          pushEdge(
            edgesByKey,
            buildEdge({
              srcFile: file.relativePath,
              srcLine,
              srcSymbol: selectEnclosingSourceSymbol(symbolRanges, srcLine),
              dstName: node.text,
              dstFile: file.relativePath,
              edgeKind: isTypeScriptCallTarget(node) ? 'call' : 'ref',
              resolution: 'import-resolved',
              language: file.language
            })
          )
        }
      }

      ts.forEachChild(node, visit)
    } finally {
      if (declarations) {
        scopeStack.pop()
      }
    }
  }

  visit(sourceFile)
  return [...edgesByKey.values()]
}

function resolveTypeScriptHeritageTarget(
  expression: ts.Expression,
  directBindings: Map<string, EdgeBinding>,
  namespaceBindings: Map<string, EdgeBinding>,
  sameFileSymbols: Set<string>,
  file: ScannedFile
): EdgeBinding | undefined {
  if (ts.isIdentifier(expression)) {
    const binding = directBindings.get(expression.text)
    if (binding?.dstFile) {
      return binding
    }

    if (sameFileSymbols.has(expression.text)) {
      return {
        dstName: expression.text,
        dstFile: file.relativePath,
        resolution: 'import-resolved'
      }
    }

    return {
      dstName: expression.text,
      resolution: 'name-only'
    }
  }

  if ((ts.isPropertyAccessExpression(expression) || ts.isPropertyAccessChain(expression)) && ts.isIdentifier(expression.expression)) {
    const binding = namespaceBindings.get(expression.expression.text)
    if (binding?.dstFile) {
      return {
        dstName: expression.name.text,
        dstFile: binding.dstFile,
        resolution: binding.resolution
      }
    }

    return {
      dstName: expression.name.text,
      resolution: 'name-only'
    }
  }

  return undefined
}

function isUsageIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent
  if (!parent) {
    return true
  }

  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent)) {
    return false
  }

  if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent)) && parent.name === node) {
    return false
  }

  if ((ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node) {
    return false
  }

  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAccessChain(parent)) && parent.name === node) {
    return false
  }

  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return false
  }

  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
    return false
  }

  return true
}

function isTypeScriptCallTarget(node: ts.Node): boolean {
  const parent = node.parent
  if (!parent) {
    return false
  }

  return (
    ((ts.isCallExpression(parent) || ts.isCallChain(parent)) && parent.expression === node) ||
    (ts.isNewExpression(parent) && parent.expression === node) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === node)
  )
}

function extractPythonEdges(file: ScannedFile, symbolRanges: SourceSymbolRange[]): Edge[] {
  const lines = splitLines(file.content)
  const maskedLines = maskPythonLines(lines)
  const edgesByKey = new Map<string, Edge>()
  const directBindings = new Map<string, EdgeBinding>()
  const moduleBindings = new Map<string, EdgeBinding>()

  for (const symbol of collectSameFileSymbols(symbolRanges)) {
    directBindings.set(symbol, {
      dstName: symbol,
      dstFile: file.relativePath,
      resolution: 'import-resolved'
    })
  }

  for (let index = 0; index < maskedLines.length; index += 1) {
    const lineNumber = index + 1
    const trimmed = maskedLines[index]?.trim() ?? ''
    if (!trimmed) {
      continue
    }

    const fromImport = trimmed.match(/^from\s+([.A-Za-z0-9_]+)\s+import\s+(.+)$/)
    if (fromImport) {
      const dstFile = resolvePythonModuleTarget(file, fromImport[1]!)
      for (const part of fromImport[2]!.split(',')) {
        const match = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/)
        const importedName = match?.[1]
        if (!importedName) {
          continue
        }

        directBindings.set(match?.[2] ?? importedName, {
          dstName: importedName,
          ...(dstFile ? { dstFile } : {}),
          resolution: dstFile ? 'import-resolved' : 'name-only'
        })
      }
      continue
    }

    const importMatch = trimmed.match(/^import\s+([.A-Za-z0-9_]+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/)
    if (importMatch) {
      const moduleSpecifier = importMatch[1]!
      const dstFile = resolvePythonModuleTarget(file, moduleSpecifier)
      const localName = importMatch[2] ?? moduleSpecifier
      if (localName) {
        moduleBindings.set(localName, {
          dstName: '*',
          ...(dstFile ? { dstFile } : {}),
          resolution: dstFile ? 'import-resolved' : 'name-only'
        })
      }
    }
  }

  for (let index = 0; index < maskedLines.length; index += 1) {
    const lineNumber = index + 1
    const masked = maskedLines[index] ?? ''
    const trimmed = masked.trim()
    if (!trimmed || /^(from\s+.+\s+import\s+.+|import\s+.+|class\s+.+|def\s+.+)$/.test(trimmed)) {
      continue
    }

    for (const [alias, binding] of moduleBindings) {
      const pattern = new RegExp(`\\b${escapeRegExp(alias)}\\.([A-Za-z_][A-Za-z0-9_]*)\\b`, 'g')
      for (const match of masked.matchAll(pattern)) {
        const propertyName = match[1]
        const matchText = match[0]
        const matchIndex = match.index ?? -1
        if (!propertyName || matchIndex < 0) {
          continue
        }

        const edgeKind = /^\s*\(/.test(masked.slice(matchIndex + matchText.length)) ? 'call' : 'ref'
        pushEdge(
          edgesByKey,
          buildEdge({
            srcFile: file.relativePath,
            srcLine: lineNumber,
            srcSymbol: selectEnclosingSourceSymbol(symbolRanges, lineNumber),
            dstName: propertyName,
            ...(binding.dstFile ? { dstFile: binding.dstFile } : {}),
            edgeKind,
            resolution: binding.resolution,
            language: file.language
          })
        )
      }
    }

    for (const [localName, binding] of directBindings) {
      const pattern = new RegExp(`\\b${escapeRegExp(localName)}\\b`, 'g')
      for (const match of masked.matchAll(pattern)) {
        const matchText = match[0]
        const matchIndex = match.index ?? -1
        if (!matchText || matchIndex < 0) {
          continue
        }

        if (matchIndex > 0 && masked[matchIndex - 1] === '.') {
          continue
        }

        const edgeKind = /^\s*\(/.test(masked.slice(matchIndex + matchText.length)) ? 'call' : 'ref'
        pushEdge(
          edgesByKey,
          buildEdge({
            srcFile: file.relativePath,
            srcLine: lineNumber,
            srcSymbol: selectEnclosingSourceSymbol(symbolRanges, lineNumber),
            dstName: binding.dstName,
            ...(binding.dstFile ? { dstFile: binding.dstFile } : {}),
            edgeKind,
            resolution: binding.resolution,
            language: file.language
          })
        )
      }
    }
  }

  return [...edgesByKey.values()]
}

function extractNameOnlyCallEdges(file: ScannedFile, symbolRanges: SourceSymbolRange[]): Edge[] {
  const lines = splitLines(file.content)
  const maskedLines = isRubyLike(file.language) ? maskRubySyntaxLines(lines) : maskCStyleSyntax(lines)
  const callPattern = callPatternForNameOnlyLanguage(file.language)
  const edgesByKey = new Map<string, Edge>()

  for (let index = 0; index < maskedLines.length; index += 1) {
    const lineNumber = index + 1
    const masked = maskedLines[index] ?? ''
    const trimmed = masked.trim()
    if (!trimmed || shouldSkipNameOnlyCallLine(file.language, trimmed)) {
      continue
    }

    const enclosing = selectEnclosingSourceSymbolRange(symbolRanges, lineNumber)
    if (isGoLike(file.language) && enclosing?.kind && !['function', 'method', 'variable', 'constant'].includes(enclosing.kind)) {
      continue
    }

    for (const match of masked.matchAll(callPattern)) {
      const callee = match[1]
      const matchIndex = match.index ?? -1
      if (!callee || matchIndex < 0 || isNameOnlyCallKeyword(file.language, callee)) {
        continue
      }

      if (
        enclosing?.symbol === callee &&
        enclosing.startLine === lineNumber &&
        (enclosing.kind === 'function' || enclosing.kind === 'method')
      ) {
        continue
      }

      pushEdge(
        edgesByKey,
        buildEdge({
          srcFile: file.relativePath,
          srcLine: lineNumber,
          srcSymbol: enclosing?.symbol,
          dstName: callee,
          edgeKind: 'call',
          resolution: 'name-only',
          language: file.language
        })
      )
    }
  }

  return [...edgesByKey.values()]
}

function callPatternForNameOnlyLanguage(language: string): RegExp {
  if (isJavaLike(language)) {
    return /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g
  }

  if (isRubyLike(language)) {
    return /([A-Za-z_][A-Za-z0-9_!?=]*)\s*\(/g
  }

  return /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
}

function shouldSkipNameOnlyCallLine(language: string, trimmed: string): boolean {
  if (isGoLike(language)) {
    return /^(?:package|import)\b/.test(trimmed)
  }

  if (isJavaLike(language)) {
    return /^(?:package|import)\b/.test(trimmed) || trimmed.startsWith('@')
  }

  if (isRubyLike(language)) {
    return /^(?:class|module|def)\b/.test(trimmed)
  }

  if (isRustLike(language)) {
    return /^(?:use|mod)\b/.test(trimmed) || trimmed.startsWith('#[')
  }

  return false
}

function isNameOnlyCallKeyword(language: string, callee: string): boolean {
  if (isGoLike(language)) {
    return GO_NAME_ONLY_CALL_KEYWORDS.has(callee)
  }

  if (isJavaLike(language)) {
    return JAVA_NAME_ONLY_CALL_KEYWORDS.has(callee)
  }

  if (isRubyLike(language)) {
    return RUBY_NAME_ONLY_CALL_KEYWORDS.has(callee)
  }

  if (isRustLike(language)) {
    return RUST_NAME_ONLY_CALL_KEYWORDS.has(callee)
  }

  return false
}

const GO_NAME_ONLY_CALL_KEYWORDS = new Set(['if', 'for', 'switch', 'select'])
const JAVA_NAME_ONLY_CALL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'try', 'synchronized', 'do'])
const RUBY_NAME_ONLY_CALL_KEYWORDS = new Set(['if', 'unless', 'while', 'until', 'for', 'case'])
const RUST_NAME_ONLY_CALL_KEYWORDS = new Set(['if', 'for', 'while', 'match', 'loop'])

// Ruby masking stays heuristic and line-based: it blanks quoted strings, `#` comments, `=begin`/`=end`
// blocks, conservative heredoc bodies (`<<~`, `<<-`, quoted tags, and plain `<<IDENT` with
// `IDENT = [A-Z_][A-Za-z0-9_]*` so `array << item` is left alone), and single-line `%w/%i/%W/%I`
// literals. Interpolation and multiline literal edge cases still stay opaque/approximate text.
function maskRubySyntaxLines(lines: string[]): string[] {
  const maskedLines: string[] = []
  let insideBlockComment = false
  const pendingHeredocs: Array<{ tag: string; allowsIndentedTerminator: boolean }> = []

  for (const line of lines) {
    if (insideBlockComment) {
      maskedLines.push(' '.repeat(line.length))
      if (/^=end\b/.test(line)) {
        insideBlockComment = false
      }
      continue
    }

    if (pendingHeredocs.length > 0) {
      maskedLines.push(' '.repeat(line.length))
      if (matchesRubyHeredocTerminator(line, pendingHeredocs[0]!)) {
        pendingHeredocs.shift()
      }
      continue
    }

    if (/^=begin\b/.test(line)) {
      maskedLines.push(' '.repeat(line.length))
      insideBlockComment = true
      continue
    }

    const masked = line.split('')
    let stringQuote: '"' | "'" | null = null
    let escaped = false

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]!

      if (stringQuote) {
        masked[index] = ' '
        if (escaped) {
          escaped = false
          continue
        }

        if (char === '\\') {
          escaped = true
          continue
        }

        if (char === stringQuote) {
          stringQuote = null
        }

        continue
      }

      const heredocOpener = findRubyHeredocOpenerAt(line, index)
      if (heredocOpener) {
        for (const opener of collectRubyHeredocOpeners(line, index)) {
          pendingHeredocs.push({
            tag: opener.tag,
            allowsIndentedTerminator: opener.allowsIndentedTerminator
          })
        }
        maskRubyRange(masked, index, line.length)
        break
      }

      const wordArrayLength = findRubyWordArrayLength(line, index)
      if (wordArrayLength > 0) {
        maskRubyRange(masked, index, index + wordArrayLength)
        index += wordArrayLength - 1
        continue
      }

      if (char === '#') {
        maskRubyRange(masked, index, line.length)
        break
      }

      if (char === '"' || char === "'") {
        stringQuote = char
        escaped = false
        masked[index] = ' '
      }
    }

    maskedLines.push(masked.join(''))
  }

  return maskedLines
}

function maskRubyRange(chars: string[], start: number, endExclusive: number): void {
  for (let index = start; index < endExclusive; index += 1) {
    chars[index] = ' '
  }
}

function matchesRubyHeredocTerminator(
  line: string,
  heredoc: { tag: string; allowsIndentedTerminator: boolean }
): boolean {
  return heredoc.allowsIndentedTerminator ? line.trim() === heredoc.tag : line === heredoc.tag
}

function collectRubyHeredocOpeners(
  line: string,
  startIndex: number
): Array<{ tag: string; allowsIndentedTerminator: boolean }> {
  const openers: Array<{ tag: string; allowsIndentedTerminator: boolean }> = []
  let stringQuote: '"' | "'" | null = null
  let escaped = false

  for (let index = startIndex; index < line.length; index += 1) {
    const char = line[index]!

    if (stringQuote) {
      if (escaped) {
        escaped = false
        continue
      }

      if (char === '\\') {
        escaped = true
        continue
      }

      if (char === stringQuote) {
        stringQuote = null
      }

      continue
    }

    if (char === '#') {
      break
    }

    const opener = findRubyHeredocOpenerAt(line, index)
    if (opener) {
      openers.push({ tag: opener.tag, allowsIndentedTerminator: opener.allowsIndentedTerminator })
      index += opener.length - 1
      continue
    }

    if (char === '"' || char === "'") {
      stringQuote = char
      escaped = false
    }
  }

  return openers
}

function findRubyHeredocOpenerAt(
  line: string,
  index: number
): { tag: string; allowsIndentedTerminator: boolean; length: number } | null {
  if (line[index] !== '<' || line[index + 1] !== '<') {
    return null
  }

  let cursor = index + 2
  let allowsIndentedTerminator = false
  if (line[cursor] === '~' || line[cursor] === '-') {
    allowsIndentedTerminator = true
    cursor += 1
  }

  const quote = line[cursor]
  if (quote === '"' || quote === "'") {
    const endQuote = line.indexOf(quote, cursor + 1)
    if (endQuote <= cursor + 1) {
      return null
    }

    return {
      tag: line.slice(cursor + 1, endQuote),
      allowsIndentedTerminator,
      length: endQuote - index + 1
    }
  }

  const identMatch = line.slice(cursor).match(/^[A-Z_][A-Za-z0-9_]*/)
  if (!identMatch) {
    return null
  }

  return {
    tag: identMatch[0],
    allowsIndentedTerminator,
    length: cursor - index + identMatch[0].length
  }
}

const RUBY_WORD_ARRAY_DELIMITERS = new Map<string, string>([
  ['[', ']'],
  ['{', '}'],
  ['(', ')'],
  ['<', '>'],
  ['|', '|'],
  ['/', '/']
])

function findRubyWordArrayLength(line: string, index: number): number {
  if (line[index] !== '%') {
    return 0
  }

  const literalKind = line[index + 1]
  const opener = line[index + 2]
  if (!literalKind || !opener || !'wWiI'.includes(literalKind)) {
    return 0
  }

  const closer = RUBY_WORD_ARRAY_DELIMITERS.get(opener)
  if (!closer) {
    return 0
  }

  const closeIndex = line.indexOf(closer, index + 3)
  if (closeIndex < 0) {
    return line.length - index
  }

  return closeIndex - index + 1
}

function collectSameFileSymbols(symbolRanges: SourceSymbolRange[]): Set<string> {
  return new Set(symbolRanges.flatMap((range) => (range.symbol ? [range.symbol] : [])))
}

function collectTypeScriptUsageScopeDeclarations(sourceFile: ts.SourceFile): Map<ts.Node, Set<string>> {
  const declarationsByScope = new Map<ts.Node, Set<string>>()

  const addToScope = (scope: ts.Node | undefined, name: string | undefined): void => {
    if (!scope || !name || ts.isSourceFile(scope)) {
      return
    }

    const declarations = declarationsByScope.get(scope) ?? new Set<string>()
    declarations.add(name)
    declarationsByScope.set(scope, declarations)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node)) {
      for (const name of collectTypeScriptBindingNames(node.name)) {
        addToScope(findNearestTypeScriptFunctionScope(node), name)
      }
    } else if (ts.isVariableDeclaration(node)) {
      const declarationList = ts.isVariableDeclarationList(node.parent) ? node.parent : undefined
      const scope = declarationList && (declarationList.flags & ts.NodeFlags.BlockScoped)
        ? findNearestTypeScriptBlockScope(node)
        : findNearestTypeScriptFunctionScope(node)
      for (const name of collectTypeScriptBindingNames(node.name)) {
        addToScope(scope, name)
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      addToScope(findNearestTypeScriptBlockScope(node), node.name.text)
    } else if (ts.isClassDeclaration(node) && node.name) {
      addToScope(findNearestTypeScriptBlockScope(node), node.name.text)
    } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      addToScope(findNearestTypeScriptBlockScope(node), node.name.text)
    } else if (ts.isFunctionExpression(node) && node.name) {
      addToScope(node, node.name.text)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return declarationsByScope
}

function collectTypeScriptBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text]
  }

  const names: string[] = []
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      continue
    }

    names.push(...collectTypeScriptBindingNames(element.name))
  }

  return names
}

function findNearestTypeScriptFunctionScope(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) {
      return current
    }
    current = current.parent
  }

  return undefined
}

function findNearestTypeScriptBlockScope(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (
      ts.isBlock(current) ||
      ts.isModuleBlock(current) ||
      ts.isCaseBlock(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isCatchClause(current) ||
      ts.isFunctionLike(current) ||
      ts.isSourceFile(current)
    ) {
      return current
    }
    current = current.parent
  }

  return undefined
}

function isTypeScriptSameFileReferenceShadowed(name: string, scopeStack: ReadonlyArray<Set<string>>): boolean {
  return scopeStack.some((scope) => scope.has(name))
}

function selectEnclosingSourceSymbolRange(symbolRanges: SourceSymbolRange[], lineNumber: number): SourceSymbolRange | undefined {
  let best: SourceSymbolRange | undefined

  for (const range of symbolRanges) {
    if (!range.symbol || lineNumber < range.startLine || lineNumber > range.endLine) {
      continue
    }

    if (!best) {
      best = range
      continue
    }

    const span = range.endLine - range.startLine
    const bestSpan = best.endLine - best.startLine
    if (span < bestSpan || (span === bestSpan && range.startLine >= best.startLine)) {
      best = range
    }
  }

  return best
}

function selectEnclosingSourceSymbol(symbolRanges: SourceSymbolRange[], lineNumber: number): string | undefined {
  return selectEnclosingSourceSymbolRange(symbolRanges, lineNumber)?.symbol
}

function buildEdge(params: {
  srcFile: string
  srcLine: number
  srcSymbol: string | undefined
  dstName: string
  dstFile?: string
  edgeKind: Edge['edgeKind']
  resolution: Edge['resolution']
  language?: string
}): Edge {
  const edge: Edge = {
    srcFile: params.srcFile,
    srcLine: params.srcLine,
    dstName: params.dstName,
    edgeKind: params.edgeKind,
    resolution: params.resolution
  }

  if (params.srcSymbol) {
    edge.srcSymbol = params.srcSymbol
  }

  if (params.dstFile) {
    edge.dstFile = params.dstFile
  }

  if (params.language) {
    edge.language = params.language
  }

  return edge
}

function pushEdge(edgesByKey: Map<string, Edge>, edge: Edge): void {
  const bucket = edge.edgeKind === 'import'
    ? 'import'
    : edge.edgeKind === 'call' || edge.edgeKind === 'ref'
      ? 'usage'
      : edge.edgeKind
  const key = [bucket, edge.srcFile, edge.srcLine, edge.dstName, edge.dstFile ?? ''].join('\0')
  const existing = edgesByKey.get(key)
  if (!existing) {
    edgesByKey.set(key, edge)
    return
  }

  if (existing.edgeKind === 'ref' && edge.edgeKind === 'call') {
    existing.edgeKind = 'call'
  }

  if (existing.resolution === 'name-only' && edge.resolution === 'import-resolved') {
    existing.resolution = 'import-resolved'
    if (edge.dstFile) {
      existing.dstFile = edge.dstFile
    }
  }
}

function lineNumberForOffsetInSourceFile(sourceFile: ts.SourceFile, offset: number): number {
  return sourceFile.getLineAndCharacterOfPosition(offset).line + 1
}

function resolveTypeScriptModuleTarget(file: ScannedFile, moduleSpecifier: string): string | null {
  if (!moduleSpecifier.startsWith('.')) {
    return null
  }

  for (const candidate of buildTypeScriptModuleCandidates(file.relativePath, moduleSpecifier)) {
    if (existsSync(resolve(scannedFileRoot(file), candidate))) {
      return candidate
    }
  }

  return null
}

function buildTypeScriptModuleCandidates(importerFile: string, moduleSpecifier: string): string[] {
  const importerDirectory = pathPosix.dirname(normalizeRelativeRepoPath(importerFile))
  const base = normalizeRelativeRepoPath(pathPosix.resolve('/', importerDirectory, moduleSpecifier))
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
    `${base}/index.mts`,
    `${base}/index.cts`
  ]
}

function resolvePythonModuleTarget(file: ScannedFile, moduleSpecifier: string): string | null {
  for (const candidate of buildPythonModuleCandidates(file.relativePath, moduleSpecifier)) {
    if (existsSync(resolve(scannedFileRoot(file), candidate))) {
      return candidate
    }
  }

  return null
}

function buildPythonModuleCandidates(importerFile: string, moduleSpecifier: string): string[] {
  const importerDirectory = pathPosix.dirname(normalizeRelativeRepoPath(importerFile))
  const relativeMatch = moduleSpecifier.match(/^(\.+)(.*)$/)

  let base: string
  if (relativeMatch) {
    const dots = relativeMatch[1]!.length
    const rest = relativeMatch[2] ?? ''
    const parentDirectory = dots > 1 ? pathPosix.resolve('/', importerDirectory, ...Array.from({ length: dots - 1 }, () => '..')) : pathPosix.resolve('/', importerDirectory)
    base = normalizeRelativeRepoPath(pathPosix.resolve(parentDirectory, rest.replace(/\./g, '/')))
  } else {
    base = normalizeRelativeRepoPath(pathPosix.resolve('/', moduleSpecifier.replace(/\./g, '/')))
  }

  return [base, `${base}.py`, `${base}/__init__.py`]
}

function scannedFileRoot(file: ScannedFile): string {
  const normalizedAbsolute = normalizePath(file.absolutePath)
  const normalizedRelative = normalizeRelativeRepoPath(file.relativePath)
  const suffix = normalizedRelative ? `/${normalizedRelative}` : ''

  if (suffix && normalizedAbsolute.endsWith(suffix)) {
    return normalizedAbsolute.slice(0, -suffix.length) || '/'
  }

  return dirname(normalizedAbsolute)
}

function normalizeRepoPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
}

function normalizeRelativeRepoPath(value: string): string {
  return normalizeRepoPath(value).replace(/^\/+/, '')
}

function scriptKindFromPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.ts')) {
    return ts.ScriptKind.TS
  }

  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX
  }

  if (filePath.endsWith('.jsx')) {
    return ts.ScriptKind.JSX
  }

  return ts.ScriptKind.JS
}

function maskPythonLines(lines: string[]): string[] {
  const maskedLines: string[] = []
  let tripleQuote: "'''" | '"""' | null = null

  for (const line of lines) {
    let masked = ''
    let quote: '"' | "'" | null = null
    let escaped = false

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index] ?? ''
      const nextThree = line.slice(index, index + 3)

      if (tripleQuote) {
        if (nextThree === tripleQuote) {
          masked += '   '
          index += 2
          tripleQuote = null
        } else {
          masked += ' '
        }
        continue
      }

      if (quote) {
        masked += ' '
        if (!escaped && char === quote) {
          quote = null
        }
        escaped = !escaped && char === '\\'
        continue
      }

      if (nextThree === "'''" || nextThree === '"""') {
        masked += '   '
        index += 2
        tripleQuote = nextThree as "'''" | '"""'
        continue
      }

      if (char === '#') {
        masked += ' '.repeat(line.length - index)
        break
      }

      if (char === '"' || char === "'") {
        masked += ' '
        quote = char
        escaped = false
        continue
      }

      masked += char
    }

    maskedLines.push(masked)
  }

  return maskedLines
}

function selectExactCandidateRows(
  db: Database.Database,
  query: string,
  options: SearchOptions | undefined,
  limit: number
): ChunkRow[] {
  const candidates = extractSymbolCandidates(query)
  if (candidates.length === 0) {
    return []
  }

  const { whereSql, params } = buildChunkSearchFilters(options)
  const placeholders = candidates.map(() => '?').join(', ')
  const rowsById = new Map<string, ChunkRow>()

  const chunkRows = db
    .prepare<unknown[], ChunkRow>(
      `
        select id, file_path, start_line, end_line, snippet, language, symbol, kind, parent, signature, generated
        from chunks
        ${whereSql ? `${whereSql} and` : 'where'} lower(symbol) in (${placeholders})
        order by file_path asc, start_line asc, end_line asc, id asc
        limit ${limit}
      `
    )
    .all(...params, ...candidates)

  for (const row of chunkRows) {
    rowsById.set(row.id, row)
  }

  const exactTokenRows = selectExactFtsCandidateRows(db, candidates, options, limit)
  for (const row of exactTokenRows) {
    rowsById.set(row.id, row)
  }

  const symbolRows = db
    .prepare<unknown[], ChunkRow>(
      `
        select distinct c.id, c.file_path, c.start_line, c.end_line, c.snippet, c.language, c.symbol, c.kind, c.parent, c.signature, c.generated
        from symbols s
        join chunks c on c.file_path = s.file_path and s.start_line between c.start_line and c.end_line
        ${whereSql ? `${whereSql.replace(/\bfile_path\b/g, 'c.file_path').replace(/\blanguage\b/g, 'c.language').replace(/\bkind\b/g, 'c.kind')} and` : 'where'} lower(s.name) in (${placeholders})
        order by c.file_path asc, c.start_line asc, c.end_line asc, c.id asc
        limit ${limit}
      `
    )
    .all(...params, ...candidates)

  for (const row of symbolRows) {
    rowsById.set(row.id, row)
  }

  const rows = [...rowsById.values()]

  // A documentation heading (a markdown H1, etc.) gets indexed as a "symbol", so an
  // identifier-shaped query token can match it exactly and float a prose title into
  // the high-weight (×4) exact arm — where, ordered only by path, it can outrank the
  // very function it documents (e.g. a README "cookie" heading over `parseCookie`).
  // For a code-concept query, drop doc-language rows from the exact arm; they still
  // surface via the lexical arm at their honest bm25 rank. A doc-focused query keeps
  // them, since then the heading is a legitimate answer.
  if (queryLooksDocumentationOrConfigFocused(query)) {
    return rows
  }

  return rows.filter((row) => !(row.language && isDocumentationLanguage(row.language)))
}

function selectExactFtsCandidateRows(
  db: Database.Database,
  candidates: string[],
  options: SearchOptions | undefined,
  limit: number
): ChunkRow[] {
  const { whereSql, params } = buildChunkSearchFilters(options)
  const rowsById = new Map<string, ChunkRow>()

  for (const candidate of candidates) {
    const ftsQuery = buildFtsQuery(candidate)
    if (!ftsQuery) {
      continue
    }

    const rows = db
      .prepare<unknown[], ChunkRow>(
        `
          select
            c.id,
            c.file_path,
            c.start_line,
            c.end_line,
            c.snippet,
            c.language,
            c.symbol,
            c.kind,
            c.parent,
            c.signature,
            c.generated
          from chunks_fts
          join chunks c on c.id = chunks_fts.chunk_id
          where chunks_fts match ?
          ${whereSql ? `and ${whereSql.replace(/^where\s+/i, '')}` : ''}
          order by c.file_path asc, c.start_line asc, c.end_line asc, c.id asc
          limit ${limit}
        `
      )
      .all(ftsQuery, ...params)

    for (const row of rows) {
      rowsById.set(row.id, row)
    }
  }

  return [...rowsById.values()]
}

function selectPartialSymbolRows(db: Database.Database, name: string, kinds: SymbolKind[], pathGlob?: string): SymbolRow[] {
  const whereClauses = ['lower(name) like lower(?)']
  const params: string[] = [`%${name}%`]

  if (kinds.length > 0) {
    whereClauses.push(`kind in (${kinds.map(() => '?').join(', ')})`)
    params.push(...kinds)
  }

  if (pathGlob) {
    whereClauses.push('codesift_minimatch(file_path, ?) = 1')
    params.push(pathGlob)
  }

  return db
    .prepare<unknown[], SymbolRow>(
      `
        select id, name, file_path, start_line, end_line, kind, signature, parent, language
        from symbols
        where ${whereClauses.join(' and ')}
        order by case when lower(name) = lower(?) then 0 else 1 end, file_path asc, start_line asc
        limit 25
      `
    )
    .all(...params, name)
}

function selectSymbolRowsByFile(db: Database.Database, file: string): SymbolRow[] {
  return db
    .prepare<[string], SymbolRow>(
      `
        select id, name, file_path, start_line, end_line, kind, signature, parent, language
        from symbols
        where file_path = ?
        order by start_line asc, id asc
      `
    )
    .all(file)
}

function buildSymbolDefinition(row: SymbolRow, matchQuality: 'exact' | 'partial'): SymbolDefinition {
  const definition: SymbolDefinition = {
    id: String(row.id),
    name: row.name,
    file: row.file_path,
    range: {
      startLine: row.start_line,
      endLine: row.end_line
    },
    kind: row.kind,
    matchQuality
  }

  if (row.signature) {
    definition.signature = row.signature
  }

  if (row.parent) {
    definition.parent = row.parent
  }

  if (row.language) {
    definition.language = row.language
  }

  return definition
}

function selectExactDefinitionRows(
  db: Database.Database,
  name: string,
  kinds: SymbolKind[],
  pathGlob?: string
): SymbolRow[] {
  const whereClauses = ['lower(name) = lower(?)']
  const params: string[] = [name]

  if (kinds.length > 0) {
    whereClauses.push(`kind in (${kinds.map(() => '?').join(', ')})`)
    params.push(...kinds)
  }

  if (pathGlob) {
    whereClauses.push('codesift_minimatch(file_path, ?) = 1')
    params.push(pathGlob)
  }

  return db
    .prepare<unknown[], SymbolRow>(
      `
        select id, name, file_path, start_line, end_line, kind, signature, parent, language
        from symbols
        where ${whereClauses.join(' and ')}
        order by file_path asc, start_line asc, id asc
      `
    )
    .all(...params)
}

function selectDefinitionRowsByNameAndFiles(
  db: Database.Database,
  name: string,
  targetFiles: ReadonlyArray<string>
): SymbolRow[] {
  if (targetFiles.length === 0) {
    return []
  }

  const targetFilePlaceholders = targetFiles.map(() => '?').join(', ')
  return db
    .prepare<unknown[], SymbolRow>(
      `
        select id, name, file_path, start_line, end_line, kind, signature, parent, language
        from symbols
        where lower(name) = lower(?) and file_path in (${targetFilePlaceholders})
        order by file_path asc, start_line asc, id asc
      `
    )
    .all(name, ...targetFiles)
}

async function resolveDefinitionEdgeTargetsForNameAndFiles(
  db: Database.Database,
  root: string,
  name: string,
  targetFiles: ReadonlyArray<string>,
  defaultExportCache?: Map<string, Promise<Set<string>>>
): Promise<DefinitionEdgeTarget[]> {
  const definitions = selectDefinitionRowsByNameAndFiles(db, name, targetFiles)
  return resolveDefinitionEdgeTargets(root, definitions, defaultExportCache)
}

async function resolveDefinitionEdgeTargets(
  root: string,
  definitions: ReadonlyArray<Pick<SymbolRow, 'name' | 'file_path' | 'language'>>,
  defaultExportCache: Map<string, Promise<Set<string>>> = new Map()
): Promise<DefinitionEdgeTarget[]> {
  const targetsByKey = new Map<string, DefinitionEdgeTarget>()

  for (const definition of definitions) {
    const resolutionMode: Edge['resolution'] = isImportResolvedDefinitionLanguage(definition.language)
      ? 'import-resolved'
      : 'name-only'
    const names = new Set([definition.name])

    if (resolutionMode === 'import-resolved' && definition.language && isTypeScriptLike(definition.language)) {
      const defaultExportNames = await getTypeScriptDefaultExportNames(root, definition.file_path, defaultExportCache)
      if (defaultExportNames.has(definition.name) || definition.name === 'default') {
        names.add('default')
      }
    }

    const key = resolutionMode === 'import-resolved'
      ? `import-resolved\u0000${definition.file_path}`
      : `name-only\u0000${definition.name.toLowerCase()}`
    const existing = targetsByKey.get(key)
    if (existing) {
      for (const name of names) {
        if (!existing.names.includes(name)) {
          existing.names.push(name)
        }
      }
      continue
    }

    const target: DefinitionEdgeTarget = {
      names: [...names],
      resolutionMode
    }
    if (resolutionMode === 'import-resolved') {
      target.file = definition.file_path
    }
    targetsByKey.set(key, target)
  }

  return [...targetsByKey.values()]
}

function isImportResolvedDefinitionLanguage(language: string | null | undefined): boolean {
  return Boolean(language && (isTypeScriptLike(language) || isPythonLike(language)))
}

async function getTypeScriptDefaultExportNames(
  root: string,
  file: string,
  cache: Map<string, Promise<Set<string>>>
): Promise<Set<string>> {
  const cached = cache.get(file)
  if (cached) {
    return cached
  }

  const load = readFile(resolve(root, file), 'utf8')
    .then((content) => {
      const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKindFromPath(file))
      return collectTypeScriptDefaultExportNames(sourceFile)
    })
    .catch(() => new Set<string>())
  cache.set(file, load)
  return load
}

function collectTypeScriptDefaultExportNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>()

  for (const statement of sourceFile.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && hasTypeScriptDefaultExportModifier(statement)) {
      names.add(statement.name?.text ?? 'default')
      continue
    }

    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      if (ts.isIdentifier(statement.expression)) {
        names.add(statement.expression.text)
      } else if (ts.isFunctionExpression(statement.expression) || ts.isClassExpression(statement.expression)) {
        names.add(statement.expression.name?.text ?? 'default')
      } else {
        names.add('default')
      }
      continue
    }

    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text === 'default') {
          names.add((element.propertyName ?? element.name).text)
        }
      }
    }
  }

  return names
}

function hasTypeScriptDefaultExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
}

function selectDefinitionEdgeRows(
  db: Database.Database,
  targets: ReadonlyArray<DefinitionEdgeTarget>,
  edgeKinds: ReadonlyArray<Edge['edgeKind']>,
  preferCallsFirst: boolean,
  options?: number | DefinitionEdgeSelectOptions
): EdgeResultRow[] {
  if (targets.length === 0 || edgeKinds.length === 0) {
    return []
  }

  const selectOptions = typeof options === 'number' ? { limit: options, nameOnlyLimit: options } : options ?? {}
  const edgeKindPlaceholders = edgeKinds.map(() => '?').join(', ')
  const rowsById = new Map<number, EdgeResultRow>()

  for (const target of targets) {
    if (target.names.length === 0) {
      continue
    }

    const nameClauses = target.names.map(() => 'lower(dst_name) = lower(?)').join(' or ')
    const params: string[] = [...target.names]
    let whereClause = `(${nameClauses}) and dst_file is null and edge_kind in (${edgeKindPlaceholders})`
    if (target.resolutionMode === 'import-resolved' && target.file) {
      whereClause = `(${nameClauses}) and dst_file = ? and edge_kind in (${edgeKindPlaceholders})`
      params.push(target.file)
    }
    params.push(...edgeKinds)

    const nameOnlyLimit = target.resolutionMode === 'name-only' ? selectOptions.nameOnlyLimit : undefined
    if (nameOnlyLimit !== undefined) {
      const total = db
        .prepare<unknown[], { count: number }>(
          `
            select count(*) as count
            from edges
            where ${whereClause}
          `
        )
        .get(...params)?.count ?? 0
      if (total > nameOnlyLimit && selectOptions.stats) {
        selectOptions.stats.nameOnlyUnscoped = (selectOptions.stats.nameOnlyUnscoped ?? 0) + total
      }
    }

    const orderBy = `${preferCallsFirst ? "case when edge_kind = 'call' then 0 else 1 end asc, " : ''}src_file asc, src_line asc, id asc`
    const targetRows = db
      .prepare<unknown[], EdgeResultRow>(
        `
          select id, src_file, src_line, src_symbol, edge_kind, resolution, language
          from edges
          where ${whereClause}
          order by ${orderBy}
          ${nameOnlyLimit !== undefined ? 'limit ?' : ''}
        `
      )
      .all(...(nameOnlyLimit !== undefined ? [...params, nameOnlyLimit] : params))

    for (const row of targetRows) {
      rowsById.set(row.id, row)
    }
  }

  const rows = [...rowsById.values()].sort((left, right) => compareEdgeResultRows(left, right, preferCallsFirst))
  return selectOptions.limit === undefined ? rows : rows.slice(0, selectOptions.limit)
}

function compareEdgeResultRows(left: EdgeResultRow, right: EdgeResultRow, preferCallsFirst: boolean): number {
  if (preferCallsFirst && left.edge_kind !== right.edge_kind) {
    if (left.edge_kind === 'call') {
      return -1
    }
    if (right.edge_kind === 'call') {
      return 1
    }
  }

  return (
    left.src_file.localeCompare(right.src_file) ||
    left.src_line - right.src_line ||
    left.id - right.id
  )
}

function selectDefinitionUsageRows(
  db: Database.Database,
  targets: ReadonlyArray<DefinitionEdgeTarget>,
  options: {
    excludedSrcFile: string
    excludedStartLine: number
    excludedEndLine: number
    pathGlob?: string
    limit?: number
  }
): EdgeUsageRow[] {
  const rows = selectDefinitionEdgeRows(db, targets, ['call', 'ref'], false)
    .filter(
      (row) =>
        !(row.src_file === options.excludedSrcFile && row.src_line >= options.excludedStartLine && row.src_line <= options.excludedEndLine)
    )
    .filter((row) => !options.pathGlob || minimatch(row.src_file, options.pathGlob))
    .map<EdgeUsageRow>((row) => ({
      id: row.id,
      src_file: row.src_file,
      src_line: row.src_line,
      language: row.language,
      resolution: row.resolution
    }))

  return options.limit === undefined ? rows : rows.slice(0, options.limit)
}

function countDefinitionEdgeRows(
  db: Database.Database,
  targets: ReadonlyArray<DefinitionEdgeTarget>,
  edgeKinds: ReadonlyArray<Edge['edgeKind']>
): number {
  return selectDefinitionEdgeRows(db, targets, edgeKinds, false).length
}

function selectImporterEdgeRows(db: Database.Database, file: string): EdgeResultRow[] {
  return db
    .prepare<unknown[], EdgeResultRow>(
      `
        select id, src_file, src_line, src_symbol, edge_kind, resolution, language
        from edges
        where dst_file = ? and edge_kind = 'import'
        order by src_file asc, src_line asc, id asc
      `
    )
    .all(file)
}

function selectSameFileNeighborRows(
  db: Database.Database,
  file: string,
  excludedId: number,
  anchorStartLine: number,
  limit: number
): SymbolRow[] {
  return db
    .prepare<unknown[], SymbolRow>(
      `
        select id, name, file_path, start_line, end_line, kind, signature, parent, language
        from symbols
        where file_path = ? and id <> ?
        order by abs(start_line - ?) asc, start_line asc, id asc
        limit ${limit}
      `
    )
    .all(file, excludedId, anchorStartLine)
}

function countSameFileNeighborRows(db: Database.Database, file: string, excludedId: number): number {
  return db
    .prepare<unknown[], { count: number }>(
      `
        select count(*) as count
        from symbols
        where file_path = ? and id <> ?
      `
    )
    .get(file, excludedId)?.count ?? 0
}

function buildSymbolNeighbor(row: SymbolRow): SymbolNeighbor {
  const neighbor: SymbolNeighbor = {
    name: row.name,
    file: row.file_path,
    range: { startLine: row.start_line, endLine: row.end_line },
    kind: row.kind
  }

  if (row.parent) {
    neighbor.parent = row.parent
  }

  if (row.language) {
    neighbor.language = row.language
  }

  return neighbor
}

async function readEdgeResultsFromRows(
  root: string,
  rows: EdgeResultRow[],
  maxTokens: number | undefined
): Promise<ReadRowsResult<EdgeResult>> {
  const tokenBudget = normalizeSearchTokenBudget(maxTokens)
  const linesByFile = new Map<string, string[]>()
  const results: EdgeResult[] = []
  let tokensUsed = 0
  let tokenTruncated = false
  let readFailures = 0

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    let lines = linesByFile.get(row.src_file)
    if (!lines) {
      try {
        lines = splitLines(await readFile(resolve(root, row.src_file), 'utf8'))
        linesByFile.set(row.src_file, lines)
      } catch {
        readFailures += 1
        continue
      }
    }

    const result: EdgeResult = {
      file: row.src_file,
      range: { startLine: row.src_line, endLine: row.src_line },
      line: row.src_line,
      snippet: (lines[row.src_line - 1] ?? '').trimEnd(),
      edgeKind: row.edge_kind,
      resolution: row.resolution
    }

    if (row.src_symbol) {
      result.srcSymbol = row.src_symbol
    }

    if (row.language) {
      result.language = row.language
    }

    const estimatedTokens = estimateEdgeResultTokens(result)
    if (tokenBudget !== undefined && tokensUsed + estimatedTokens > tokenBudget) {
      if (results.length === 0) {
        results.push({
          ...result,
          snippet: truncateToTokenBudget(result.snippet, Math.max(1, Math.max(0, tokenBudget - 8)))
        })
        tokenTruncated = index < rows.length - 1
      } else {
        tokenTruncated = true
      }
      break
    }

    results.push(result)
    tokensUsed += estimatedTokens
  }

  return { items: results, tokenTruncated, readFailures }
}

function estimateEdgeResultTokens(result: EdgeResult): number {
  const header = `${result.file}:${result.line} ${result.srcSymbol ?? ''} ${result.edgeKind} ${result.resolution}`
  return SEARCH_HIT_TOKEN_OVERHEAD + estimateTokenCount(header) + estimateTokenCount(result.snippet)
}

async function readImpactNodesFromRows(
  root: string,
  rows: ImpactNodeRow[],
  maxTokens: number | undefined
): Promise<ReadRowsResult<ImpactNode>> {
  const tokenBudget = normalizeSearchTokenBudget(maxTokens)
  const linesByFile = new Map<string, string[]>()
  const nodes: ImpactNode[] = []
  let tokensUsed = 0
  let tokenTruncated = false
  let readFailures = 0

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    let lines = linesByFile.get(row.src_file)
    if (!lines) {
      try {
        lines = splitLines(await readFile(resolve(root, row.src_file), 'utf8'))
        linesByFile.set(row.src_file, lines)
      } catch {
        readFailures += 1
        continue
      }
    }

    const node: ImpactNode = {
      name: row.name,
      file: row.src_file,
      range: { startLine: row.src_line, endLine: row.src_line },
      line: row.src_line,
      snippet: (lines[row.src_line - 1] ?? '').trimEnd(),
      depth: row.depth,
      edgeKind: row.edge_kind,
      resolution: row.resolution
    }

    if (row.src_symbol) {
      node.srcSymbol = row.src_symbol
    }

    if (row.language) {
      node.language = row.language
    }

    const estimatedTokens = estimateImpactNodeTokens(node)
    if (tokenBudget !== undefined && tokensUsed + estimatedTokens > tokenBudget) {
      if (nodes.length === 0) {
        nodes.push({
          ...node,
          snippet: truncateToTokenBudget(node.snippet, Math.max(1, Math.max(0, tokenBudget - 10)))
        })
        tokenTruncated = index < rows.length - 1
      } else {
        tokenTruncated = true
      }
      break
    }

    nodes.push(node)
    tokensUsed += estimatedTokens
  }

  return { items: nodes, tokenTruncated, readFailures }
}

function estimateImpactNodeTokens(node: ImpactNode): number {
  const header = `${node.file}:${node.line} ${node.name} d${node.depth} ${node.edgeKind} ${node.resolution}`
  return SEARCH_HIT_TOKEN_OVERHEAD + estimateTokenCount(header) + estimateTokenCount(node.snippet)
}

function selectGrepCandidateFiles(db: Database.Database, options?: GrepOptions): Array<{ path: string; language: string }> {
  const whereClauses: string[] = []
  const params: string[] = []

  if (options?.lang && options.lang.length > 0) {
    whereClauses.push(`language in (${options.lang.map(() => '?').join(', ')})`)
    params.push(...options.lang)
  }

  if (options?.pathGlob) {
    whereClauses.push('codesift_minimatch(path, ?) = 1')
    params.push(options.pathGlob)
  }

  return db
    .prepare<unknown[], { path: string; language: string }>(
      `
        select path, language
        from files
        ${whereClauses.length > 0 ? `where ${whereClauses.join(' and ')}` : ''}
        order by path asc
      `
    )
    .all(...params)
}

function fuseRankedRows(query: string, exactRows: ChunkRow[], vectorRows: ChunkRow[], lexicalRows: ChunkRow[]): RankedChunkRow[] {
  const byId = new Map<string, RankedChunkRow>()

  addReciprocalRanks(byId, exactRows, '=', 4)
  addReciprocalRanks(byId, vectorRows, '+')
  addReciprocalRanks(byId, lexicalRows, '~')

  const terms = queryConceptTerms(query)

  return [...byId.values()].sort((left, right) => {
    const leftScore = left.score * scoreBoostForRow(left.row, query)
    const rightScore = right.score * scoreBoostForRow(right.row, query)
    const scoreDelta = rightScore - leftScore

    if (Math.abs(scoreDelta) > 1e-12) {
      return scoreDelta
    }

    // Meaningful tiebreak (#6): when fused scores tie, prefer the row whose
    // name/signature covers more of the query, then a real definition over a
    // file/container chunk, then the stable location key so order stays
    // deterministic across runs.
    const coverageDelta = nameTermCoverage(right.row, terms) - nameTermCoverage(left.row, terms)
    if (Math.abs(coverageDelta) > 1e-9) {
      return coverageDelta
    }

    const kindDelta = definitionKindRank(left.row) - definitionKindRank(right.row)
    if (kindDelta !== 0) {
      return kindDelta
    }

    return stableChunkSortKey(left.row).localeCompare(stableChunkSortKey(right.row))
  })
}

/**
 * Build the document text handed to the reranker for a candidate row: the
 * stored snippet, optionally prefixed with the symbol, capped to keep payloads
 * small. The reranker only re-scores; the verbatim body is still read from disk
 * later in {@link buildBudgetedSearchHits}.
 */
function rerankDocumentForRow(row: ChunkRow): string {
  const prefix = row.symbol ? `${row.symbol}\n` : ''
  return `${prefix}${row.snippet}`.slice(0, RERANK_SNIPPET_CHAR_LIMIT)
}

/**
 * Reorder `head` by the reranker's scores (descending), appending any candidate
 * the reranker omitted in its original relative order. Stable on ties so a
 * no-signal rerank preserves the fused order.
 */
function reorderByRerankResults(head: RankedChunkRow[], results: RerankResult[]): RankedChunkRow[] {
  const ordered = [...results]
    .filter((result) => result.index >= 0 && result.index < head.length)
    .sort((left, right) => right.score - left.score)

  const seen = new Set<number>()
  const reordered: RankedChunkRow[] = []
  for (const result of ordered) {
    if (seen.has(result.index)) {
      continue
    }
    seen.add(result.index)
    reordered.push(head[result.index]!)
  }

  head.forEach((ranked, index) => {
    if (!seen.has(index)) {
      reordered.push(ranked)
    }
  })

  return reordered
}

function addReciprocalRanks(target: Map<string, RankedChunkRow>, rows: ChunkRow[], reason: SearchReasonTag, weight = 1): void {
  rows.forEach((row, index) => {
    const score = weight / (DEFAULT_RRF_K + index + 1)
    const existing = target.get(row.id)

    if (existing) {
      existing.score += score
      existing.reasons.add(reason)
      return
    }

    target.set(row.id, {
      row,
      score,
      reasons: new Set([reason])
    })
  })
}

// Query-aware ranking (#6) is intentionally a TIEBREAK, not a score multiplier. An
// early prototype multiplied the fused score by ~(1 + 0.3·coverage); the eval's
// precision axis caught it demoting a correct rank-1 (the "validate signed timestamp"
// concept resolves to TimestampSigner.unsign, but a coverage lift floated the thin
// `validate` wrapper above it) while resolving nothing — a pure accuracy-for-nothing
// trade. So coverage now only orders rows whose primary fused score is already tied,
// where the prior lexicographic file-path tiebreak was arbitrary. The signature is
// loaded into ChunkRow so this signal (and find_symbol callers) can see it.

// Distinct concept terms of a query (camelCase-split, stop-words and 1-char tokens
// dropped) — the same token set buildFtsTermGroups searches, before OR-expansion.
export function queryConceptTerms(query: string): string[] {
  return [...new Set(buildNormalizedTerms(query).filter((term) => !DEFAULT_STOP_WORDS.has(term) && term.length > 1))]
}

// Fraction of the query's concept terms present in the row's declared NAME surface
// (symbol + parent + signature), tokenized the same way. Returns 0 when the row has
// no name surface or the query carries no concept terms.
export function nameTermCoverage(
  row: { symbol: string | null; parent: string | null; signature: string | null },
  terms: string[]
): number {
  if (terms.length === 0) {
    return 0
  }

  const nameTerms = new Set([
    ...buildNormalizedTerms(row.symbol ?? undefined),
    ...buildNormalizedTerms(row.parent ?? undefined),
    ...buildNormalizedTerms(row.signature ?? undefined)
  ])
  if (nameTerms.size === 0) {
    return 0
  }

  let covered = 0
  for (const term of terms) {
    if (nameTerms.has(term)) {
      covered += 1
    }
  }

  return covered / terms.length
}

// Tiebreak preference among rows with an equal fused score: a real definition
// (function/method) over a container or other symbol, over a plain file chunk.
// Lower rank sorts first.
function definitionKindRank(row: ChunkRow): number {
  switch (row.kind) {
    case 'function':
    case 'method':
      return 0
    case 'file':
      return 2
    default:
      return 1
  }
}

function scoreBoostForRow(row: ChunkRow, query: string): number {
  let boost = 1

  if (row.language && isCodeLanguage(row.language)) {
    boost *= 1.12
  }

  if (row.symbol) {
    boost *= 1.08
  }

  // A "how/where is X done" concept query describes behavior, so a pure type/interface
  // declaration (a shape, not an operation) should not outrank the function/method or
  // class that implements it. Demote interface/type mildly rather than boosting
  // functions — boosting functions would lift a same-named method over a class chunk
  // that legitimately answers the query, which the precision axis catches. Other
  // symbols keep the flat boost; a bare file chunk gets none.
  if (row.kind === 'interface' || row.kind === 'type') {
    boost *= 0.92
  } else if (row.kind && row.kind !== 'file') {
    boost *= 1.04
  }

  if (row.generated === 1) {
    boost *= 0.58
  }

  // The 1.85× "this is THE definition" boost is for code symbols. A documentation
  // heading that merely shares a word with a code-concept query is not a definition,
  // so it does not earn the boost (it is also dropped from the exact arm upstream).
  if (isExactSymbolMatch(row, query) && !(row.language && isDocumentationLanguage(row.language) && !queryLooksDocumentationOrConfigFocused(query))) {
    boost *= 1.85
  }

  if (!queryLooksDocumentationOrConfigFocused(query)) {
    if (row.language && isDocumentationLanguage(row.language)) {
      boost *= 0.84
    }

    if (looksLikeProjectMetadata(row.file_path)) {
      boost *= 0.82
    }
  }

  return boost
}

// Number of DISTINCT definitions an identifier query resolves to in the exact arm.
// Keyed by (file, symbol, parent) so multiple chunks of one symbol count once, while
// same-named symbols in different files (or under different parents) count separately
// — the collision signal the confidence gate keys on.
function distinctExactSymbolDefinitions(exactRows: ChunkRow[], query: string): number {
  const seen = new Set<string>()
  for (const row of exactRows) {
    if (isExactSymbolMatch(row, query)) {
      seen.add(`${row.file_path}\u0000${(row.symbol ?? '').toLowerCase()}\u0000${(row.parent ?? '').toLowerCase()}`)
    }
  }
  return seen.size
}

function isExactSymbolMatch(row: ChunkRow, query: string): boolean {
  if (!row.symbol) {
    return false
  }

  const candidates = extractSymbolCandidates(query)
  if (candidates.length === 0) {
    return false
  }

  const lowerSymbol = row.symbol.toLowerCase()
  const lowerParent = row.parent?.toLowerCase()
  const qualifiedNames = lowerParent
    ? new Set([`${lowerParent}.${lowerSymbol}`, `${lowerParent}#${lowerSymbol}`, `${lowerParent}::${lowerSymbol}`])
    : new Set<string>()

  return candidates.some((candidate) => candidate === lowerSymbol || qualifiedNames.has(candidate))
}

function isIdentifierLikeToken(candidate: string): boolean {
  return (
    candidate.includes('.') ||
    candidate.includes('_') ||
    candidate.includes('::') ||
    candidate.includes('#') ||
    /[a-z0-9][A-Z]/.test(candidate) ||
    /^[A-Z][A-Za-z0-9_]+$/.test(candidate)
  )
}

function extractSymbolCandidates(query: string): string[] {
  const matches = new Set<string>()
  const rawMatches = query.match(/`([^`]+)`|[A-Za-z_][A-Za-z0-9_.:#]*/g) ?? []

  for (const rawMatch of rawMatches) {
    const candidate = rawMatch.startsWith('`') && rawMatch.endsWith('`') ? rawMatch.slice(1, -1) : rawMatch
    if (!candidate) {
      continue
    }

    if (!isIdentifierLikeToken(candidate)) {
      continue
    }

    matches.add(candidate.toLowerCase())

    const trailingSegment = candidate.split(/\.|::|#/).at(-1)
    if (trailingSegment) {
      matches.add(trailingSegment.toLowerCase())
    }
  }

  return [...matches]
}

// Progressive FTS relaxation ladder. Each tier is a strict SUPERSET of the one
// before, so relaxing never drops a stricter-tier match — it only widens recall:
//   1. full AND     — every concept word present (the common case)
//   2. drop-rarest   — drop the single highest-IDF group (fewest docs = the most
//                      likely AND-killer), so a query word the target happens to
//                      lack no longer excludes it
//   3. full OR       — any concept word, the recall backstop
// Tiers 2–3 fire ONLY when the prior tier under-recalls (< MIN_RELAXATION_ROWS),
// so a query that already matches stays byte-for-byte unchanged and pays no IDF
// cost. Widening is guarded by the eval precision axis (a relaxed tier that pushes
// a false positive to rank-1 shows up as a precision regression). bm25 still orders
// within the chosen tier, so the densest match stays on top.
function selectRelaxedLexicalRows(
  db: Database.Database,
  query: string,
  whereSql: string,
  params: unknown[],
  limit: number
): ChunkRow[] {
  const groups = buildFtsTermGroups(query)
  if (groups.length === 0) {
    return []
  }

  const andClause = whereSql ? `and ${whereSql.replace(/^where\s+/i, '')}` : ''
  const statement = db.prepare<unknown[], ChunkRow>(
    `
      select
        c.id,
        c.file_path,
        c.start_line,
        c.end_line,
        c.snippet,
        c.language,
        c.symbol,
        c.kind,
        c.parent,
        c.signature,
        c.generated
      from chunks_fts
      join chunks c on c.id = chunks_fts.chunk_id
      where chunks_fts match ?
      ${andClause}
      order by bm25(chunks_fts, 1.0, 6.0, 2.5, 2.0) asc, c.file_path asc, c.start_line asc, c.id asc
      limit ${limit}
    `
  )
  const run = (ftsQuery: string): ChunkRow[] => statement.all(ftsQuery, ...params)

  const tierOne = run(groups.join(' AND '))
  // Relaxation is a CONCEPT-recall safety net. A symbol-dominated query ("fooBarToken")
  // wants that identifier, not a lexically-adjacent one — widening it (even drop-rarest)
  // would surface a different symbol that merely shares a sub-word. Keep those strict.
  if (tierOne.length >= MIN_RELAXATION_ROWS || groups.length < 2 || isSymbolDominatedQuery(query)) {
    return tierOne
  }

  let best = tierOne
  const rarest = rarestTermGroupIndex(db, groups, andClause, params)
  if (rarest !== -1) {
    const tierTwo = run(groups.filter((_, index) => index !== rarest).join(' AND '))
    if (tierTwo.length >= MIN_RELAXATION_ROWS) {
      return tierTwo
    }
    if (tierTwo.length > best.length) {
      best = tierTwo
    }
  }

  const tierThree = run(groups.join(' OR '))
  return tierThree.length > best.length ? tierThree : best
}

// Index of the term-group present in the FEWEST indexed chunks (highest IDF). Run
// lazily — only when tier-1 under-recalls — so the per-group count queries are paid
// once per under-recalled search, never on the common path.
function rarestTermGroupIndex(db: Database.Database, groups: string[], andClause: string, params: unknown[]): number {
  const statement = db.prepare<unknown[], { n: number }>(
    `
      select count(*) as n
      from chunks_fts
      join chunks c on c.id = chunks_fts.chunk_id
      where chunks_fts match ?
      ${andClause}
    `
  )

  let rarestIndex = -1
  let rarestCount = Number.POSITIVE_INFINITY
  groups.forEach((group, index) => {
    const count = statement.get(group, ...params)?.n ?? 0
    if (count < rarestCount) {
      rarestCount = count
      rarestIndex = index
    }
  })

  return rarestIndex
}

// Ordered list of FTS5 term-groups for a query, one per distinct concept word
// (each group OR-expands its synonyms). Order follows the query's word order; the
// relaxation ladder reorders only by IDF when it drops the rarest group.
function buildFtsTermGroups(query: string): string[] {
  const terms = [...new Set(buildNormalizedTerms(query).filter((term) => !DEFAULT_STOP_WORDS.has(term) && term.length > 1))]
  if (terms.length === 0) {
    return []
  }

  const groups: string[] = []
  const covered = new Set<string>()

  for (const term of terms) {
    if (groups.length >= 12) {
      break
    }

    if (covered.has(term)) {
      continue
    }

    const members = expandTermToOrGroup(term)
    for (const member of members) {
      covered.add(member)
    }

    groups.push(members.length > 1 ? `(${members.map(quoteFtsTerm).join(' OR ')})` : quoteFtsTerm(term))
  }

  return groups
}

export function buildFtsQuery(query: string): string | null {
  const groups = buildFtsTermGroups(query)
  return groups.length === 0 ? null : groups.join(' AND ')
}

function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

function buildGrepMatcher(pattern: string, options?: GrepOptions): RegExp {
  const source = options?.regex ? pattern : escapeRegExp(pattern)
  const boundedSource = options?.wholeWord ? `(?<![A-Za-z0-9_])${source}(?![A-Za-z0-9_])` : source
  const flags = `g${options?.ignoreCase ? 'i' : ''}m${options?.multiline ? 's' : ''}`

  return new RegExp(boundedSource, flags)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildLineStarts(content: string): number[] {
  const starts = [0]

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') {
      starts.push(index + 1)
    }
  }

  return starts
}

function lineNumberForOffset(lineStarts: number[], offset: number): number {
  let low = 0
  let high = lineStarts.length - 1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const lineStart = lineStarts[middle]!
    const nextLineStart = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY

    if (offset < lineStart) {
      high = middle - 1
      continue
    }

    if (offset >= nextLineStart) {
      low = middle + 1
      continue
    }

    return middle + 1
  }

  return lineStarts.length
}

function normalizeMaxMatches(value: number | undefined): number {
  if (value === undefined) {
    return 1000
  }

  if (!Number.isFinite(value) || value <= 0) {
    return 1000
  }

  return Math.floor(value)
}

function buildLexicalSearchText(row: {
  file: string
  embeddingText: string
  symbol?: string
  parent?: string
  signature?: string
}): string {
  const expansions = [row.file, row.symbol, row.parent, row.signature]
    .flatMap((value) => buildNormalizedTerms(value))
    .join(' ')
    .trim()

  return expansions ? `${row.embeddingText}\n${expansions}` : row.embeddingText
}

function buildNormalizedTerms(value: string | undefined): string[] {
  if (!value) {
    return []
  }

  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()

  return normalized.match(/[a-z0-9]+/g) ?? []
}

export function queryShouldUseVectorSearch(query: string): boolean {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) {
    return false
  }

  if (/^['"`].+['"`]$/.test(trimmedQuery)) {
    return false
  }

  if (looksLikePathQuery(trimmedQuery)) {
    return false
  }

  const normalizedTerms = buildNormalizedTerms(trimmedQuery)
  if (normalizedTerms.length <= 4 && isSymbolDominatedQuery(trimmedQuery)) {
    return false
  }

  return true
}

/**
 * A short query is symbol-dominated only when a MAJORITY of its word tokens are
 * identifier-like (dotted/underscored/qualified/PascalCase/acronym). A single
 * PascalCase or acronym token inside a natural-language query (e.g.
 * "validate JWT signature") does not dominate, so the query stays vector-eligible.
 */
function isSymbolDominatedQuery(query: string): boolean {
  const tokens = query.match(/`([^`]+)`|[A-Za-z_][A-Za-z0-9_.:#]*/g) ?? []
  if (tokens.length === 0) {
    return false
  }

  let identifierLike = 0
  for (const token of tokens) {
    const candidate = token.startsWith('`') && token.endsWith('`') ? token.slice(1, -1) : token
    if (candidate && isIdentifierLikeToken(candidate)) {
      identifierLike += 1
    }
  }

  return identifierLike * 2 > tokens.length
}

function looksLikePathQuery(query: string): boolean {
  return /^[./A-Za-z0-9_-]+(?:\/[./A-Za-z0-9_-]+)+$/.test(query)
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }

  return String(error)
}

function looksLikeProjectMetadata(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase()
  return (
    lowerPath.endsWith('/readme.md') ||
    lowerPath === 'readme.md' ||
    lowerPath.endsWith('/plan.md') ||
    lowerPath === 'plan.md' ||
    lowerPath.endsWith('/package.json') ||
    lowerPath === 'package.json' ||
    lowerPath.endsWith('/tsconfig.json') ||
    lowerPath === 'tsconfig.json' ||
    lowerPath.endsWith('/vitest.config.ts') ||
    lowerPath === 'vitest.config.ts'
  )
}

function queryLooksDocumentationOrConfigFocused(query: string): boolean {
  return /\b(readme|plan|doc|docs|documentation|guide|workflow|config|package\.json|pnpm|json|yaml)\b/i.test(
    query
  )
}

function createChunkId(chunk: ChunkRecord): string {
  return `${chunk.file}:${chunk.startLine}-${chunk.endLine}@${hashText(chunk.content)}`
}

function parseChunkId(id: string): { file: string; startLine: number; endLine: number; contentHash: string } | null {
  const match = /^(.*):(\d+)-(\d+)(?:@([a-f0-9]{8,64}))?$/.exec(id)
  if (!match) {
    return null
  }

  const [, file = '', startLine = '0', endLine = '0', contentHash = ''] = match
  return {
    file,
    startLine: Number(startLine),
    endLine: Number(endLine),
    contentHash
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function buildEmbeddingBatches(
  chunks: IndexedChunkRecord[],
  maxBatch = Number.POSITIVE_INFINITY,
  maxBatchTokens = Number.POSITIVE_INFINITY
): IndexedChunkRecord[][] {
  if (chunks.length === 0) {
    return []
  }

  const batches: IndexedChunkRecord[][] = []
  let currentBatch: IndexedChunkRecord[] = []
  let currentBatchTokens = 0

  for (const chunk of chunks) {
    const estimatedTokens = Math.max(1, estimateTokenCount(chunk.embeddingText))
    const wouldOverflowBatch = currentBatch.length >= maxBatch
    const wouldOverflowTokens = currentBatch.length > 0 && currentBatchTokens + estimatedTokens > maxBatchTokens

    if (wouldOverflowBatch || wouldOverflowTokens) {
      batches.push(currentBatch)
      currentBatch = []
      currentBatchTokens = 0
    }

    currentBatch.push(chunk)
    currentBatchTokens += estimatedTokens
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch)
  }

  return batches
}

function registerSqlFunctions(db: Database.Database): void {
  db.function('codesift_minimatch', { deterministic: true }, (value: unknown, pattern: unknown) => {
    if (typeof value !== 'string' || typeof pattern !== 'string') {
      return 0
    }

    return minimatch(value, pattern) ? 1 : 0
  })
}

function buildCompatibilityMismatch(
  code: NonNullable<IndexCompatibilityStatus['code']>,
  actual: IndexCompatibilitySnapshot,
  expected: IndexCompatibilitySnapshot
): IndexCompatibilityStatus {
  return {
    ok: false,
    code,
    message:
      `index built with ${actual.providerId ?? 'unknown'} (${actual.providerDims ?? '?'} dims) / schema v${actual.schemaVersion ?? 'unknown'}, ` +
      `now ${expected.providerId ?? 'unknown'} (${expected.providerDims ?? '?'} dims) / schema v${expected.schemaVersion ?? 'unknown'} — ` +
      'run `codesift index --rebuild`',
    actual,
    expected
  }
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare<[], TableInfoRow>(`pragma table_info(${table})`).all()
  if (columns.some((row) => row.name === column)) {
    return
  }

  db.exec(`alter table ${table} add column ${column} ${definition}`)
}

function readMeta(db: Database.Database, key: string): string | null {
  return db.prepare<[string], { value: string }>('select value from meta where key = ?').get(key)?.value ?? null
}

function readMetaNumber(db: Database.Database, key: string): number | undefined {
  const value = readMeta(db, key)
  if (!value) {
    return undefined
  }

  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : undefined
}

function readChunkCount(db: Database.Database): number {
  return db.prepare<[], { value: number }>('select count(*) as value from chunks').get()?.value ?? 0
}

function stableChunkSortKey(row: ChunkRow): string {
  return `${row.file_path}:${String(row.start_line).padStart(9, '0')}:${String(row.end_line).padStart(9, '0')}:${row.id}`
}

function normalizeContextLines(value: number | undefined): number {
  if (value === undefined) {
    return 0
  }

  if (!Number.isFinite(value) || value < 0) {
    return 0
  }

  return Math.floor(value)
}

function splitLines(content: string): string[] {
  return content.split(/\r?\n/)
}

function isPathInsideRoot(root: string, target: string): boolean {
  const normalizedRoot = normalizePath(root)
  const normalizedTarget = normalizePath(target)
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`)
}

async function removeDatabaseSidecars(path: string): Promise<void> {
  await Promise.all([
    rm(`${path}-shm`, { force: true }),
    rm(`${path}-wal`, { force: true })
  ])
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

function normalizePath(value: string): string {
  return resolve(value).replace(/\\/g, '/').replace(/\/$/, '')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const abortError = new Error('The operation was aborted')
    abortError.name = 'AbortError'
    throw abortError
  }
}
