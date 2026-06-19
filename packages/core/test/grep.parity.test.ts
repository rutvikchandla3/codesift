import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { openRepo, type GrepHit, type GrepOptions } from '../src/index.js'

const execFile = promisify(execFileCallback)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true })
    })
  )
})

describe('@codesift/core grep parity', () => {
  it('matches ripgrep for indexed literal searches', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-grep-parity-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src', 'auth'), { recursive: true })
    await mkdir(join(repoRoot, 'docs'), { recursive: true })

    await writeFile(
      join(repoRoot, 'src', 'auth', 'jwt.ts'),
      `export function verifyJwtToken(token: string): boolean {\n  const SessionToken = token.trim()\n  return SessionToken.startsWith('eyJ')\n}\n\nexport class TokenVerifier {\n  verify(token: string): boolean {\n    return verifyJwtToken(token)\n  }\n}\n`,
      'utf8'
    )

    await writeFile(
      join(repoRoot, 'src', 'auth', 'session.ts'),
      `export const SESSIONTOKEN_CACHE_KEY = 'session-token-cache'\nexport function readSessionToken(value: string): string {\n  return value\n}\n`,
      'utf8'
    )

    await writeFile(
      join(repoRoot, 'docs', 'README.md'),
      `TokenVerifier appears in docs too.\nverifyJwtToken is the runtime entry point.\n`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const cases: Array<{ pattern: string; options?: GrepOptions }> = [
      { pattern: 'TokenVerifier', options: { pathGlob: 'src/**' } },
      { pattern: 'verifyJwtToken', options: { wholeWord: true } },
      { pattern: 'sessiontoken', options: { ignoreCase: true, pathGlob: 'src/**' } }
    ]

    for (const testCase of cases) {
      const codesiftHits = normalizeGrepHits(await repo.grep(testCase.pattern, testCase.options))
      const ripgrepHits = await runRipgrep(repoRoot, testCase.pattern, testCase.options)

      expect(codesiftHits).toEqual(ripgrepHits)
    }
  })

  it('returns the snippet range used to build contextual grep snippets', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-grep-snippet-range-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(
      join(repoRoot, 'src', 'demo.ts'),
      [
        'const before = true',
        "const value = 'NEEDLE'",
        'const after = true'
      ].join('\n'),
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    await expect(repo.grep('NEEDLE', { pathGlob: 'src/**', contextLines: 1 })).resolves.toMatchObject([
      {
        file: 'src/demo.ts',
        range: { startLine: 2, endLine: 2 },
        snippet: "const before = true\nconst value = 'NEEDLE'\nconst after = true",
        snippetRange: { startLine: 1, endLine: 3 }
      }
    ])
  })
})

async function runRipgrep(repoRoot: string, pattern: string, options?: GrepOptions): Promise<Array<{ file: string; startLine: number; endLine: number; column: number; match: string }>> {
  const args = ['--json', '--line-number', '--color', 'never', '--fixed-strings']

  if (options?.ignoreCase) {
    args.push('--ignore-case')
  }
  if (options?.wholeWord) {
    args.push('--word-regexp')
  }
  if (options?.pathGlob) {
    args.push('--glob', options.pathGlob)
  }

  args.push(pattern, '.')

  let stdout: string
  try {
    const result = await execFile('rg', args, { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 })
    stdout = result.stdout
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string') {
      stdout = error.stdout
    } else {
      throw new Error(`ripgrep (rg) is required for parity tests: ${String(error)}`)
    }
  }

  const hits: Array<{ file: string; startLine: number; endLine: number; column: number; match: string }> = []

  for (const line of stdout.split('\n').filter(Boolean)) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }

    if (!isRipgrepMatchEvent(event)) {
      continue
    }

    const file = relative(repoRoot, resolve(repoRoot, event.data.path.text)).replace(/\\/g, '/')
    for (const submatch of event.data.submatches) {
      hits.push({
        file,
        startLine: event.data.line_number,
        endLine: event.data.line_number,
        column: submatch.start + 1,
        match: submatch.match.text
      })
    }
  }

  return sortNormalizedHits(hits)
}

function normalizeGrepHits(hits: GrepHit[]): Array<{ file: string; startLine: number; endLine: number; column: number; match: string }> {
  return sortNormalizedHits(
    hits.map((hit) => ({
      file: hit.file,
      startLine: hit.range.startLine,
      endLine: hit.range.endLine,
      column: hit.column,
      match: hit.match
    }))
  )
}

function sortNormalizedHits(hits: Array<{ file: string; startLine: number; endLine: number; column: number; match: string }>) {
  return [...hits].sort((left, right) => {
    return `${left.file}:${left.startLine}:${left.column}:${left.match}`.localeCompare(`${right.file}:${right.startLine}:${right.column}:${right.match}`)
  })
}

function isRipgrepMatchEvent(value: unknown): value is {
  type: 'match'
  data: {
    path: { text: string }
    line_number: number
    submatches: Array<{ match: { text: string }; start: number }>
  }
} {
  if (!value || typeof value !== 'object') {
    return false
  }

  const event = value as { type?: unknown; data?: unknown }
  if (event.type !== 'match' || !event.data || typeof event.data !== 'object') {
    return false
  }

  const data = event.data as { line_number?: unknown; submatches?: unknown }
  return typeof data.line_number === 'number' && Array.isArray(data.submatches)
}
