import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openRepo } from '../src/index.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true })
    })
  )
})

async function createQuickstartRepository(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-sdk-quickstart-'))
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

  return repoRoot
}

describe('docs/sdk.md quickstart', () => {
  it('runs the documented quickstart end to end against a temp repo (offline, local provider)', async () => {
    const repoRoot = await createQuickstartRepository()

    // Quickstart step 1: open the repo.
    const repo = await openRepo(repoRoot)
    expect(repo.root).toBe(repoRoot)

    // Quickstart step 2: build the index.
    const sync = await repo.sync()
    expect(sync.indexedFiles).toBeGreaterThan(0)
    expect(sync.durationMs).toBeGreaterThanOrEqual(0)

    // Quickstart step 3: concept search returns hits whose top file is the JWT source.
    const hits = await repo.search('validate jwt tokens before requests', { k: 5 })
    expect(hits.length).toBeGreaterThan(0)
    const topHit = hits[0]!
    expect(topHit.file).toBe('src/auth/jwt.ts')
    expect(topHit.range.startLine).toBeGreaterThan(0)
    expect(typeof topHit.score).toBe('number')
    expect(topHit.snippet.length).toBeGreaterThan(0)

    // The id is the documented stable shape, e.g. 'src/auth/jwt.ts:1-6@<64-hex>'.
    expect(topHit.id).toMatch(/^src\/auth\/jwt\.ts:\d+-\d+@[a-f0-9]{64}$/)

    // Quickstart step 4: read the full source behind a hit using its stable id.
    const source = await repo.readChunk(topHit.id)
    expect(source).toContain('verifyJwtToken')

    // Quickstart step 5: exact-string grep with a path glob.
    const grepHits = await repo.grep('TokenVerifier', { pathGlob: 'src/**', contextLines: 1 })
    expect(grepHits[0]?.file).toBe('src/auth/jwt.ts')

    // Quickstart step 6: jump to a definition by identifier.
    const symbols = await repo.findSymbol('verifyJwtToken')
    expect(symbols[0]?.file).toBe('src/auth/jwt.ts')
    expect(symbols[0]?.kind).toBe('function')

    // Quickstart step 7: read an explicit line range.
    const range = await repo.readRange('src/auth/jwt.ts', 1, 4, { contextLines: 1 })
    expect(range).toContain('verifyJwtToken')

    // Quickstart step 8: inspect status (local provider, indexed, fresh).
    const status = await repo.status()
    expect(status.indexed).toBe(true)
    expect(status.stale).toBe(false)
    expect(status.chunkCount).toBeGreaterThan(0)
    expect(status.provider?.id).toBeTruthy()
  })
})
