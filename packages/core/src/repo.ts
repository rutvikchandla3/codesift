import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import Database from 'better-sqlite3'
import { minimatch } from 'minimatch'
import * as sqliteVec from 'sqlite-vec'

import { buildChunks, type ChunkRecord } from './chunking.js'
import { getDefaultEmbeddingProvider, isLearnedEmbeddingProvider } from './embedding.js'
import { isCodeLanguage, isDocumentationLanguage } from './languages.js'
import { scanRepository } from './scan.js'
import { DEFAULT_SEARCH_K, type FindSymbolOptions, type IndexCompatibilitySnapshot, type IndexCompatibilityStatus, type ReadChunkOptions, type ReadRangeOptions, type Repo, type RepoStatus, type SearchHit, type SearchOptions, type StopWatching, type SymbolDefinition, type SymbolKind, type SyncOptions, type SyncResult, type VectorSearchStatus, type WatchOptions } from './types.js'

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
}

interface ChunkLocationRow {
  file_path: string
  start_line: number
  end_line: number
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
}

const SCHEMA_VERSION = '4'
const DEFAULT_RRF_K = 60
const DEFAULT_VECTOR_LIMIT = 50
const DEFAULT_PATH_FILTERED_LIMIT = 200
const VECTOR_SEARCH_UNAVAILABLE_MESSAGE = 'vector search unavailable (native dep), lexical/symbol still works'

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

  constructor(root: string) {
    this.root = resolve(root)
    this.indexDirectoryPath = resolve(this.root, '.codesift')
    this.indexGitignorePath = resolve(this.indexDirectoryPath, '.gitignore')
    this.indexPath = resolve(this.indexDirectoryPath, 'index.db')
  }

  async initialize(): Promise<void> {
    await mkdir(this.indexDirectoryPath, { recursive: true })
    await writeFile(this.indexGitignorePath, '*\n', 'utf8')
  }

  async sync(options?: SyncOptions): Promise<SyncResult> {
    const startedAt = Date.now()
    const provider = getDefaultEmbeddingProvider()

    if (options?.rebuild) {
      await this.resetDatabaseFile()
    }

    await this.initialize()

    let db = this.openDatabase()
    const compatibility = this.getIndexCompatibility(db)
    if (!compatibility.ok && compatibility.code === 'schema_version_mismatch') {
      await this.resetDatabaseFile()
      await this.initialize()
      db = this.openDatabase()
    }

    const previousGeneration = readMetaNumber(db, 'index_generation') ?? 0
    const { files, skippedFiles, skippedSymlinks } = await scanRepository(this.root)
    const fileRows = files.map((file) => ({
      path: file.relativePath,
      language: file.language,
      hash: file.hash,
      size: file.size,
      mtime: file.mtime
    }))

    const chunkRows: IndexedChunkRecord[] = files.flatMap((file) =>
      buildChunks(file).map((chunk) => ({
        ...chunk,
        id: createChunkId(chunk)
      }))
    )

    const batches = buildEmbeddingBatches(chunkRows, provider.maxBatch, provider.maxBatchTokens)
    const insertFile = db.prepare(
      `
        insert into files(path, language, hash, size, mtime)
        values (@path, @language, @hash, @size, @mtime)
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
          embedding
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    const setMeta = db.prepare(`
      insert into meta(key, value)
      values (?, ?)
      on conflict(key) do update set value = excluded.value
    `)

    try {
      this.clearIndex(db)

      db.transaction(() => {
        for (const row of fileRows) {
          insertFile.run(row)
        }
      })()

      let completedChunks = 0

      for (let index = 0; index < batches.length; index += 1) {
        throwIfAborted(options?.signal)

        const batch = batches[index] ?? []
        const embeddings = await provider.embedBatch(
          batch.map((chunk) => chunk.embeddingText),
          { role: 'document' },
          options?.signal
        )

        throwIfAborted(options?.signal)

        db.transaction(() => {
          for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
            const row = batch[batchIndex]!
            const embedding = embeddings[batchIndex] ?? new Float32Array(provider.dims)

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
              row.snippet,
              embedding
            )

            insertChunkFts.run(
              row.id,
              buildLexicalSearchText(row),
              row.symbol ?? '',
              row.parent ?? '',
              row.signature ?? ''
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
        })()

        completedChunks += batch.length
        options?.onProgress?.({
          phase: 'batch',
          batch: index + 1,
          totalBatches: batches.length,
          completedChunks,
          totalChunks: chunkRows.length
        })
      }

      db.transaction(() => {
        setMeta.run('schema_version', SCHEMA_VERSION)
        setMeta.run('provider_id', provider.id)
        setMeta.run('provider_dims', String(provider.dims))
        setMeta.run('model_version', provider.modelVersion ?? provider.model ?? provider.id)
        setMeta.run('indexed_at', new Date().toISOString())
        setMeta.run('index_generation', String(previousGeneration + 1))
      })()
    } catch (error) {
      this.clearIndex(db)
      throw error
    }

    return {
      indexedFiles: files.length,
      skippedFiles,
      skippedSymlinks,
      removedFiles: 0,
      durationMs: Date.now() - startedAt
    }
  }

  async search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    if (!query.trim() || !existsSync(this.indexPath)) {
      return []
    }

    const db = this.openDatabase()
    this.ensureIndexCompatibleForQueries(db)

    const requestedK = options?.k ?? DEFAULT_SEARCH_K
    const limit = options?.pathGlob
      ? Math.max(requestedK * 25, DEFAULT_PATH_FILTERED_LIMIT)
      : Math.max(requestedK * 10, DEFAULT_VECTOR_LIMIT)
    const { whereSql, params } = buildChunkSearchFilters(options)

    const ftsQuery = buildFtsQuery(query)
    const lexicalRows = ftsQuery
      ? applyPathFilter(
          db
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
                  c.parent
                from chunks_fts
                join chunks c on c.id = chunks_fts.chunk_id
                where chunks_fts match ?
                ${whereSql ? `and ${whereSql.replace(/^where\s+/i, '')}` : ''}
                order by bm25(chunks_fts, 1.0, 6.0, 2.5, 2.0) asc, c.file_path asc, c.start_line asc, c.id asc
                limit ${limit}
              `
            )
            .all(ftsQuery, ...params),
          options?.pathGlob
        )
      : []

    const provider = getDefaultEmbeddingProvider()
    const shouldUseVectorSearch = isLearnedEmbeddingProvider(provider) && queryShouldUseVectorSearch(query)
    let vectorRows: ChunkRow[] = []

    if (shouldUseVectorSearch && this.ensureVectorExtension(db)) {
      const [embedding] = await provider.embedBatch([query], { role: 'query' })

      vectorRows = embedding
        ? applyPathFilter(
            db
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
                    parent
                  from chunks
                  ${whereSql}
                  order by vec_distance_cosine(embedding, ?) asc, file_path asc, start_line asc, id asc
                  limit ${limit}
                `
              )
              .all(...params, embedding),
            options?.pathGlob
          )
        : []
    }

    return fuseRankedRows(query, vectorRows, lexicalRows)
      .slice(0, requestedK)
      .map(({ row, score }) => buildSearchHit(row, score, query))
  }

  async findSymbol(name: string, options?: FindSymbolOptions): Promise<SymbolDefinition[]> {
    if (!name.trim() || !existsSync(this.indexPath)) {
      return []
    }

    const db = this.openDatabase()
    this.ensureIndexCompatibleForQueries(db)

    const kinds = normalizeKinds(options?.kind)

    const exactWhere = ['lower(name) = lower(?)']
    const exactParams: string[] = [name]
    if (kinds.length > 0) {
      exactWhere.push(`kind in (${kinds.map(() => '?').join(', ')})`)
      exactParams.push(...kinds)
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
        : db
            .prepare<unknown[], SymbolRow>(
              `
                select id, name, file_path, start_line, end_line, kind, signature, parent, language
                from symbols
                where lower(name) like lower(?)
                ${kinds.length > 0 ? `and kind in (${kinds.map(() => '?').join(', ')})` : ''}
                order by case when lower(name) = lower(?) then 0 else 1 end, file_path asc, start_line asc
                limit 25
              `
            )
            .all(`%${name}%`, ...kinds, name)

    const rows = [...exactRows, ...partialRows]
    const filteredRows = options?.pathGlob
      ? rows.filter((row: SymbolRow) => minimatch(row.file_path, options.pathGlob!))
      : rows

    return filteredRows.map((row) => {
      const definition: SymbolDefinition = {
        id: String(row.id),
        name: row.name,
        file: row.file_path,
        range: {
          startLine: row.start_line,
          endLine: row.end_line
        },
        kind: row.kind
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
    })
  }

  async readChunk(id: string, options?: ReadChunkOptions): Promise<string> {
    const parsedChunkId = parseChunkId(id) ?? this.lookupChunkLocation(id)
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
        indexed: false,
        stale: false,
        chunkCount: 0,
        symbolCount: 0,
        indexGeneration: 0,
        provider: null,
        compatibility: { ok: true },
        vectorSearch: this.getVectorSearchStatus()
      }
    }

    const db = this.openDatabase()
    const counts =
      db
        .prepare<[], { chunk_count: number; symbol_count: number }>(
          `
            select
              (select count(*) from chunks) as chunk_count,
              (select count(*) from symbols) as symbol_count
          `
        )
        .get() ?? { chunk_count: 0, symbol_count: 0 }

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

    return {
      root: this.root,
      indexPath: this.indexPath,
      indexed,
      stale: false,
      chunkCount: counts.chunk_count,
      symbolCount: counts.symbol_count,
      indexGeneration,
      provider,
      compatibility: this.getIndexCompatibility(db, indexed),
      vectorSearch: this.getVectorSearchStatus()
    }
  }

  async watch(_options?: WatchOptions): Promise<StopWatching> {
    return async () => undefined
  }

  private openDatabase(): Database.Database {
    if (this.db) {
      return this.db
    }

    const db = new Database(this.indexPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    this.vectorExtensionLoaded = false
    this.ensureSchema(db)
    this.db = db
    return db
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
        mtime real not null
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
    `)
  }

  private clearIndex(db: Database.Database): void {
    db.exec(`
      delete from symbols;
      delete from chunks_fts;
      delete from chunks;
      delete from files;
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

    const provider = getDefaultEmbeddingProvider()
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
      rm(`${this.indexPath}-shm`, { force: true }),
      rm(`${this.indexPath}-wal`, { force: true })
    ])
  }
}

function normalizeKinds(kind: SearchOptions['kind'] | FindSymbolOptions['kind'] | undefined): SymbolKind[] {
  if (!kind) {
    return []
  }

  return Array.isArray(kind) ? kind : [kind]
}

function buildSearchHit(row: ChunkRow, baseScore: number, query: string): SearchHit {
  const score = baseScore * scoreBoostForRow(row, query)

  const hit: SearchHit = {
    id: row.id,
    file: row.file_path,
    range: {
      startLine: row.start_line,
      endLine: row.end_line
    },
    score,
    snippet: row.snippet
  }

  if (row.language) {
    hit.language = row.language
  }

  if (row.symbol) {
    hit.symbol = row.symbol
  }

  if (row.kind) {
    hit.kind = row.kind
  }

  return hit
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

  return {
    whereSql: whereClauses.length > 0 ? `where ${whereClauses.join(' and ')}` : '',
    params
  }
}

function applyPathFilter<T extends { file_path: string }>(rows: T[], pathGlob?: string): T[] {
  if (!pathGlob) {
    return rows
  }

  return rows.filter((row) => minimatch(row.file_path, pathGlob))
}

function fuseRankedRows(query: string, vectorRows: ChunkRow[], lexicalRows: ChunkRow[]): RankedChunkRow[] {
  const byId = new Map<string, RankedChunkRow>()

  addReciprocalRanks(byId, vectorRows)
  addReciprocalRanks(byId, lexicalRows)

  return [...byId.values()].sort((left, right) => {
    const leftScore = left.score * scoreBoostForRow(left.row, query)
    const rightScore = right.score * scoreBoostForRow(right.row, query)
    const scoreDelta = rightScore - leftScore

    if (Math.abs(scoreDelta) > 1e-12) {
      return scoreDelta
    }

    return stableChunkSortKey(left.row).localeCompare(stableChunkSortKey(right.row))
  })
}

function addReciprocalRanks(target: Map<string, RankedChunkRow>, rows: ChunkRow[]): void {
  rows.forEach((row, index) => {
    const score = 1 / (DEFAULT_RRF_K + index + 1)
    const existing = target.get(row.id)

    if (existing) {
      existing.score += score
      return
    }

    target.set(row.id, {
      row,
      score
    })
  })
}

function scoreBoostForRow(row: ChunkRow, query: string): number {
  let boost = 1

  if (row.language && isCodeLanguage(row.language)) {
    boost *= 1.12
  }

  if (row.symbol) {
    boost *= 1.08
  }

  if (row.kind && row.kind !== 'file') {
    boost *= 1.04
  }

  if (isExactSymbolMatch(row, query)) {
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

function extractSymbolCandidates(query: string): string[] {
  const matches = new Set<string>()
  const rawMatches = query.match(/`([^`]+)`|[A-Za-z_][A-Za-z0-9_.:#]*/g) ?? []

  for (const rawMatch of rawMatches) {
    const candidate = rawMatch.startsWith('`') && rawMatch.endsWith('`') ? rawMatch.slice(1, -1) : rawMatch
    if (!candidate) {
      continue
    }

    const identifierLike =
      candidate.includes('.') ||
      candidate.includes('_') ||
      candidate.includes('::') ||
      candidate.includes('#') ||
      /[a-z0-9][A-Z]/.test(candidate) ||
      /^[A-Z][A-Za-z0-9_]+$/.test(candidate)

    if (!identifierLike) {
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

function buildFtsQuery(query: string): string | null {
  const terms = [...new Set(buildNormalizedTerms(query).filter((term) => !DEFAULT_STOP_WORDS.has(term) && term.length > 1))]
  if (terms.length === 0) {
    return null
  }

  return terms.slice(0, 12).map(quoteFtsTerm).join(' AND ')
}

function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
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

function queryShouldUseVectorSearch(query: string): boolean {
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
  if (normalizedTerms.length <= 4 && extractSymbolCandidates(trimmedQuery).length > 0) {
    return false
  }

  return true
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
  const match = /^(.*):(\d+)-(\d+)@([a-f0-9]{64})$/.exec(id)
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

function estimateTokenCount(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4))
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
