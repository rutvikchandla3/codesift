import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  IndexCompatibilityError,
  openRepo,
  registerEmbeddingProvider,
  setVectorExtensionLoaderForTests,
  type EmbeddingProvider
} from '../src/index.js'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []
const originalEmbeddingProvider = process.env.CODESIFT_EMBEDDING_PROVIDER

afterEach(async () => {
  vi.restoreAllMocks()
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
    join(repoRoot, 'README.md'),
    `# Demo repo

TokenVerifier is the main entry point described in docs.
This project validates JWT tokens before protected requests continue.
`,
    'utf8'
  )

  return repoRoot
}

function activateLearnedProvider(providerId: string): void {
  const provider: EmbeddingProvider = {
    id: providerId,
    dims: 8,
    maxTokens: 8192,
    maxBatch: 8,
    maxBatchTokens: 4096,
    modelVersion: `${providerId}-model`,
    isLearned: true,
    async embedBatch(texts) {
      return texts.map((text) => {
        const vector = new Float32Array(8)
        vector[0] = text.length || 1
        return vector
      })
    }
  }

  registerEmbeddingProvider(provider)
  process.env.CODESIFT_EMBEDDING_PROVIDER = providerId
}

describe('repo resilience seams', () => {
  it('self-gitigores .codesift on first open/sync', async () => {
    const repoRoot = await createDemoRepository('codesift-gitignore-')
    await execFileAsync('git', ['init', '-q'], { cwd: repoRoot })

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const gitignore = await readFile(join(repoRoot, '.codesift', '.gitignore'), 'utf8')
    const { stdout } = await execFileAsync('git', ['status', '--short', '--', '.codesift'], { cwd: repoRoot })

    expect(gitignore.trim()).toBe('*')
    expect(stdout.trim()).toBe('')
  })

  it('keeps lexical and symbol search working when sqlite-vec is unavailable', async () => {
    const repoRoot = await createDemoRepository('codesift-vector-degraded-')
    activateLearnedProvider(`learned-provider-${Date.now()}`)

    const loadSpy = vi.fn(() => {
      throw new Error('missing sqlite-vec prebuild')
    })
    setVectorExtensionLoaderForTests(loadSpy)

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const lexicalHits = await repo.search('TokenVerifier', { k: 2 })
    const symbolHits = await repo.findSymbol('verifyJwtToken')

    expect(lexicalHits[0]?.file).toBe('src/auth/jwt.ts')
    expect(symbolHits[0]?.file).toBe('src/auth/jwt.ts')
    expect(loadSpy).not.toHaveBeenCalled()

    const learnedHits = await repo.search('validate JWT tokens before requests continue', { k: 3 })
    const status = await repo.status()

    expect(learnedHits[0]?.file).toBe('src/auth/jwt.ts')
    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(status.vectorSearch.state).toBe('unavailable')
    expect(status.vectorSearch.reason).toBe('native-dependency-unavailable')
    expect(status.vectorSearch.message).toBe('vector search unavailable (native dep), lexical/symbol still works')
    expect(status.vectorSearch.detail).toContain('missing sqlite-vec prebuild')
  })

  it('refuses queries with a guided rebuild message on provider mismatch', async () => {
    const repoRoot = await createDemoRepository('codesift-provider-mismatch-')
    const repo = await openRepo(repoRoot)
    await repo.sync()

    activateLearnedProvider(`mismatch-provider-${Date.now()}`)

    const incompatibleStatus = await repo.status()
    expect(incompatibleStatus.compatibility.ok).toBe(false)
    expect(incompatibleStatus.compatibility.code).toBe('provider_mismatch')
    expect(incompatibleStatus.compatibility.message).toContain('codesift index --rebuild')

    await expect(repo.search('validate JWT tokens', { k: 1 })).rejects.toBeInstanceOf(IndexCompatibilityError)
  })
})
