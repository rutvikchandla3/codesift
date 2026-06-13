import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { openRepo, setVectorExtensionLoaderForTests } from '../src/index.js'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  setVectorExtensionLoaderForTests()

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

    const semanticHits = await repo.search('validate JWT tokens before requests continue', { k: 3 })
    const status = await repo.status()

    expect(semanticHits[0]?.file).toBe('src/auth/jwt.ts')
    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(status.vectorSearch.state).toBe('unavailable')
    expect(status.vectorSearch.reason).toBe('native-dependency-unavailable')
    expect(status.vectorSearch.message).toBe('vector search unavailable (native dep), lexical/symbol still works')
    expect(status.vectorSearch.detail).toContain('missing sqlite-vec prebuild')
  })
})
