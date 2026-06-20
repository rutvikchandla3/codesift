import Database from 'better-sqlite3'
import { cp, mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
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
import { buildFtsQuery, nameTermCoverage, queryConceptTerms, queryShouldUseVectorSearch } from '../src/repo.js'

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

async function copyFixtureRepository(fixtureName: string, prefix: string): Promise<string> {
  const parentDirectory = await mkdtemp(join(tmpdir(), prefix))
  const repoRoot = join(parentDirectory, 'repo')
  temporaryDirectories.push(parentDirectory)
  await cp(join(process.cwd(), 'packages', 'eval', 'fixtures', fixtureName), repoRoot, { recursive: true })
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

  // Windows CI file watcher latency is not reproducible from macOS; keep the smaller watch
  // regression above cross-platform and run this tight perf budget on POSIX only.
  it.skipIf(process.platform === 'win32')('watch refreshes a larger repo edit within five seconds', async () => {
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
    const hit = hits[0]!
    const body = hit.body!
    const locator = `${hit.file}:${hit.range.startLine}-${hit.range.endLine}`
    expect(body).toContain(`… (truncated — read_chunk ${locator} for full)`)
    await expect(repo.readChunk(locator)).resolves.toContain('const huge79 = computeHugeRetryBackoff(79)')
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

describe('@codesift/core find_symbol body inlining', () => {
  it('inlines the verbatim body for the top exact match by default and suppresses it on withBody:false', async () => {
    const repoRoot = await createDemoRepository('codesift-findsymbol-body-')
    const repo = await openRepo(repoRoot)
    await repo.sync()

    const [withBody] = await repo.findSymbol('verifyJwtToken')
    expect(withBody?.file).toBe('src/auth/jwt.ts')
    const fresh = await repo.readRange(withBody!.file, withBody!.range.startLine, withBody!.range.endLine)
    expect(withBody?.body).toBe(fresh)
    expect(withBody?.body).toContain('export function verifyJwtToken')

    const [compact] = await repo.findSymbol('verifyJwtToken', { withBody: false })
    expect(compact?.file).toBe('src/auth/jwt.ts')
    expect(compact?.body).toBeUndefined()
  })

  it('does not inline when the identifier collides across more than three exact rows', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-findsymbol-collide-'))
    temporaryDirectories.push(repoRoot)
    await mkdir(join(repoRoot, 'src'), { recursive: true })

    for (let index = 0; index < 4; index += 1) {
      await writeFile(
        join(repoRoot, 'src', `mod${index}.ts`),
        `export function collidingHandler(): number {\n  return ${index}\n}\n`,
        'utf8'
      )
    }

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const defs = await repo.findSymbol('collidingHandler')
    expect(defs.length).toBe(4)
    expect(defs.every((def) => def.body === undefined)).toBe(true)
  })

  it('leaves rows compact when the file is gone at lookup time', async () => {
    const repoRoot = await createDemoRepository('codesift-findsymbol-missing-')
    const repo = await openRepo(repoRoot)
    await repo.sync()

    await unlink(join(repoRoot, 'src', 'auth', 'jwt.ts'))
    const [def] = await repo.findSymbol('verifyJwtToken')
    expect(def?.file).toBe('src/auth/jwt.ts')
    expect(def?.body).toBeUndefined()
  })

  it('dedents the block-common indentation and collapses blank runs in the inlined body', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-findsymbol-dedent-'))
    temporaryDirectories.push(repoRoot)
    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(
      join(repoRoot, 'src', 'svc.ts'),
      `export class Service {\n  computeDeeplyNestedValue(): number {\n    const base = 1\n\n\n    return base + 2\n  }\n}\n`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const [def] = await repo.findSymbol('computeDeeplyNestedValue')
    expect(def?.body).toBeDefined()
    const body = def!.body!
    // The method's own 2-space indent is the block-common prefix and is stripped,
    // so the signature starts at column 0 while inner indentation is preserved.
    expect(body.split('\n')[0]).toBe('computeDeeplyNestedValue(): number {')
    expect(body).toContain('\n  const base = 1')
    // Runs of 2+ blank lines collapse to one (three newlines never remain).
    expect(body).not.toMatch(/\n[ \t]*\n[ \t]*\n/)
    expect(body).toContain('return base + 2')
  })

  it('truncates oversized bodies with an actionable read_chunk marker', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-findsymbol-truncate-'))
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

    const [def] = await repo.findSymbol('hugeRetryBackoffHandler')
    expect(def?.body).toBeDefined()
    const locator = `${def!.file}:${def!.range.startLine}-${def!.range.endLine}`
    expect(def!.body!).toContain(`… (truncated — read_chunk ${locator} for full)`)
    await expect(repo.readChunk(locator)).resolves.toContain('const huge79 = computeHugeRetryBackoff(79)')
  })
})

describe('@codesift/core relational find_symbol + impact', () => {
  it('bundles caller/ref sites and same-file neighbors for the top exact definition when withCallers:true', async () => {
    const repoRoot = await copyFixtureRepository('usages-ts', 'codesift-findsymbol-relations-')
    const repo = await openRepo(repoRoot)

    await repo.sync()

    const [definition] = await repo.findSymbol('parseToken', { withCallers: true })

    expect(definition?.file).toBe('src/token.ts')
    expect(definition?.body).toContain('export function parseToken')
    expect(definition?.relations?.sites.map((site) => `${site.file}:${site.line}:${site.srcSymbol}:${site.edgeKind}:${site.resolution}`)).toEqual([
      'src/api.ts:4:readSubject:call:import-resolved',
      'src/worker.ts:4:enqueueToken:call:import-resolved'
    ])
    expect(definition?.relations?.neighbors).toMatchObject([
      {
        name: 'ParsedToken',
        file: 'src/token.ts',
        kind: 'interface',
        range: { startLine: 1, endLine: 4 }
      }
    ])
  })

  it('walks bounded transitive callers and reports depth/node caps without exploding', async () => {
    const repoRoot = await copyFixtureRepository('usages-ts', 'codesift-impact-')
    await writeFile(
      join(repoRoot, 'src', 'service.ts'),
      `import { readSubject } from './api'

export function handleToken(header: string): string {
  return readSubject(header)
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'app.ts'),
      `import { handleToken } from './service'

export function runApp(header: string): string {
  return handleToken(header)
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'cli.ts'),
      `import { runApp } from './app'

export function main(header: string): string {
  return runApp(header)
}
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const impact = await repo.impact('parseToken', { depth: 2 })
    expect(impact.nodes.map((node) => `${node.depth}:${node.file}:${node.line}:${node.srcSymbol}:${node.edgeKind}:${node.resolution}`)).toEqual([
      '0:src/api.ts:4:readSubject:call:import-resolved',
      '0:src/worker.ts:4:enqueueToken:call:import-resolved',
      '1:src/service.ts:4:handleToken:call:import-resolved',
      '2:src/app.ts:4:runApp:call:import-resolved'
    ])
    expect(impact.depthCapped).toBe(true)
    expect(impact.nodesCapped).not.toBe(true)
    expect(impact.impactTruncated).not.toBe(true)

    const capped = await repo.impact('parseToken', { depth: 3, maxNodes: 2 })
    expect(capped.nodes).toHaveLength(2)
    expect(capped.nodesCapped).toBe(true)
    expect(capped.impactTruncated).toBe(true)
  })

  it('guards impact traversal against caller cycles', async () => {
    const repoRoot = await copyFixtureRepository('usages-ts', 'codesift-impact-cycle-')
    await writeFile(
      join(repoRoot, 'src', 'a.ts'),
      `import { parseToken } from './token'
import { c } from './c'

export function a(raw: string): string {
  return raw.length > 0 ? parseToken(raw).subject : c(raw)
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'b.ts'),
      `import { a } from './a'

export function b(raw: string): string {
  return a(raw)
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'c.ts'),
      `import { b } from './b'

export function c(raw: string): string {
  return b(raw)
}
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const impact = await repo.impact('parseToken', { depth: 10, maxNodes: 50 })
    expect(impact.nodes.map((node) => `${node.depth}:${node.file}:${node.line}:${node.srcSymbol}:${node.edgeKind}`)).toEqual([
      '0:src/a.ts:5:a:call',
      '0:src/api.ts:4:readSubject:call',
      '0:src/worker.ts:4:enqueueToken:call',
      '1:src/b.ts:4:b:call',
      '2:src/c.ts:4:c:call',
      '3:src/a.ts:5:a:call'
    ])
    expect(impact.depthCapped).not.toBe(true)
    expect(impact.nodesCapped).not.toBe(true)
    expect(impact.impactTruncated).not.toBe(true)
    expect(impact.maxNodes).toBe(50)

    const hardCapped = await repo.impact('parseToken', { depth: 999, maxNodes: 1_000_000 })
    expect(hardCapped.depthLimit).toBe(50)
    expect(hardCapped.maxNodes).toBe(50)
  })
})

describe('@codesift/core import-resolved usages', () => {
  it('writes TS edges at index time and serves fixture usages from the persisted index', async () => {
    const repoRoot = await copyFixtureRepository('usages-ts', 'codesift-fixture-usages-ts-')
    const repo = await openRepo(repoRoot)

    await repo.sync()

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const rows = db
      .prepare<
        [string],
        {
          src_file: string
          src_line: number
          src_symbol: string | null
          dst_file: string | null
          edge_kind: string
          resolution: string
        }
      >(
        `
          select src_file, src_line, src_symbol, dst_file, edge_kind, resolution
          from edges
          where dst_name = ?
          order by src_file asc, src_line asc, edge_kind asc
        `
      )
      .all('parseToken')
    db.close()

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          src_file: 'src/api.ts',
          src_line: 4,
          src_symbol: 'readSubject',
          dst_file: 'src/token.ts',
          edge_kind: 'call',
          resolution: 'import-resolved'
        }),
        expect.objectContaining({
          src_file: 'src/worker.ts',
          src_line: 4,
          src_symbol: 'enqueueToken',
          dst_file: 'src/token.ts',
          edge_kind: 'call',
          resolution: 'import-resolved'
        })
      ])
    )

    const hits = await repo.search('parseToken', { k: 1, withUsages: true })
    expect(hits[0]?.symbol).toBe('parseToken')
    expect(hits[0]?.usages?.map((usage) => `${usage.file}:${usage.line}`)).toEqual(['src/api.ts:4', 'src/worker.ts:4'])
  })

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

  it('keys persisted usages by definition file for colliding TS definitions', async () => {
    const repoRoot = await copyFixtureRepository('collision-ts', 'codesift-fixture-collision-ts-')
    const repo = await openRepo(repoRoot)

    await repo.sync()

    const hits = await repo.search('name must be a non-empty string', { k: 1, withUsages: true })
    expect(hits[0]?.file).toBe('src/schema/validator.ts')
    expect(hits[0]?.symbol).toBe('validate')
    expect(hits[0]?.usages?.map((usage) => `${usage.file}:${usage.line}`)).toEqual(['src/api/handler.ts:6'])

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const rows = db
      .prepare<[string, string], { src_file: string; src_line: number; dst_file: string | null; edge_kind: string }>(
        `
          select src_file, src_line, dst_file, edge_kind
          from edges
          where dst_name = ? and dst_file = ? and edge_kind in ('call', 'ref')
          order by src_file asc, src_line asc
        `
      )
      .all('validate', 'src/schema/validator.ts')
    db.close()

    expect(rows).toEqual([
      {
        src_file: 'src/api/handler.ts',
        src_line: 6,
        dst_file: 'src/schema/validator.ts',
        edge_kind: 'call'
      }
    ])
  })

  it('finds callers, references, and importers from persisted edges', async () => {
    const repoRoot = await copyFixtureRepository('usages-ts', 'codesift-fixture-graph-usages-ts-')
    const repo = await openRepo(repoRoot)

    await repo.sync()

    const callers = await repo.findCallers('parseToken')
    const references = await repo.findReferences('parseToken')
    const importers = await repo.findImporters('src/token.ts')

    expect(callers).toMatchObject([
      {
        file: 'src/api.ts',
        line: 4,
        range: { startLine: 4, endLine: 4 },
        srcSymbol: 'readSubject',
        edgeKind: 'call',
        resolution: 'import-resolved',
        snippet: "  const claims = parseToken(header.replace('Bearer ', ''))",
        language: 'typescript'
      },
      {
        file: 'src/worker.ts',
        line: 4,
        range: { startLine: 4, endLine: 4 },
        srcSymbol: 'enqueueToken',
        edgeKind: 'call',
        resolution: 'import-resolved',
        snippet: '  const claims = parseToken(raw)',
        language: 'typescript'
      }
    ])

    expect(references).toMatchObject([
      {
        file: 'src/api.ts',
        line: 4,
        srcSymbol: 'readSubject',
        edgeKind: 'call',
        resolution: 'import-resolved'
      },
      {
        file: 'src/worker.ts',
        line: 4,
        srcSymbol: 'enqueueToken',
        edgeKind: 'call',
        resolution: 'import-resolved'
      }
    ])

    expect(importers).toMatchObject([
      {
        file: 'src/api.ts',
        line: 1,
        range: { startLine: 1, endLine: 1 },
        edgeKind: 'import',
        resolution: 'import-resolved',
        snippet: "import { parseToken } from './token'",
        language: 'typescript'
      },
      {
        file: 'src/worker.ts',
        line: 1,
        range: { startLine: 1, endLine: 1 },
        edgeKind: 'import',
        resolution: 'import-resolved',
        snippet: "import { parseToken } from './token'",
        language: 'typescript'
      }
    ])
  })

  it('distinguishes callers from non-call references', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-graph-call-vs-ref-'))
    temporaryDirectories.push(repoRoot)
    await mkdir(join(repoRoot, 'src'), { recursive: true })

    await writeFile(
      join(repoRoot, 'src', 'token.ts'),
      `export function parseToken(token: string): string {
  return token.trim()
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'api.ts'),
      `import { parseToken } from './token'

export function readSubject(header: string): string {
  return parseToken(header)
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'ref.ts'),
      `import { parseToken } from './token'

export function keepParser(token: string): string {
  const parser = parseToken
  return parser(token)
}
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    expect((await repo.findCallers('parseToken')).map((result) => `${result.file}:${result.line}:${result.srcSymbol}:${result.edgeKind}`)).toEqual([
      'src/api.ts:4:readSubject:call'
    ])
    expect((await repo.findReferences('parseToken')).map((result) => `${result.file}:${result.line}:${result.srcSymbol}:${result.edgeKind}`)).toEqual([
      'src/api.ts:4:readSubject:call',
      'src/ref.ts:4:keepParser:ref'
    ])
  })

  it('resolves default-import callers, refs, impact, and usages to the real default-exported symbol name', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-default-import-'))
    temporaryDirectories.push(repoRoot)
    await mkdir(join(repoRoot, 'src'), { recursive: true })

    await writeFile(
      join(repoRoot, 'src', 'token.ts'),
      `export default function parseToken(token: string): string {
  return token.trim()
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'api.ts'),
      `import parseToken from './token'

export function readSubject(header: string): string {
  return parseToken(header)
}
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    expect((await repo.findCallers('parseToken')).map((result) => `${result.file}:${result.line}:${result.srcSymbol}:${result.edgeKind}`)).toEqual([
      'src/api.ts:4:readSubject:call'
    ])
    expect((await repo.findReferences('parseToken')).map((result) => `${result.file}:${result.line}:${result.srcSymbol}:${result.edgeKind}`)).toEqual([
      'src/api.ts:4:readSubject:call'
    ])
    expect((await repo.impact('parseToken', { depth: 1 })).nodes.map((node) => `${node.depth}:${node.file}:${node.line}:${node.srcSymbol}:${node.edgeKind}`)).toEqual([
      '0:src/api.ts:4:readSubject:call'
    ])
    expect((await repo.search('parseToken', { k: 1, withUsages: true }))[0]?.usages?.map((usage) => `${usage.file}:${usage.line}`)).toEqual([
      'src/api.ts:4'
    ])
  })

  it('disambiguates callers and references by destination file for colliding definitions', async () => {
    const repoRoot = await copyFixtureRepository('collision-ts', 'codesift-fixture-graph-collision-ts-')
    const repo = await openRepo(repoRoot)

    await repo.sync()

    const callers = await repo.findCallers('validate', { kind: 'function', pathGlob: 'src/schema/**' })
    const references = await repo.findReferences('validate', { kind: 'function', pathGlob: 'src/schema/**' })

    expect(callers).toMatchObject([
      {
        file: 'src/api/handler.ts',
        line: 6,
        srcSymbol: 'handleRequest',
        edgeKind: 'call',
        resolution: 'import-resolved'
      }
    ])
    expect(references).toMatchObject([
      {
        file: 'src/api/handler.ts',
        line: 6,
        srcSymbol: 'handleRequest',
        edgeKind: 'call',
        resolution: 'import-resolved'
      }
    ])
  })

  it('writes TS implements/extends edges and finds implementers from persisted heritage clauses', async () => {
    const repoRoot = await copyFixtureRepository('heritage-ts', 'codesift-fixture-heritage-ts-')
    const repo = await openRepo(repoRoot)

    await repo.sync()

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const rows = db
      .prepare<
        [string],
        {
          src_file: string
          src_line: number
          src_symbol: string | null
          dst_file: string | null
          edge_kind: string
          resolution: string
        }
      >(
        `
          select src_file, src_line, src_symbol, dst_file, edge_kind, resolution
          from edges
          where dst_name = ? and edge_kind in ('implements', 'extends')
          order by src_file asc, src_line asc, edge_kind asc
        `
      )
      .all('AuthStrategy')
    db.close()

    expect(rows).toEqual([
      {
        src_file: 'src/impl.ts',
        src_line: 3,
        src_symbol: 'JwtVerifier',
        dst_file: 'src/contract.ts',
        edge_kind: 'implements',
        resolution: 'import-resolved'
      },
      {
        src_file: 'src/impl.ts',
        src_line: 9,
        src_symbol: 'StrictStrategy',
        dst_file: 'src/contract.ts',
        edge_kind: 'extends',
        resolution: 'import-resolved'
      }
    ])

    const authImplementers = await repo.findImplementers('AuthStrategy')
    const baseImplementers = await repo.findImplementers('BaseVerifier')

    expect(authImplementers).toMatchObject([
      {
        file: 'src/impl.ts',
        line: 3,
        srcSymbol: 'JwtVerifier',
        edgeKind: 'implements',
        resolution: 'import-resolved'
      },
      {
        file: 'src/impl.ts',
        line: 9,
        srcSymbol: 'StrictStrategy',
        edgeKind: 'extends',
        resolution: 'import-resolved'
      }
    ])
    expect(baseImplementers).toMatchObject([
      {
        file: 'src/impl.ts',
        line: 3,
        srcSymbol: 'JwtVerifier',
        edgeKind: 'extends',
        resolution: 'import-resolved'
      }
    ])
  })

  it('matches caller, ref, implementer, and impact lookups case-insensitively', async () => {
    const usagesRepoRoot = await copyFixtureRepository('usages-ts', 'codesift-graph-case-usages-')
    const usagesRepo = await openRepo(usagesRepoRoot)
    await usagesRepo.sync()

    expect((await usagesRepo.findCallers('ParseToken')).map((result) => `${result.file}:${result.line}:${result.srcSymbol}:${result.edgeKind}`)).toEqual([
      'src/api.ts:4:readSubject:call',
      'src/worker.ts:4:enqueueToken:call'
    ])
    expect((await usagesRepo.findReferences('ParseToken')).map((result) => `${result.file}:${result.line}:${result.srcSymbol}:${result.edgeKind}`)).toEqual([
      'src/api.ts:4:readSubject:call',
      'src/worker.ts:4:enqueueToken:call'
    ])
    expect((await usagesRepo.impact('ParseToken', { depth: 0 })).nodes.map((node) => `${node.depth}:${node.file}:${node.line}:${node.srcSymbol}:${node.edgeKind}`)).toEqual([
      '0:src/api.ts:4:readSubject:call',
      '0:src/worker.ts:4:enqueueToken:call'
    ])

    const heritageRepoRoot = await copyFixtureRepository('heritage-ts', 'codesift-graph-case-heritage-')
    const heritageRepo = await openRepo(heritageRepoRoot)
    await heritageRepo.sync()

    expect((await heritageRepo.findImplementers('authstrategy')).map((result) => `${result.file}:${result.line}:${result.srcSymbol}:${result.edgeKind}`)).toEqual([
      'src/impl.ts:3:JwtVerifier:implements',
      'src/impl.ts:9:StrictStrategy:extends'
    ])
  })

  it('does not mix name-only callers into a disambiguated import-resolved query', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-graph-name-only-disambiguation-'))
    temporaryDirectories.push(repoRoot)
    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await mkdir(join(repoRoot, 'auth'), { recursive: true })

    await writeFile(
      join(repoRoot, 'src', 'token.ts'),
      `export function parseToken(token: string): string {
  return token.trim()
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'api.ts'),
      `import { parseToken } from './token'

export function readSubject(header: string): string {
  return parseToken(header)
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'auth', 'token.go'),
      `package auth

func parseToken(token string) string {
  return token
}

func handleToken(token string) string {
  return parseToken(token)
}
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    expect((await repo.findCallers('parseToken', { kind: 'function', pathGlob: 'src/**' })).map((result) => `${result.file}:${result.line}:${result.srcSymbol}:${result.resolution}`)).toEqual([
      'src/api.ts:4:readSubject:import-resolved'
    ])
    expect((await repo.findCallers('parseToken', { kind: 'function', pathGlob: 'auth/**' })).map((result) => `${result.file}:${result.line}:${result.srcSymbol}:${result.resolution}`)).toEqual([
      'auth/token.go:8:handleToken:name-only'
    ])
  })

  it('writes name-only Go call edges and serves callers from persisted edges', async () => {
    const repoRoot = await copyFixtureRepository('m3-go', 'codesift-fixture-graph-m3-go-')
    await writeFile(
      join(repoRoot, 'auth', 'consumer.go'),
      `package auth

func ValidateBearer(token string) bool {
  verifier := NewTokenVerifier()
  return verifier.VerifyToken(token)
}
`,
      'utf8'
    )
    const repo = await openRepo(repoRoot)

    await repo.sync()

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const rows = db
      .prepare<
        [string],
        {
          src_file: string
          src_line: number
          src_symbol: string | null
          dst_file: string | null
          edge_kind: string
          resolution: string
        }
      >(
        `
          select src_file, src_line, src_symbol, dst_file, edge_kind, resolution
          from edges
          where dst_name = ? and edge_kind = 'call'
          order by src_file asc, src_line asc
        `
      )
      .all('VerifyToken')
    db.close()

    expect(rows).toEqual([
      {
        src_file: 'auth/consumer.go',
        src_line: 5,
        src_symbol: 'ValidateBearer',
        dst_file: null,
        edge_kind: 'call',
        resolution: 'name-only'
      }
    ])

    const callers = await repo.findCallers('VerifyToken', { kind: 'method', pathGlob: 'auth/**' })
    expect(callers).toMatchObject([
      {
        file: 'auth/consumer.go',
        line: 5,
        srcSymbol: 'ValidateBearer',
        edgeKind: 'call',
        resolution: 'name-only',
        language: 'go'
      }
    ])
  })

  it('writes name-only Java call edges and serves callers from persisted edges', async () => {
    const repoRoot = await copyFixtureRepository('m3-java', 'codesift-fixture-graph-m3-java-')
    await writeFile(
      join(repoRoot, 'src', 'auth', 'Consumer.java'),
      `package auth;

public class Consumer {
  boolean validateBearer(String token) {
    TokenVerifier verifier = new TokenVerifier();
    return verifier.verifyToken(token);
  }
}
`,
      'utf8'
    )
    const repo = await openRepo(repoRoot)

    await repo.sync()

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const rows = db
      .prepare<
        [string],
        {
          src_file: string
          src_line: number
          src_symbol: string | null
          dst_file: string | null
          edge_kind: string
          resolution: string
        }
      >(
        `
          select src_file, src_line, src_symbol, dst_file, edge_kind, resolution
          from edges
          where dst_name = ? and edge_kind = 'call'
          order by src_file asc, src_line asc
        `
      )
      .all('verifyToken')
    db.close()

    expect(rows).toEqual([
      {
        src_file: 'src/auth/Consumer.java',
        src_line: 6,
        src_symbol: 'validateBearer',
        dst_file: null,
        edge_kind: 'call',
        resolution: 'name-only'
      }
    ])

    const callers = await repo.findCallers('verifyToken', { kind: 'method', pathGlob: 'src/auth/**' })
    expect(callers).toMatchObject([
      {
        file: 'src/auth/Consumer.java',
        line: 6,
        srcSymbol: 'validateBearer',
        edgeKind: 'call',
        resolution: 'name-only',
        language: 'java'
      }
    ])
  })

  it('writes name-only Ruby call edges and serves callers from persisted edges', async () => {
    const repoRoot = await copyFixtureRepository('m3-ruby', 'codesift-fixture-graph-m3-ruby-')
    await writeFile(
      join(repoRoot, 'lib', 'auth', 'consumer.rb'),
      `module Auth
  class Consumer
    def validate_bearer(token)
      verifier = TokenVerifier.new
      verifier.verify_token(token)
    end
  end
end
`,
      'utf8'
    )
    const repo = await openRepo(repoRoot)

    await repo.sync()

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const rows = db
      .prepare<
        [string],
        {
          src_file: string
          src_line: number
          src_symbol: string | null
          dst_file: string | null
          edge_kind: string
          resolution: string
        }
      >(
        `
          select src_file, src_line, src_symbol, dst_file, edge_kind, resolution
          from edges
          where dst_name = ? and edge_kind = 'call'
          order by src_file asc, src_line asc
        `
      )
      .all('verify_token')
    db.close()

    expect(rows).toEqual([
      {
        src_file: 'lib/auth/consumer.rb',
        src_line: 5,
        src_symbol: 'validate_bearer',
        dst_file: null,
        edge_kind: 'call',
        resolution: 'name-only'
      }
    ])

    const callers = await repo.findCallers('verify_token', { kind: 'method', pathGlob: 'lib/auth/**' })
    expect(callers).toMatchObject([
      {
        file: 'lib/auth/consumer.rb',
        line: 5,
        srcSymbol: 'validate_bearer',
        edgeKind: 'call',
        resolution: 'name-only',
        language: 'ruby'
      }
    ])
  })

  it('writes name-only Rust call edges and serves callers from persisted edges', async () => {
    const repoRoot = await copyFixtureRepository('m3-rust', 'codesift-fixture-graph-m3-rust-')
    await writeFile(
      join(repoRoot, 'src', 'consumer.rs'),
      `pub fn validate_bearer(token: &str) -> bool {
    let verifier = auth::TokenVerifier;
    verifier.verify_token(token)
}
`,
      'utf8'
    )
    const repo = await openRepo(repoRoot)

    await repo.sync()

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const rows = db
      .prepare<
        [string],
        {
          src_file: string
          src_line: number
          src_symbol: string | null
          dst_file: string | null
          edge_kind: string
          resolution: string
        }
      >(
        `
          select src_file, src_line, src_symbol, dst_file, edge_kind, resolution
          from edges
          where dst_name = ? and edge_kind = 'call'
          order by src_file asc, src_line asc
        `
      )
      .all('verify_token')
    db.close()

    expect(rows).toEqual([
      {
        src_file: 'src/consumer.rs',
        src_line: 3,
        src_symbol: 'validate_bearer',
        dst_file: null,
        edge_kind: 'call',
        resolution: 'name-only'
      }
    ])

    const callers = await repo.findCallers('verify_token', { kind: 'method', pathGlob: 'src/**' })
    expect(callers).toMatchObject([
      {
        file: 'src/consumer.rs',
        line: 3,
        srcSymbol: 'validate_bearer',
        edgeKind: 'call',
        resolution: 'name-only',
        language: 'rust'
      }
    ])
  })

  it('resolves dotted Python module imports to the final member without bogus intermediate edges', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-usages-py-dotted-import-'))
    temporaryDirectories.push(repoRoot)
    await mkdir(join(repoRoot, 'a', 'b'), { recursive: true })

    await writeFile(join(repoRoot, 'a', '__init__.py'), '', 'utf8')
    await writeFile(join(repoRoot, 'a', 'b', '__init__.py'), '', 'utf8')
    await writeFile(
      join(repoRoot, 'a', 'b', 'c.py'),
      `def func() -> str:
    return 'ok'
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'consumer.py'),
      `import a.b.c


def handle() -> None:
    a.b.c.func()
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const rows = db
      .prepare<
        [string],
        {
          src_file: string
          src_line: number
          src_symbol: string | null
          dst_file: string | null
          edge_kind: string
          resolution: string
        }
      >(
        `
          select src_file, src_line, src_symbol, dst_file, edge_kind, resolution
          from edges
          where dst_name = ? and edge_kind in ('call', 'ref')
          order by src_file asc, src_line asc
        `
      )
      .all('func')
    const bogusRows = db
      .prepare<[string, number], { dst_name: string }>(
        `
          select dst_name
          from edges
          where src_file = ? and src_line = ? and dst_name in ('b', 'c')
          order by dst_name asc
        `
      )
      .all('consumer.py', 5)
    db.close()

    expect(rows).toEqual([
      {
        src_file: 'consumer.py',
        src_line: 5,
        src_symbol: 'handle',
        dst_file: 'a/b/c.py',
        edge_kind: 'call',
        resolution: 'import-resolved'
      }
    ])
    expect(bogusRows).toEqual([])

    const callers = await repo.findCallers('func', { kind: 'function', pathGlob: 'a/**' })
    expect(callers).toMatchObject([
      {
        file: 'consumer.py',
        line: 5,
        srcSymbol: 'handle',
        edgeKind: 'call',
        resolution: 'import-resolved',
        language: 'python'
      }
    ])
  })

  it('resolves dotted Python from-imports to the dotted module file', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-usages-py-dotted-from-'))
    temporaryDirectories.push(repoRoot)
    await mkdir(join(repoRoot, 'a', 'b'), { recursive: true })

    await writeFile(join(repoRoot, 'a', '__init__.py'), '', 'utf8')
    await writeFile(join(repoRoot, 'a', 'b', '__init__.py'), '', 'utf8')
    await writeFile(
      join(repoRoot, 'a', 'b', 'c.py'),
      `def func() -> str:
    return 'ok'
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'consumer.py'),
      `from a.b.c import func


def handle() -> str:
    return func()
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const rows = db
      .prepare<
        [string],
        {
          src_file: string
          src_line: number
          src_symbol: string | null
          dst_file: string | null
          edge_kind: string
          resolution: string
        }
      >(
        `
          select src_file, src_line, src_symbol, dst_file, edge_kind, resolution
          from edges
          where dst_name = ? and edge_kind in ('call', 'ref')
          order by src_file asc, src_line asc
        `
      )
      .all('func')
    db.close()

    expect(rows).toEqual([
      {
        src_file: 'consumer.py',
        src_line: 5,
        src_symbol: 'handle',
        dst_file: 'a/b/c.py',
        edge_kind: 'call',
        resolution: 'import-resolved'
      }
    ])

    const callers = await repo.findCallers('func', { kind: 'function', pathGlob: 'a/**' })
    expect(callers).toMatchObject([
      {
        file: 'consumer.py',
        line: 5,
        srcSymbol: 'handle',
        edgeKind: 'call',
        resolution: 'import-resolved',
        language: 'python'
      }
    ])
  })

  it('masks Ruby heredocs, word arrays, and block comments without swallowing real calls', async () => {
    const repoRoot = await copyFixtureRepository('m3-ruby', 'codesift-fixture-graph-ruby-masking-')
    await writeFile(
      join(repoRoot, 'lib', 'auth', 'query_consumer.rb'),
      `=begin
ghost_call()
=end

module Auth
  class QueryConsumer
    def run(token)
      sql = <<~SQL
        select(:id)
      SQL
      labels = %w[foo bar]
      metrics = %W[notify(#{token}) audit]
      verifier = TokenVerifier.new
      verifier.verify_token(token)
    end
  end
end
`,
      'utf8'
    )
    const repo = await openRepo(repoRoot)

    await repo.sync()

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const rows = db
      .prepare<
        [string],
        {
          src_file: string
          src_line: number
          src_symbol: string | null
          dst_file: string | null
          edge_kind: string
          resolution: string
        }
      >(
        `
          select src_file, src_line, src_symbol, dst_file, edge_kind, resolution
          from edges
          where dst_name = ? and edge_kind = 'call'
          order by src_file asc, src_line asc
        `
      )
      .all('verify_token')
    const noiseRows = db
      .prepare<[string], { dst_name: string }>(
        `
          select dst_name
          from edges
          where src_file = ? and dst_name in ('ghost_call', 'notify', 'select')
          order by dst_name asc
        `
      )
      .all('lib/auth/query_consumer.rb')
    db.close()

    expect(rows).toEqual([
      {
        src_file: 'lib/auth/query_consumer.rb',
        src_line: 14,
        src_symbol: 'run',
        dst_file: null,
        edge_kind: 'call',
        resolution: 'name-only'
      }
    ])
    expect(noiseRows).toEqual([])

    const callers = await repo.findCallers('verify_token', { kind: 'method', pathGlob: 'lib/auth/**' })
    expect(callers).toMatchObject([
      {
        file: 'lib/auth/query_consumer.rb',
        line: 14,
        srcSymbol: 'run',
        edgeKind: 'call',
        resolution: 'name-only',
        language: 'ruby'
      }
    ])
  })

  it('does not treat Ruby left-shift as a heredoc opener', async () => {
    const repoRoot = await copyFixtureRepository('m3-ruby', 'codesift-fixture-graph-ruby-left-shift-')
    await writeFile(
      join(repoRoot, 'lib', 'auth', 'left_shift_consumer.rb'),
      `module Auth
  class LeftShiftConsumer
    def run(token)
      values = []
      values << token
      verifier = TokenVerifier.new
      verifier.verify_token(token)
    end
  end
end
`,
      'utf8'
    )
    const repo = await openRepo(repoRoot)

    await repo.sync()

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const rows = db
      .prepare<
        [string],
        {
          src_file: string
          src_line: number
          src_symbol: string | null
          dst_file: string | null
          edge_kind: string
          resolution: string
        }
      >(
        `
          select src_file, src_line, src_symbol, dst_file, edge_kind, resolution
          from edges
          where dst_name = ? and edge_kind = 'call'
          order by src_file asc, src_line asc
        `
      )
      .all('verify_token')
    db.close()

    expect(rows).toEqual([
      {
        src_file: 'lib/auth/left_shift_consumer.rb',
        src_line: 7,
        src_symbol: 'run',
        dst_file: null,
        edge_kind: 'call',
        resolution: 'name-only'
      }
    ])

    const callers = await repo.findCallers('verify_token', { kind: 'method', pathGlob: 'lib/auth/**' })
    expect(callers).toMatchObject([
      {
        file: 'lib/auth/left_shift_consumer.rb',
        line: 7,
        srcSymbol: 'run',
        edgeKind: 'call',
        resolution: 'name-only',
        language: 'ruby'
      }
    ])
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

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const rows = db
      .prepare<
        [string],
        {
          src_file: string
          src_line: number
          src_symbol: string | null
          dst_file: string | null
          edge_kind: string
          resolution: string
        }
      >(
        `
          select src_file, src_line, src_symbol, dst_file, edge_kind, resolution
          from edges
          where dst_name = ? and edge_kind in ('call', 'ref')
          order by src_file asc, src_line asc
        `
      )
      .all('verify_token')
    db.close()

    expect(rows).toEqual([
      {
        src_file: 'pkg/consumer.py',
        src_line: 5,
        src_symbol: 'handle',
        dst_file: 'pkg/token.py',
        edge_kind: 'call',
        resolution: 'import-resolved'
      }
    ])

    const hits = await repo.search('verify_token', { k: 1, withUsages: true, pathGlob: 'pkg/**' })
    expect(hits[0]?.symbol).toBe('verify_token')
    expect(hits[0]?.usages?.map((usage) => `${usage.file}:${usage.line}`)).toEqual(['pkg/consumer.py:5'])
  })

  it('skips shadowed TS same-file matches and Python member-access matches under import-resolved labels', async () => {
    const tsRepoRoot = await mkdtemp(join(tmpdir(), 'codesift-graph-shadowed-ts-'))
    temporaryDirectories.push(tsRepoRoot)
    await mkdir(join(tsRepoRoot, 'src'), { recursive: true })
    await writeFile(
      join(tsRepoRoot, 'src', 'token.ts'),
      `export function parseToken(token: string): string {
  return token.trim()
}

export function wrapToken(raw: string): string {
  const parseToken = (value: string): string => value.toUpperCase()
  return parseToken(raw)
}
`,
      'utf8'
    )

    const tsRepo = await openRepo(tsRepoRoot)
    await tsRepo.sync()
    expect(await tsRepo.findReferences('parseToken')).toEqual([])

    const pyRepoRoot = await mkdtemp(join(tmpdir(), 'codesift-graph-member-access-py-'))
    temporaryDirectories.push(pyRepoRoot)
    await mkdir(join(pyRepoRoot, 'pkg'), { recursive: true })
    await writeFile(join(pyRepoRoot, 'pkg', '__init__.py'), '', 'utf8')
    await writeFile(
      join(pyRepoRoot, 'pkg', 'token.py'),
      `def validate(token: str) -> str:
    return token

class Service:
    def validate(self, token: str) -> str:
        return token

    def run(self, token: str) -> str:
        return self.validate(token)
`,
      'utf8'
    )

    const pyRepo = await openRepo(pyRepoRoot)
    await pyRepo.sync()
    expect(await pyRepo.findReferences('validate', { kind: 'function', pathGlob: 'pkg/token.py' })).toEqual([])
  })

  it('replaces persisted edges on incremental re-sync when a source file changes', async () => {
    const repoRoot = await copyFixtureRepository('usages-ts', 'codesift-fixture-usages-ts-resync-')
    const repo = await openRepo(repoRoot)

    await repo.sync()
    await writeFile(
      join(repoRoot, 'src', 'api.ts'),
      `export function readSubject(header: string): string {
  return header.replace('Bearer ', '')
}
`,
      'utf8'
    )
    await repo.sync()

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const apiEdgeCount = db
      .prepare<[string, string], { value: number }>('select count(*) as value from edges where src_file = ? and dst_name = ?')
      .get('src/api.ts', 'parseToken')
    const workerRows = db
      .prepare<[string, string], { src_file: string; src_line: number; edge_kind: string }>(
        `
          select src_file, src_line, edge_kind
          from edges
          where src_file = ? and dst_name = ? and edge_kind in ('call', 'ref')
          order by src_line asc
        `
      )
      .all('src/worker.ts', 'parseToken')
    db.close()

    expect(apiEdgeCount?.value).toBe(0)
    expect(workerRows).toEqual([{ src_file: 'src/worker.ts', src_line: 4, edge_kind: 'call' }])
  })

  it('clears both outbound and inbound edges when a file is removed', async () => {
    const repoRoot = await copyFixtureRepository('usages-ts', 'codesift-fixture-usages-ts-remove-')
    await writeFile(
      join(repoRoot, 'src', 'service.ts'),
      `import { readSubject } from './api'

export function handleToken(header: string): string {
  return readSubject(header)
}
`,
      'utf8'
    )
    const repo = await openRepo(repoRoot)

    await repo.sync()
    await unlink(join(repoRoot, 'src', 'api.ts'))
    await repo.sync()

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const outboundCount = db.prepare<[string], { value: number }>('select count(*) as value from edges where src_file = ?').get('src/api.ts')
    const inboundCount = db.prepare<[string], { value: number }>('select count(*) as value from edges where dst_file = ?').get('src/api.ts')
    db.close()

    expect(outboundCount?.value).toBe(0)
    expect(inboundCount?.value).toBe(0)
    expect(await repo.findImporters('src/api.ts')).toEqual([])
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

describe('@codesift/core progressive FTS relaxation', () => {
  it('recalls the target when an over-constrained concept query names a word the target lacks', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-relax-'))
    temporaryDirectories.push(repoRoot)
    await mkdir(join(repoRoot, 'src'), { recursive: true })

    await writeFile(
      join(repoRoot, 'src', 'signature.ts'),
      `// Validate the JWT token signature before continuing.
export function validateJwtSignature(token: string): boolean {
  return token.split('.').length === 3
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'verify.ts'),
      `// Verify a JWT token signature against the configured key.
export function verifyTokenSignature(token: string): boolean {
  return validateJwtSignature(token)
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'decode.ts'),
      `// Decode a JWT token and read its signature payload.
export function decodeJwtToken(token: string): string {
  return token.split('.')[1] ?? ''
}
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    // "webauthn" is indexed nowhere, so the unrelaxed full-AND FTS query requires a
    // term the target lacks — it would match zero rows.
    const overConstrained = 'validate jwt token signature webauthn'
    expect(buildFtsQuery(overConstrained)).toContain('"webauthn"')
    expect(buildFtsQuery(overConstrained)).toContain(' AND ')

    // The relaxation ladder drops the absent word and still recalls the function.
    const hits = await repo.search(overConstrained, { k: 5 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((hit) => hit.file.endsWith('signature.ts'))).toBe(true)

    // Sanity: the absent word in isolation recalls nothing, so the hit above came
    // from relaxation widening the query, not from "webauthn" matching anything.
    const absentOnly = await repo.search('webauthn', { k: 5 })
    expect(absentOnly).toHaveLength(0)
  })
})

describe('@codesift/core query-aware ranking', () => {
  it('extracts distinct concept terms, dropping stop words and 1-char tokens', () => {
    const terms = queryConceptTerms('parse the Cookie header with keys and values')
    // camelCase already lowercase here; stop words ("the", "with", "and") dropped.
    expect(terms).toEqual(expect.arrayContaining(['parse', 'cookie', 'header', 'keys', 'values']))
    expect(terms).not.toContain('the')
    expect(terms).not.toContain('and')
    expect(terms).not.toContain('with')
  })

  it('measures concept-term coverage over the name/parent/signature surface', () => {
    const terms = queryConceptTerms('parse cookie header pairs')

    // symbol "parseCookieHeader" covers parse+cookie+header (3/4).
    const named = nameTermCoverage(
      { symbol: 'parseCookieHeader', parent: null, signature: '(header: string): Record<string, string>' },
      terms
    )
    expect(named).toBeCloseTo(3 / 4)

    // Coverage reaches through the parent and signature surfaces, not just symbol.
    const viaParentAndSig = nameTermCoverage(
      { symbol: 'split', parent: 'CookieHeader', signature: '(input: string, pairs: number)' },
      terms
    )
    expect(viaParentAndSig).toBeCloseTo(3 / 4) // cookie+header (parent) + pairs (sig)

    // A name that shares none of the concept words covers nothing, even if its body
    // would mention them — body text is not part of the name surface.
    expect(nameTermCoverage({ symbol: 'unrelatedHelper', parent: null, signature: '(value: number)' }, terms)).toBe(0)

    // No concept terms (or no name surface) => no coverage signal.
    expect(nameTermCoverage({ symbol: 'parseCookieHeader', parent: null, signature: null }, [])).toBe(0)
    expect(nameTermCoverage({ symbol: null, parent: null, signature: null }, terms)).toBe(0)
  })

  it('keeps a documentation heading from outranking the code it documents on a code query', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-docrank-'))
    temporaryDirectories.push(repoRoot)
    await mkdir(join(repoRoot, 'src'), { recursive: true })

    // The real code definition the query is about.
    await writeFile(
      join(repoRoot, 'src', 'cookie.ts'),
      `export function parseCookieValues(header: string): string[] {
  return header.split(';').map((segment) => segment.trim())
}
`,
      'utf8'
    )

    // A README whose H1 ("cookie") matches the identifier-shaped query token. Indexed
    // as a "symbol", it would otherwise claim the high-weight exact arm and float the
    // prose title above the function it documents.
    await writeFile(
      join(repoRoot, 'README.md'),
      `# cookie

Parse the cookie header into values. This documents how the cookie header parse
and its values work for the cookie header.
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const hits = await repo.search('parse cookie header values', { k: 5 })
    expect(hits.length).toBeGreaterThan(0)
    // The code function, not the README heading, must lead a code-concept query.
    expect(hits[0]?.file).toBe('src/cookie.ts')
    expect(hits[0]?.symbol).toBe('parseCookieValues')
    const readmeRank = hits.findIndex((hit) => hit.file === 'README.md')
    expect(readmeRank === -1 || readmeRank > 0).toBe(true)
  })

  it('still surfaces a documentation heading when the query is documentation-focused', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-docfocus-'))
    temporaryDirectories.push(repoRoot)
    await mkdir(join(repoRoot, 'src'), { recursive: true })

    await writeFile(
      join(repoRoot, 'src', 'cookie.ts'),
      `export function parseCookieValues(header: string): string[] {
  return header.split(';').map((segment) => segment.trim())
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'README.md'),
      `# cookie

Parse the cookie header into values.
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    // A doc-focused query (mentions "readme") keeps doc headings eligible.
    const hits = await repo.search('cookie readme overview', { k: 5 })
    expect(hits.some((hit) => hit.file === 'README.md')).toBe(true)
  })
})

describe('@codesift/core confidence-gated single_best', () => {
  async function buildLoadConfigCollision(fileCount: number): Promise<Awaited<ReturnType<typeof openRepo>>> {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-collide-'))
    temporaryDirectories.push(repoRoot)
    await mkdir(join(repoRoot, 'src'), { recursive: true })

    const areas = ['db', 'http', 'cache', 'auth', 'queue']
    for (let index = 0; index < fileCount; index += 1) {
      const area = areas[index]!
      await writeFile(
        join(repoRoot, 'src', `${area}.ts`),
        `export function loadConfig(): Record<string, string> {
  return { area: ${JSON.stringify(area)} }
}
`,
        'utf8'
      )
    }

    // A uniquely-named definition for the single-definition (collapsing) case.
    await writeFile(
      join(repoRoot, 'src', 'widget.ts'),
      `export function uniqueWidgetRenderer(): string {
  return 'widget'
}
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()
    return repo
  }

  it('does NOT collapse a colliding identifier; caps the set and flags the collision', async () => {
    const repo = await buildLoadConfigCollision(4)

    // Four same-named defs: instead of silently collapsing to one, return a capped
    // candidate set (AMBIGUOUS_IDENTIFIER_MAX_K = 3) with the collision count on top.
    const hits = await repo.search('loadConfig', { k: 10 })
    expect(hits).toHaveLength(3)
    expect(hits.every((hit) => hit.symbol === 'loadConfig')).toBe(true)
    expect(hits[0]?.ambiguousDefCount).toBe(4)
    // Distinct definitions, not three chunks of one file.
    expect(new Set(hits.map((hit) => hit.file)).size).toBe(3)
  })

  it('still collapses an identifier that resolves to a single definition', async () => {
    const repo = await buildLoadConfigCollision(1)

    const hits = await repo.search('loadConfig', { k: 10 })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.symbol).toBe('loadConfig')
    expect(hits[0]?.ambiguousDefCount).toBeUndefined()

    // A uniquely-named identifier collapses too.
    const unique = await repo.search('uniqueWidgetRenderer', { k: 10 })
    expect(unique).toHaveLength(1)
    expect(unique[0]?.ambiguousDefCount).toBeUndefined()
  })

  it('honors an explicit single_best override even on a collision', async () => {
    const repo = await buildLoadConfigCollision(4)

    // The caller forced single_best, so collapse to one and do not flag ambiguity.
    const forced = await repo.search('loadConfig', { k: 10, singleBest: true })
    expect(forced).toHaveLength(1)
    expect(forced[0]?.ambiguousDefCount).toBeUndefined()

    // Explicit single_best:false returns the full set, also without the auto hint.
    const expanded = await repo.search('loadConfig', { k: 10, singleBest: false })
    expect(expanded.length).toBeGreaterThan(3)
    expect(expanded[0]?.ambiguousDefCount).toBeUndefined()
  })
})
