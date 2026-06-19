import Database from 'better-sqlite3'
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_EMBEDDING_PROVIDER_ID,
  FIXTURE_RERANKER_ID,
  LOCAL_HASH_EMBEDDING_PROVIDER_ID,
  getDefaultEmbeddingProvider,
  getEmbeddingProvider,
  listEmbeddingProviders,
  openRepo,
  registerEmbeddingProvider,
  registerFixtureReranker,
  registerReranker,
  setVectorExtensionLoaderForTests,
  type EmbeddingBatchOptions,
  type EmbeddingProvider,
  type SyncProgressEvent
} from '../src/index.js'
import { buildFtsQuery, queryShouldUseVectorSearch } from '../src/repo.js'

const temporaryDirectories: string[] = []
const originalEmbeddingProvider = process.env.CODESIFT_EMBEDDING_PROVIDER
const originalReranker = process.env.CODESIFT_RERANKER

afterEach(async () => {
  setVectorExtensionLoaderForTests()

  if (originalEmbeddingProvider === undefined) {
    delete process.env.CODESIFT_EMBEDDING_PROVIDER
  } else {
    process.env.CODESIFT_EMBEDDING_PROVIDER = originalEmbeddingProvider
  }

  if (originalReranker === undefined) {
    delete process.env.CODESIFT_RERANKER
  } else {
    process.env.CODESIFT_RERANKER = originalReranker
  }

  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true })
    })
  )
})

async function createDemoRepository(prefix: string): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(repoRoot)

  await mkdir(join(repoRoot, 'src', 'auth'), { recursive: true })
  await mkdir(join(repoRoot, 'src', 'network'), { recursive: true })

  await writeFile(
    join(repoRoot, 'src', 'auth', 'jwt.ts'),
    `// Validate JWT tokens and verify signatures before requests continue.
export function verifyJwtToken(token: string): boolean {
  return token.startsWith('eyJ')
}

export class TokenVerifier {
  verify(token: string): boolean {
    return verifyJwtToken(token)
  }
}
`,
    'utf8'
  )

  await writeFile(
    join(repoRoot, 'src', 'network', 'retry.ts'),
    `// Retry failed HTTP requests with exponential backoff.
export function applyRetryBackoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000)
}
`,
    'utf8'
  )

  await writeFile(
    join(repoRoot, 'client.py'),
    `class ApiClient:
    def refresh_token(self):
        """Refresh the API token before retrying requests."""
        return 'token'
`,
    'utf8'
  )

  await writeFile(
    join(repoRoot, 'README.md'),
    `# Demo repo

This project validates JWT tokens before protected requests continue.
TokenVerifier is the main entry point described in docs. TokenVerifier appears here as documentation too.
`,
    'utf8'
  )

  await writeFile(join(repoRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')

  return repoRoot
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(assertion: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (await assertion()) {
      return
    }

    await sleep(50)
  }

  throw new Error('Timed out waiting for condition')
}

async function createLearnedProvider(providerId: string, onEmbed?: (texts: string[], options: EmbeddingBatchOptions) => void): Promise<EmbeddingProvider> {
  const provider: EmbeddingProvider = {
    id: providerId,
    dims: 8,
    maxTokens: 8192,
    maxBatch: 2,
    maxBatchTokens: 4096,
    modelVersion: `${providerId}-model`,
    isLearned: true,
    async embedBatch(texts, options) {
      onEmbed?.(texts, options)
      return texts.map((text) => {
        const vector = new Float32Array(8)
        vector[0] = text.length || 1
        return vector
      })
    }
  }

  registerEmbeddingProvider(provider)
  process.env.CODESIFT_EMBEDDING_PROVIDER = providerId
  return provider
}

describe('@codesift/core', () => {
  it('indexes a repo, keeps stable ids across syncs, and reads chunks from disk', async () => {
    const repoRoot = await createDemoRepository('codesift-core-')
    const repo = await openRepo(repoRoot)

    const firstSync = await repo.sync()
    const firstStatus = await repo.status()
    const jwtHits = await repo.search('verifyJwtToken', { k: 3 })
    const retryHits = await repo.search('retry backoff for HTTP requests', { k: 3 })
    const pythonHits = await repo.search('refresh the api token', { k: 3, lang: ['python'] })
    const srcOnlyHits = await repo.search('refresh the api token', { k: 3, pathGlob: 'src/**' })
    const readmeHits = await repo.search('JWT validation for protected requests', {
      k: 2,
      lang: ['markdown'],
      pathGlob: 'README.md'
    })
    const exactSymbolHits = await repo.search('TokenVerifier', { k: 2 })
    const functionOnlyHits = await repo.search('validate jwt token', { k: 3, kind: 'function' })
    const symbols = await repo.findSymbol('verifyJwtToken')
    const literalGrepHits = await repo.grep('TokenVerifier', { pathGlob: 'src/**', contextLines: 1 })
    const regexGrepHits = await repo.grep('verifyJwtToken\\(token', { regex: true, pathGlob: 'src/auth/**' })
    const chunkSource = await repo.readChunk(jwtHits[0]!.id)
    const rangeSource = await repo.readRange('src/auth/jwt.ts', 2, 4, { contextLines: 1 })

    const secondSearchIds = (await repo.search('verifyJwtToken', { k: 3 })).map((hit) => hit.id)
    await repo.sync()
    const secondSyncIds = (await repo.search('verifyJwtToken', { k: 3 })).map((hit) => hit.id)

    expect(firstSync.indexedFiles).toBe(4)
    expect(firstSync.skippedFiles).toBe(1)
    expect(firstSync.skippedSymlinks).toBe(0)
    expect(firstStatus.indexed).toBe(true)
    expect(firstStatus.chunkCount).toBeGreaterThan(0)
    expect(firstStatus.symbolCount).toBeGreaterThan(0)
    expect(firstStatus.provider?.id).toBe(DEFAULT_EMBEDDING_PROVIDER_ID)
    expect(firstStatus.indexGeneration).toBe(1)
    expect(firstStatus.compatibility.ok).toBe(true)
    expect(getDefaultEmbeddingProvider().id).toBe(DEFAULT_EMBEDDING_PROVIDER_ID)
    expect(DEFAULT_EMBEDDING_PROVIDER_ID).not.toBe(LOCAL_HASH_EMBEDDING_PROVIDER_ID)

    expect(jwtHits[0]?.file).toBe('src/auth/jwt.ts')
    expect(retryHits.some((hit) => hit.file === 'src/network/retry.ts')).toBe(true)
    expect(pythonHits[0]?.file).toBe('client.py')
    expect(srcOnlyHits.some((hit) => hit.file === 'client.py')).toBe(false)
    expect(readmeHits[0]?.file).toBe('README.md')
    expect(exactSymbolHits[0]?.file).toBe('src/auth/jwt.ts')
    expect(functionOnlyHits.every((hit) => hit.kind === 'function')).toBe(true)
    expect(symbols[0]?.file).toBe('src/auth/jwt.ts')
    expect(symbols[0]?.kind).toBe('function')
    expect(literalGrepHits.map((hit) => hit.file)).toEqual(['src/auth/jwt.ts'])
    expect(literalGrepHits[0]?.snippet).toContain('export class TokenVerifier')
    expect(regexGrepHits[0]?.file).toBe('src/auth/jwt.ts')
    expect(regexGrepHits[0]?.line).toBe(2)
    expect(jwtHits[0]?.id).toMatch(/^src\/auth\/jwt\.ts:\d+-\d+@[a-f0-9]{64}$/)
    expect(secondSearchIds).toEqual(jwtHits.map((hit) => hit.id))
    expect(secondSyncIds).toEqual(jwtHits.map((hit) => hit.id))
    expect(chunkSource).toContain('export function verifyJwtToken')
    expect(rangeSource).toContain('// Validate JWT tokens')
    expect(rangeSource).toContain('export function verifyJwtToken')

    // Body inlining (AUTO): the rank-1 hit carries the verbatim, disk-fresh
    // enclosing source, and its tokensReturned accounts for the body.
    const topJwt = jwtHits[0]!
    const topBody = await repo.readRange(topJwt.file, topJwt.range.startLine, topJwt.range.endLine)
    expect(topJwt.body).toBe(topBody)
    expect(topJwt.body).toContain('export function verifyJwtToken')
    expect(topJwt.snippet.length).toBeGreaterThan(0)
    // tokensReturned reflects the inlined body, not just the compact snippet.
    expect(topJwt.tokensReturned).toBeGreaterThanOrEqual(Math.ceil(topJwt.body!.length / 4))

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const fileRow = db
      .prepare<[string], { mtime: number }>('select mtime from files where path = ?')
      .get('src/auth/jwt.ts')
    db.close()

    expect(fileRow?.mtime).toBeGreaterThan(0)
  })

  it('detects stale files and incrementally updates changed and removed paths', async () => {
    const repoRoot = await createDemoRepository('codesift-freshness-')
    const repo = await openRepo(repoRoot)

    await repo.sync()
    await sleep(10)
    await writeFile(
      join(repoRoot, 'src', 'auth', 'jwt.ts'),
      `// Validate JWT tokens and mint fresh credentials.
export function mintFreshToken(subject: string): string {
  return subject + ':fresh'
}
`,
      'utf8'
    )

    const staleStatus = await repo.status()
    const staleHits = await repo.search('verifyJwtToken', { k: 1 })

    expect(staleStatus.stale).toBe(true)
    expect(staleStatus.staleReasons?.some((reason) => reason.code === 'file_modified')).toBe(true)
    expect(staleHits[0]?.stale).toBe(true)

    const changedSync = await repo.sync()
    const freshStatus = await repo.status()
    const newHits = await repo.search('mintFreshToken', { k: 1 })

    expect(changedSync.indexedFiles).toBe(1)
    expect(changedSync.removedFiles).toBe(0)
    expect(freshStatus.stale).toBe(false)
    expect(newHits[0]?.file).toBe('src/auth/jwt.ts')

    await sleep(10)
    await unlink(join(repoRoot, 'src', 'network', 'retry.ts'))

    const removedStatus = await repo.status()
    expect(removedStatus.staleReasons?.some((reason) => reason.code === 'file_removed')).toBe(true)

    const removedSync = await repo.sync()
    const retryHits = await repo.search('retry backoff for HTTP requests', { k: 5 })

    expect(removedSync.indexedFiles).toBe(0)
    expect(removedSync.removedFiles).toBe(1)
    expect(retryHits.some((hit) => hit.file === 'src/network/retry.ts')).toBe(false)
  })

  it('watch refreshes stale indexes after edits', async () => {
    const repoRoot = await createDemoRepository('codesift-watch-')
    const repo = await openRepo(repoRoot)
    await repo.sync()

    const stop = await repo.watch({ debounceMs: 100 })
    try {
      await sleep(10)
      await writeFile(
        join(repoRoot, 'src', 'auth', 'jwt.ts'),
        `export function watchedToken(): string {
  return 'watched'
}
`,
        'utf8'
      )

      await waitFor(async () => {
        const hits = await repo.search('watchedToken', { k: 1 })
        return hits[0]?.file === 'src/auth/jwt.ts' && hits[0]?.stale !== true
      })
    } finally {
      await stop()
    }
  })

  it('watch refreshes a larger repo edit within five seconds', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-watch-large-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })
    for (let index = 0; index < 250; index += 1) {
      await writeFile(
        join(repoRoot, 'src', `file-${String(index).padStart(3, '0')}.ts`),
        `export function largeWatch${index}(): string {
  return 'before-${index}'
}
`,
        'utf8'
      )
    }

    const repo = await openRepo(repoRoot)
    await repo.sync()
    const stop = await repo.watch({ debounceMs: 100 })
    const startedAt = Date.now()

    try {
      await writeFile(
        join(repoRoot, 'src', 'file-123.ts'),
        `export function largeWatchChanged(): string {
  return 'after'
}
`,
        'utf8'
      )

      await waitFor(async () => {
        const hits = await repo.search('largeWatchChanged', { k: 1 })
        return hits[0]?.file === 'src/file-123.ts' && hits[0]?.stale !== true
      }, 5000)
    } finally {
      await stop()
    }

    expect(Date.now() - startedAt).toBeLessThan(5000)
  }, 10_000)

  it('applies path filters before search truncation', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-path-filter-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'aaa'), { recursive: true })
    await mkdir(join(repoRoot, 'zzz'), { recursive: true })

    for (let index = 0; index < 240; index += 1) {
      await writeFile(
        join(repoRoot, 'aaa', `file-${String(index).padStart(3, '0')}.ts`),
        `export function outside${index}(): string {\n  return 'common token outside'\n}\n`,
        'utf8'
      )
    }

    await writeFile(
      join(repoRoot, 'zzz', 'target.ts'),
      `export function targetOnly(): string {\n  return 'common token inside target'\n}\n`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()
    const hits = await repo.search('common token', { k: 1, pathGlob: 'zzz/**' })

    expect(hits.map((hit) => hit.file)).toEqual(['zzz/target.ts'])
  })

  it('registers embedding providers and routes document/query roles with batched progress', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-batch-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })
    for (let index = 0; index < 5; index += 1) {
      await writeFile(
        join(repoRoot, 'src', `file-${index}.ts`),
        `export function feature${index}(): string {\n  return 'feature-${index}'\n}\n`,
        'utf8'
      )
    }

    const calls: Array<{ role: EmbeddingBatchOptions['role']; size: number }> = []
    await createLearnedProvider(`test-provider-${Date.now()}`, (texts, options) => {
      calls.push({ role: options.role, size: texts.length })
    })
    setVectorExtensionLoaderForTests((db) => {
      db.function('vec_distance_cosine', (_left, _right) => 0)
    })

    const progressEvents: SyncProgressEvent[] = []
    const repo = await openRepo(repoRoot)
    await repo.sync({
      onProgress(event) {
        progressEvents.push(event)
      }
    })
    await repo.search('find the feature helper implementation', { k: 2 })

    expect(calls.filter((call) => call.role === 'document').map((call) => call.size)).toEqual([2, 2, 1])
    expect(calls.some((call) => call.role === 'query' && call.size === 1)).toBe(true)
    expect(progressEvents.map((event) => event.completedChunks)).toEqual([2, 4, 5])
  })

  it('reuses content-addressed embeddings for delete+add renames with identical code', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-cache-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })
    const source = `export function cacheStableToken(): string {
  return 'stable'
}
`
    await writeFile(join(repoRoot, 'src', 'old-name.ts'), source, 'utf8')

    const documentBatchSizes: number[] = []
    await createLearnedProvider(`test-provider-cache-${Date.now()}`, (texts, options) => {
      if (options.role === 'document') {
        documentBatchSizes.push(texts.length)
      }
    })

    const repo = await openRepo(repoRoot)
    await repo.sync()
    const initialDocumentEmbeds = documentBatchSizes.reduce((sum, size) => sum + size, 0)

    await unlink(join(repoRoot, 'src', 'old-name.ts'))
    await writeFile(join(repoRoot, 'src', 'new-name.ts'), source, 'utf8')

    const renameSync = await repo.sync()
    const finalDocumentEmbeds = documentBatchSizes.reduce((sum, size) => sum + size, 0)
    const hits = await repo.search('cacheStableToken', { k: 3 })

    expect(initialDocumentEmbeds).toBeGreaterThan(0)
    expect(renameSync.indexedFiles).toBe(1)
    expect(renameSync.removedFiles).toBe(1)
    expect(finalDocumentEmbeds).toBe(initialDocumentEmbeds)
    expect(hits[0]?.file).toBe('src/new-name.ts')
  })

  it('keeps the old index and surfaces failed shadow sync state', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-shadow-fail-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(
      join(repoRoot, 'src', 'token.ts'),
      `export function oldShadowToken(): string {
  return 'old'
}
`,
      'utf8'
    )

    let failEmbeddings = false
    const providerId = `test-provider-shadow-${Date.now()}`
    registerEmbeddingProvider({
      id: providerId,
      dims: 8,
      maxTokens: 8192,
      modelVersion: `${providerId}-model`,
      isLearned: true,
      async embedBatch(texts) {
        if (failEmbeddings) {
          throw new Error('planned embedding failure')
        }

        return texts.map((text) => {
          const vector = new Float32Array(8)
          vector[0] = text.length || 1
          return vector
        })
      }
    })
    process.env.CODESIFT_EMBEDDING_PROVIDER = providerId

    const repo = await openRepo(repoRoot)
    await repo.sync()

    await writeFile(
      join(repoRoot, 'src', 'token.ts'),
      `export function newShadowToken(): string {
  return 'new'
}
`,
      'utf8'
    )
    failEmbeddings = true

    await expect(repo.sync()).rejects.toThrow('planned embedding failure')

    const oldHits = await repo.search('oldShadowToken', { k: 1 })
    const newHits = await repo.search('newShadowToken', { k: 1 })
    const status = await repo.status()

    expect(oldHits[0]?.file).toBe('src/token.ts')
    expect(newHits).toHaveLength(0)
    expect(status.sync.state).toBe('failed')
    expect(status.sync.error).toContain('planned embedding failure')
    expect(status.stale).toBe(true)
  })

  it('aborts cleanly between embedding batches', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-abort-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })
    for (let index = 0; index < 4; index += 1) {
      await writeFile(
        join(repoRoot, 'src', `file-${index}.ts`),
        `export function abortCase${index}(): string {\n  return 'abort-${index}'\n}\n`,
        'utf8'
      )
    }

    await createLearnedProvider(`test-provider-abort-${Date.now()}`)
    const controller = new AbortController()
    const repo = await openRepo(repoRoot)

    await expect(
      repo.sync({
        signal: controller.signal,
        onProgress() {
          controller.abort()
        }
      })
    ).rejects.toMatchObject({ name: 'AbortError' })

    const status = await repo.status()
    expect(status.indexed).toBe(false)
    expect(status.chunkCount).toBe(0)
    expect(status.sync.state).toBe('aborted')
  })

  it('follows safe symlinks, skips unsafe ones, and avoids cycles', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-symlink-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'codesift-symlink-outside-'))
    temporaryDirectories.push(repoRoot, outsideRoot)

    await mkdir(join(repoRoot, 'shared'), { recursive: true })
    await writeFile(
      join(repoRoot, 'shared', 'linked.ts'),
      `export const LINKED_VALUE = 'from-alias'\n`,
      'utf8'
    )
    await writeFile(join(outsideRoot, 'outside.ts'), `export const OUTSIDE_VALUE = 'outside'\n`, 'utf8')

    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(join(repoRoot, 'shared'), join(repoRoot, 'alias'), symlinkType)
    await symlink(outsideRoot, join(repoRoot, 'outside-link'), symlinkType)
    await symlink(repoRoot, join(repoRoot, 'loop'), symlinkType)

    const repo = await openRepo(repoRoot)
    const result = await repo.sync()
    const aliasHits = await repo.search('LINKED_VALUE', { k: 5, pathGlob: 'alias/**' })

    expect(aliasHits.some((hit) => hit.file === 'alias/linked.ts')).toBe(true)
    expect(result.skippedSymlinks).toBeGreaterThanOrEqual(2)
  })

  it('keeps the hash provider as a non-default fixture', () => {
    expect(getEmbeddingProvider(LOCAL_HASH_EMBEDDING_PROVIDER_ID)?.id).toBe(LOCAL_HASH_EMBEDDING_PROVIDER_ID)
    expect(listEmbeddingProviders().some((provider) => provider.id === LOCAL_HASH_EMBEDDING_PROVIDER_ID)).toBe(true)
  })
})

describe('@codesift/core search body inlining', () => {
  it('never inlines when context is "sig" and inlines wherever the budget allows when "body"', async () => {
    const repoRoot = await createDemoRepository('codesift-inline-policy-')
    const repo = await openRepo(repoRoot)
    await repo.sync()

    const sigHits = await repo.search('validate jwt tokens before requests', { k: 5, context: 'sig' })
    expect(sigHits.length).toBeGreaterThan(0)
    expect(sigHits.every((hit) => hit.body === undefined)).toBe(true)
    expect(sigHits[0]?.snippet.length).toBeGreaterThan(0)

    const bodyHits = await repo.search('validate jwt tokens before requests', { k: 5, context: 'body' })
    expect(bodyHits.length).toBeGreaterThan(1)
    // "body" inlines more than just rank-1 (AUTO would stop after the margin).
    expect(bodyHits.filter((hit) => hit.body !== undefined).length).toBeGreaterThan(1)
    for (const hit of bodyHits) {
      if (hit.body !== undefined) {
        const fresh = await repo.readRange(hit.file, hit.range.startLine, hit.range.endLine)
        expect(hit.body).toBe(fresh)
      }
    }
  })

  it('truncates an oversized body to the cap and appends the read_chunk marker', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-inline-truncate-'))
    temporaryDirectories.push(repoRoot)
    await mkdir(join(repoRoot, 'src'), { recursive: true })

    const longBody = Array.from({ length: 80 }, (_, index) => `  const huge${index} = computeHugeRetryBackoff(${index})`).join('\n')
    await writeFile(
      join(repoRoot, 'src', 'huge.ts'),
      `export function hugeRetryBackoffHandler(): number {\n${longBody}\n  return 0\n}\n`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()
    const hits = await repo.search('huge retry backoff handler', { k: 1 })

    expect(hits[0]?.body).toBeDefined()
    const body = hits[0]!.body!
    expect(body).toContain('… (truncated — read_chunk <id> for full)')
    // Cap is whichever of ~50 lines / ~400 tokens is smaller; the body must be
    // shorter than the full 80+ line source on disk.
    expect(body.split('\n').length).toBeLessThanOrEqual(51)
    expect(body).toContain('export function hugeRetryBackoffHandler')
  })

  it('falls back to a compact snippet (no body) when the file is gone at search time', async () => {
    const repoRoot = await createDemoRepository('codesift-inline-fallback-')
    const repo = await openRepo(repoRoot)
    await repo.sync()

    await unlink(join(repoRoot, 'src', 'auth', 'jwt.ts'))
    const hits = await repo.search('verifyJwtToken', { k: 1 })

    expect(hits.length).toBe(1)
    expect(hits[0]?.body).toBeUndefined()
    expect(hits[0]?.snippet.length).toBeGreaterThan(0)
  })

  it('keeps room for a tail hit instead of letting hit-1 body consume the whole budget', async () => {
    const repoRoot = await createDemoRepository('codesift-inline-budget-')
    const repo = await openRepo(repoRoot)
    await repo.sync()

    const hits = await repo.search('validate jwt tokens before requests', { k: 5, maxTokens: 120 })
    expect(hits.length).toBeGreaterThan(1)
  })
})

describe('@codesift/core import-resolved usages', () => {
  it('bundles TS/JS import-resolved and same-file usages for the top definition hit', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-usages-ts-'))
    temporaryDirectories.push(repoRoot)
    await mkdir(join(repoRoot, 'src', 'auth'), { recursive: true })

    await writeFile(
      join(repoRoot, 'src', 'auth', 'jwt.ts'),
      `export function verifyJwtToken(token: string): boolean {
  return token.startsWith('eyJ')
}

export class TokenVerifier {
  verify(token: string): boolean {
    return verifyJwtToken(token)
  }
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'server.ts'),
      `import { verifyJwtToken as checkToken } from './auth/jwt'

export function handle(token: string): boolean {
  return checkToken(token)
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'feature.ts'),
      `import * as auth from './auth/jwt'

export const ok = auth.verifyJwtToken('eyJ-demo')
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()
    const hits = await repo.search('verifyJwtToken', { k: 1, withUsages: true })

    expect(hits[0]?.symbol).toBe('verifyJwtToken')
    expect(hits[0]?.usages).toBeDefined()
    expect(hits[0]?.usages?.map((usage) => `${usage.file}:${usage.line}`)).toEqual(
      expect.arrayContaining(['src/auth/jwt.ts:7', 'src/server.ts:4', 'src/feature.ts:3'])
    )
    expect(hits[0]?.usages?.every((usage) => usage.resolution === 'import-resolved')).toBe(true)
  })

  it('bundles Python import-resolved usages for the top definition hit', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-usages-py-'))
    temporaryDirectories.push(repoRoot)
    await mkdir(join(repoRoot, 'pkg'), { recursive: true })

    await writeFile(join(repoRoot, 'pkg', '__init__.py'), '', 'utf8')
    await writeFile(
      join(repoRoot, 'pkg', 'token.py'),
      `def verify_token(token: str) -> bool:
    return token.startswith('eyJ')
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'pkg', 'consumer.py'),
      `from .token import verify_token as check_token


def handle(token: str) -> bool:
    return check_token(token)
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()
    const hits = await repo.search('verify_token', { k: 1, withUsages: true, pathGlob: 'pkg/**' })

    expect(hits[0]?.symbol).toBe('verify_token')
    expect(hits[0]?.usages?.map((usage) => `${usage.file}:${usage.line}`)).toEqual(['pkg/consumer.py:5'])
  })
})

describe('buildFtsQuery synonym OR-expansion', () => {
  it('expands a synonym-group term into a quoted OR-group joined by AND', () => {
    const fts = buildFtsQuery('validate jwt signature')
    expect(fts).not.toBeNull()
    // "validate" and "jwt" belong to synonym groups; "signature" does not.
    expect(fts).toContain('("validate" OR')
    expect(fts).toContain('"verify"')
    expect(fts).toContain('("jwt" OR')
    expect(fts).toContain('"token"')
    expect(fts).toContain('"signature"')
    expect(fts).toContain(' AND ')
  })

  it('dedupes a term already covered by an earlier group and caps at twelve groups', () => {
    // "verify" is a member of the "validate" group, so a query containing both
    // must not produce two groups for the same expansion.
    const fts = buildFtsQuery('validate verify token')!
    const groupCount = fts.split(' AND ').length
    expect(groupCount).toBe(2)

    const many = Array.from({ length: 20 }, (_, index) => `zzz${index}`).join(' ')
    const cappedGroups = buildFtsQuery(many)!.split(' AND ').length
    expect(cappedGroups).toBe(12)
  })
})

describe('queryShouldUseVectorSearch suppression', () => {
  it('stays vector-eligible for a short query with a single acronym token', () => {
    expect(queryShouldUseVectorSearch('validate JWT signature')).toBe(true)
  })

  it('suppresses vectors only when a short query is majority identifier-like', () => {
    expect(queryShouldUseVectorSearch('TokenVerifier')).toBe(false)
    // Two identifier tokens, four normalized terms: still short AND majority symbol.
    expect(queryShouldUseVectorSearch('TokenVerifier JwtAuth')).toBe(false)
    // One identifier token amid natural-language words: not majority -> eligible.
    expect(queryShouldUseVectorSearch('reset the TokenVerifier state')).toBe(true)
    expect(queryShouldUseVectorSearch('refresh the api token before retrying requests')).toBe(true)
  })
})

describe('@codesift/core opt-in reranker', () => {
  const RERANK_QUERY = 'validate token signature credential check'

  // A thin code stub (over-ranked by the code/symbol fusion boost) plus a guide
  // chunk that actually restates the concept (heavier query-term overlap). Plain
  // fusion ranks the stub first; the overlap reranker should lift the guide.
  async function createRerankRepository(prefix: string): Promise<string> {
    const repoRoot = await mkdtemp(join(tmpdir(), prefix))
    temporaryDirectories.push(repoRoot)
    await mkdir(join(repoRoot, 'src'), { recursive: true })

    await writeFile(
      join(repoRoot, 'src', 'auth.ts'),
      `export function validateToken() {
  // validate token signature credential check
  return true
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'GUIDE.md'),
      `# guide
validate token signature credential check validate token signature credential check
validate token signature credential check validate token signature credential check
`,
      'utf8'
    )

    return repoRoot
  }

  it('lifts the concept-rich hit above its fused rank for an NL-concept query', async () => {
    registerFixtureReranker()
    const repo = await openRepo(await createRerankRepository('codesift-rerank-lift-'))
    await repo.sync()

    const fused = await repo.search(RERANK_QUERY, { k: 5, context: 'sig' })
    const guideFusedRank = fused.findIndex((hit) => hit.file === 'GUIDE.md')
    expect(guideFusedRank).toBeGreaterThan(0)

    process.env.CODESIFT_RERANKER = FIXTURE_RERANKER_ID
    const reranked = await repo.search(RERANK_QUERY, { k: 5, context: 'sig', rerank: true })
    expect(reranked[0]?.file).toBe('GUIDE.md')
    const guideRerankedRank = reranked.findIndex((hit) => hit.file === 'GUIDE.md')
    expect(guideRerankedRank).toBeLessThan(guideFusedRank)
  })

  it('leaves the order untouched without rerank:true (opt-in, never default-on)', async () => {
    registerFixtureReranker()
    process.env.CODESIFT_RERANKER = FIXTURE_RERANKER_ID
    const repo = await openRepo(await createRerankRepository('codesift-rerank-optin-'))
    await repo.sync()

    // The fused baseline: no rerank flag, so even a configured reranker is inert.
    const baseline = await repo.search(RERANK_QUERY, { k: 5, context: 'sig' })
    const withFlagOff = await repo.search(RERANK_QUERY, { k: 5, context: 'sig', rerank: false })

    expect(withFlagOff.map((hit) => hit.file)).toEqual(baseline.map((hit) => hit.file))
    expect(baseline[0]?.file).toBe('src/auth.ts')
  })

  it('falls back to the fused order when the reranker throws', async () => {
    const throwingId = `throwing-rerank-${Date.now()}`
    registerReranker({
      id: throwingId,
      async rerank() {
        throw new Error('reranker exploded')
      }
    })
    const repo = await openRepo(await createRerankRepository('codesift-rerank-throw-'))
    await repo.sync()

    const fused = await repo.search(RERANK_QUERY, { k: 5, context: 'sig' })

    process.env.CODESIFT_RERANKER = throwingId
    const reranked = await repo.search(RERANK_QUERY, { k: 5, context: 'sig', rerank: true })

    expect(reranked.map((hit) => hit.file)).toEqual(fused.map((hit) => hit.file))
  })
})
