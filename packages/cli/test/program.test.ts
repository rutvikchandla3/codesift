import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { getDefaultEmbeddingProvider, registerEmbeddingProvider } from '@codesift/core'

import { formatCompactGrepHits, formatCompactHits, formatGrepHits, formatHits, formatStatus, formatSymbols, getCliDescription, runCli, type CliIo } from '../src/program.js'

const temporaryDirectories: string[] = []
const originalEmbeddingProvider = process.env.CODESIFT_EMBEDDING_PROVIDER

afterEach(async () => {
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

describe('codesift CLI formatters', () => {
  it('renders placeholder status output', () => {
    expect(
      formatStatus({
        root: '/tmp/codesift',
        indexPath: '/tmp/codesift/.codesift/index.db',
        indexed: false,
        stale: false,
        chunkCount: 0,
        symbolCount: 0,
        indexGeneration: 0,
        provider: null,
        compatibility: { ok: true },
        vectorSearch: {
          available: true,
          state: 'lazy'
        }
      })
    ).toContain('provider: unconfigured')
  })

  it('renders empty states', () => {
    expect(formatHits([])).toContain('No hits found')
    expect(formatCompactHits([])).toContain('No hits found')
    expect(formatSymbols([])).toContain('No symbol matches found')
    expect(formatGrepHits([])).toContain('No matches found')
    expect(formatCompactGrepHits([])).toContain('No matches found')
  })
})

describe('codesift CLI capability labels', () => {
  it('uses honest lexical wording by default and keeps published docs lexical', async () => {
    expect(getDefaultEmbeddingProvider().isLearned).toBeFalsy()
    expect(getCliDescription().toLowerCase()).not.toContain('semantic')
    expect(getCliDescription().toLowerCase()).not.toContain('hybrid')

    const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8')
    const workspacePackage = await readFile(join(process.cwd(), 'package.json'), 'utf8')
    const cliPackage = await readFile(join(process.cwd(), 'packages/cli/package.json'), 'utf8')

    expect(readme.toLowerCase()).not.toContain('semantic')
    expect(readme.toLowerCase()).not.toContain('hybrid')
    expect(workspacePackage.toLowerCase()).not.toContain('hybrid')
    expect(cliPackage.toLowerCase()).not.toContain('hybrid')
  })

  it('switches CLI wording when a learned provider is active', () => {
    const providerId = `cli-learned-provider-${Date.now()}`

    registerEmbeddingProvider({
      id: providerId,
      dims: 8,
      maxTokens: 8192,
      modelVersion: `${providerId}-model`,
      isLearned: true,
      async embedBatch(texts) {
        return texts.map(() => new Float32Array(8))
      }
    })
    process.env.CODESIFT_EMBEDDING_PROVIDER = providerId

    expect(getCliDescription().toLowerCase()).toContain('semantic')
    expect(getCliDescription().toLowerCase()).toContain('hybrid')
  })
})

describe('codesift CLI end-to-end', () => {
  it('indexes, searches, and resolves symbols with repo-aware options', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-cli-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src', 'auth'), { recursive: true })
    await writeFile(
      join(repoRoot, 'src', 'auth', 'jwt.ts'),
      `// Verify JWT token values before requests continue.
export function verifyJwtToken(token: string): boolean {
  return token.startsWith('eyJ')
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'README.md'),
      '# Demo CLI repo\n\nJWT validation lives in the auth module.\n',
      'utf8'
    )

    const messages: string[] = []
    const io: CliIo = {
      stdout(message) {
        messages.push(message)
      },
      stderr(message) {
        messages.push(`ERR:${message}`)
      }
    }

    await runCli(['node', 'codesift', 'index', repoRoot], io)
    await runCli(
      [
        'node',
        'codesift',
        'search',
        'verify jwt token',
        '--repo',
        repoRoot,
        '--lang',
        'typescript',
        '--kind',
        'function',
        '--compact',
        '-k',
        '1'
      ],
      io
    )
    await runCli(
      [
        'node',
        'codesift',
        'sym',
        'verifyJwtToken',
        '--repo',
        repoRoot,
        '--path',
        'src/**',
        '--kind',
        'function'
      ],
      io
    )
    await runCli(['node', 'codesift', 'grep', '-e', 'token.startsWith', '--repo', repoRoot, '--path', 'src/**', '--compact'], io)
    await runCli(['node', 'codesift', 'search', 'verify jwt token', '--repo', repoRoot, '--json', '-k', '1'], io)

    expect(messages[0]).toContain('Indexed 2 files')
    expect(messages[0]).toContain('0 symlink skips')
    expect(messages[1]).toContain('src/auth/jwt.ts')
    expect(messages[1]).toContain('verifyJwtToken')
    expect(messages[2]).toContain('function verifyJwtToken')
    expect(messages[3]).toContain('src/auth/jwt.ts:3')
    expect(messages[3]).toContain('token.startsWith')

    const jsonHits = JSON.parse(messages[4] ?? '[]') as Array<{ file: string }>
    expect(jsonHits[0]?.file).toBe('src/auth/jwt.ts')
  })
})
