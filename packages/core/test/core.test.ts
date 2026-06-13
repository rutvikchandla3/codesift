import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_EMBEDDING_PROVIDER_ID,
  getEmbeddingProvider,
  listEmbeddingProviders,
  openRepo,
  registerEmbeddingProvider
} from '../src/index.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true })
    })
  )
})

describe('@codesift/core', () => {
  it('indexes a repo and returns sensible semantic matches', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-core-'))
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

    const repo = await openRepo(repoRoot)
    const result = await repo.sync()
    const status = await repo.status()
    const jwtHits = await repo.search('where do we validate JWT tokens', { k: 3 })
    const retryHits = await repo.search('retry backoff for HTTP requests', { k: 3 })
    const symbols = await repo.findSymbol('verifyJwtToken')

    expect(result.indexedFiles).toBe(3)
    expect(result.skippedFiles).toBe(0)
    expect(status.indexed).toBe(true)
    expect(status.chunkCount).toBeGreaterThan(0)
    expect(status.symbolCount).toBeGreaterThan(0)
    expect(status.provider?.id).toBe(DEFAULT_EMBEDDING_PROVIDER_ID)

    expect(jwtHits[0]?.file).toBe('src/auth/jwt.ts')
    expect(retryHits.some((hit) => hit.file === 'src/network/retry.ts')).toBe(true)
    expect(symbols[0]?.file).toBe('src/auth/jwt.ts')
    expect(symbols[0]?.kind).toBe('function')
  })

  it('registers embedding providers', async () => {
    const providerId = `test-provider-${Date.now()}`

    registerEmbeddingProvider({
      id: providerId,
      dims: 768,
      maxTokens: 8192,
      async embedBatch(texts) {
        return texts.map(() => new Float32Array(768))
      }
    })

    expect(getEmbeddingProvider(providerId)?.id).toBe(providerId)
    expect(listEmbeddingProviders().some((provider) => provider.id === providerId)).toBe(true)
  })
})
