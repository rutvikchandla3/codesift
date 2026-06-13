import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import Database from 'better-sqlite3'
import { minimatch } from 'minimatch'
import * as sqliteVec from 'sqlite-vec'

import { buildChunks } from './chunking.js'
import { getDefaultEmbeddingProvider } from './embedding.js'
import { isCodeLanguage, isDocumentationLanguage } from './languages.js'
import { scanRepository } from './scan.js'
import type {
  FindSymbolOptions,
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

interface ChunkRow {
  id: number
  file_path: string
  start_line: number
  end_line: number
  snippet: string
  language: string | null
  symbol: string | null
  kind: SymbolKind | null
  distance: number
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

const SCHEMA_VERSION = '1'

export class SqliteRepo implements Repo {
  readonly root: string
  private readonly indexPath: string
  private db: Database.Database | undefined

  constructor(root: string) {
    this.root = resolve(root)
    this.indexPath = resolve(this.root, '.codesift', 'index.db')
  }

  async sync(options?: SyncOptions): Promise<SyncResult> {
    const startedAt = Date.now()
    const provider = getDefaultEmbeddingProvider()

    if (options?.rebuild) {
      await this.resetDatabaseFile()
    }

    await mkdir(dirname(this.indexPath), { recursive: true })

    const { files, skippedFiles } = await scanRepository(this.root)
    const fileRows = files.map((file) => ({
      path: file.relativePath,
      language: file.language,
      hash: file.hash,
      size: file.size
    }))

    const chunkRows = files.flatMap((file) =>
      buildChunks(file).map((chunk) => ({
        ...chunk,
        embedding: null as Float32Array | null
      }))
    )

    const embeddings = await provider.embedBatch(
      chunkRows.map((chunk) => chunk.embeddingText),
      options?.signal
    )

    for (let index = 0; index < chunkRows.length; index += 1) {
      const row = chunkRows[index]
      if (row) {
        row.embedding = embeddings[index] ?? null
      }
    }

    const symbolRows = chunkRows.filter((chunk) => chunk.symbol && chunk.kind && chunk.kind !== 'file')

    const db = this.openDatabase()
    this.clearIndex(db)

    const insertFile = db.prepare(
      `
        insert into files(path, language, hash, size)
        values (@path, @language, @hash, @size)
      `
    )
    const insertChunk = db.prepare(
      `
        insert into chunks(
          file_path,
          language,
          start_line,
          end_line,
          symbol,
          kind,
          parent,
          signature,
          snippet,
          content,
          embedding
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    const insertAll = db.transaction(() => {
      for (const row of fileRows) {
        insertFile.run(row)
      }

      for (const row of chunkRows) {
        insertChunk.run(
          row.file,
          row.language,
          row.startLine,
          row.endLine,
          row.symbol ?? null,
          row.kind ?? null,
          row.parent ?? null,
          row.signature ?? null,
          row.snippet,
          row.content,
          row.embedding
        )
      }

      for (const row of symbolRows) {
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

      setMeta.run('schema_version', SCHEMA_VERSION)
      setMeta.run('provider_id', provider.id)
      setMeta.run('provider_dims', String(provider.dims))
      setMeta.run('indexed_at', new Date().toISOString())
    })

    insertAll()

    return {
      indexedFiles: files.length,
      skippedFiles,
      removedFiles: 0,
      durationMs: Date.now() - startedAt
    }
  }

  async search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    if (!query.trim() || !existsSync(this.indexPath)) {
      return []
    }

    const provider = getDefaultEmbeddingProvider()
    const [embedding] = await provider.embedBatch([query])
    if (!embedding) {
      return []
    }

    const db = this.openDatabase()
    const requestedK = options?.k ?? 10
    const limit = options?.pathGlob ? Math.max(requestedK * 25, 200) : Math.max(requestedK * 10, 50)

    const whereClauses: string[] = []
    const parameters: Array<Float32Array | string> = [embedding]

    if (options?.lang && options.lang.length > 0) {
      whereClauses.push(`language in (${options.lang.map(() => '?').join(', ')})`)
      parameters.push(...options.lang)
    }

    const kinds = normalizeKinds(options?.kind)
    if (kinds.length > 0) {
      whereClauses.push(`kind in (${kinds.map(() => '?').join(', ')})`)
      parameters.push(...kinds)
    }

    const whereSql = whereClauses.length > 0 ? `where ${whereClauses.join(' and ')}` : ''
    const rows = db
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
            vec_distance_cosine(embedding, ?) as distance
          from chunks
          ${whereSql}
          order by distance asc
          limit ${limit}
        `
      )
      .all(...parameters)

    const filteredRows = options?.pathGlob
      ? rows.filter((row: ChunkRow) => minimatch(row.file_path, options.pathGlob!))
      : rows

    return filteredRows
      .map((row) => buildSearchHit(row, query))
      .sort((left, right) => right.score - left.score)
      .slice(0, requestedK)
  }

  async findSymbol(name: string, options?: FindSymbolOptions): Promise<SymbolDefinition[]> {
    if (!name.trim() || !existsSync(this.indexPath)) {
      return []
    }

    const db = this.openDatabase()
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

  async status(): Promise<RepoStatus> {
    if (!existsSync(this.indexPath)) {
      return {
        root: this.root,
        indexPath: this.indexPath,
        indexed: false,
        stale: false,
        chunkCount: 0,
        symbolCount: 0,
        provider: null
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

    const providerId = db.prepare<[string], { value: string }>('select value from meta where key = ?').get('provider_id')
    const providerDims = db.prepare<[string], { value: string }>('select value from meta where key = ?').get('provider_dims')

    const provider = providerId
      ? {
          id: providerId.value,
          ...(providerDims ? { dims: Number(providerDims.value) } : {})
        }
      : null

    return {
      root: this.root,
      indexPath: this.indexPath,
      indexed: counts.chunk_count > 0,
      stale: false,
      chunkCount: counts.chunk_count,
      symbolCount: counts.symbol_count,
      provider
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
    sqliteVec.load(db)
    this.ensureSchema(db)
    this.db = db
    return db
  }

  private ensureSchema(db: Database.Database): void {
    const dims = getDefaultEmbeddingProvider().dims
    db.exec(`
      create table if not exists meta(
        key text primary key,
        value text not null
      );

      create table if not exists files(
        path text primary key,
        language text not null,
        hash text not null,
        size integer not null
      );

      create table if not exists chunks(
        id integer primary key autoincrement,
        file_path text not null references files(path) on delete cascade,
        language text not null,
        start_line integer not null,
        end_line integer not null,
        symbol text,
        kind text,
        parent text,
        signature text,
        snippet text not null,
        content text not null,
        embedding blob not null check(vec_length(embedding) = ${dims})
      );

      create index if not exists idx_chunks_language on chunks(language);
      create index if not exists idx_chunks_symbol on chunks(symbol);
      create index if not exists idx_chunks_kind on chunks(kind);

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
      delete from chunks;
      delete from files;
    `)
  }

  private async resetDatabaseFile(): Promise<void> {
    if (this.db) {
      this.db.close()
      this.db = undefined
    }

    await rm(this.indexPath, { force: true })
  }
}

function normalizeKinds(kind: SearchOptions['kind'] | FindSymbolOptions['kind'] | undefined): SymbolKind[] {
  if (!kind) {
    return []
  }

  return Array.isArray(kind) ? kind : [kind]
}

function buildSearchHit(row: ChunkRow, query: string): SearchHit {
  const semanticScore = 1 / (1 + row.distance)
  const score = semanticScore * scoreBoostForRow(row, query)

  const hit: SearchHit = {
    id: String(row.id),
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
