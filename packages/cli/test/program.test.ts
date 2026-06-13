import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { formatHits, formatStatus, formatSymbols, runCli, type CliIo } from '../src/program.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
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
        provider: null
      })
    ).toContain('provider: unconfigured')
  })

  it('renders empty states', () => {
    expect(formatHits([])).toContain('No hits found')
    expect(formatSymbols([])).toContain('No symbol matches found')
  })
})

describe('codesift CLI end-to-end', () => {
  it('indexes, searches, and resolves symbols with repo-aware options', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-cli-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src', 'auth'), { recursive: true })
    await writeFile(
      join(repoRoot, 'src', 'auth', 'jwt.ts'),
      `export function verifyJwtToken(token: string): boolean {
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
      ['node', 'codesift', 'search', 'validate jwt token', '--repo', repoRoot, '--lang', 'typescript', '-k', '1'],
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
    await runCli(
      ['node', 'codesift', 'search', 'validate jwt token', '--repo', repoRoot, '--json', '-k', '1'],
      io
    )

    expect(messages[0]).toContain('Indexed 2 files')
    expect(messages[1]).toContain('src/auth/jwt.ts')
    expect(messages[2]).toContain('function verifyJwtToken')

    const jsonHits = JSON.parse(messages[3] ?? '[]') as Array<{ file: string }>
    expect(jsonHits[0]?.file).toBe('src/auth/jwt.ts')
  })
})
