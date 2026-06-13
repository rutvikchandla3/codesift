import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const { openRepo } = await import(new URL('../packages/core/dist/index.js', import.meta.url))

const tempDirectory = await mkdtemp(join(tmpdir(), 'codesift-offline-'))

try {
  await mkdir(join(tempDirectory, 'src', 'auth'), { recursive: true })
  await writeFile(
    join(tempDirectory, 'src', 'auth', 'jwt.ts'),
    `// Validate JWT tokens and verify signatures before requests continue.
export function verifyJwtToken(token) {
  return token.startsWith('eyJ')
}
`,
    'utf8'
  )

  const repo = await openRepo(tempDirectory)
  const result = await repo.sync()
  const hits = await repo.search('validate jwt token', { k: 1 })

  if (result.indexedFiles !== 1) {
    throw new Error(`expected to index 1 file, got ${result.indexedFiles}`)
  }

  if (hits[0]?.file !== 'src/auth/jwt.ts') {
    throw new Error(`unexpected offline search result: ${JSON.stringify(hits[0] ?? null)}`)
  }

  console.log(`offline local path passed in ${repoRoot}`)
} finally {
  await rm(tempDirectory, { recursive: true, force: true })
}
