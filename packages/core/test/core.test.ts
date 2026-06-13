import Database from 'better-sqlite3'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_EMBEDDING_PROVIDER_ID,
  LOCAL_HASH_EMBEDDING_PROVIDER_ID,
  getDefaultEmbeddingProvider,
  getEmbeddingProvider,
  listEmbeddingProviders,
  openRepo,
  registerEmbeddingProvider,
  setVectorExtensionLoaderForTests,
  type EmbeddingBatchOptions,
  type EmbeddingProvider,
  type SyncProgressEvent
} from '../src/index.js'

const temporaryDirectories: string[] = []
const originalEmbeddingProvider = process.env.CODESIFT_EMBEDDING_PROVIDER

afterEach(async () => {
  setVectorExtensionLoaderForTests()

  if (originalEmbeddingProvider === undefined) {
    delete process.env.CODESIFT_EMBEDDING_PROVIDER
  } else {
    process.env.CODESIFT_EMBEDDING_PROVIDER = originalEmbeddingProvider
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
    expect(jwtHits[0]?.id).toMatch(/^src\/auth\/jwt\.ts:\d+-\d+@[a-f0-9]{64}$/)
    expect(secondSearchIds).toEqual(jwtHits.map((hit) => hit.id))
    expect(secondSyncIds).toEqual(jwtHits.map((hit) => hit.id))
    expect(chunkSource).toContain('export function verifyJwtToken')
    expect(rangeSource).toContain('// Validate JWT tokens')
    expect(rangeSource).toContain('export function verifyJwtToken')

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const fileRow = db
      .prepare<[string], { mtime: number }>('select mtime from files where path = ?')
      .get('src/auth/jwt.ts')
    db.close()

    expect(fileRow?.mtime).toBeGreaterThan(0)
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
