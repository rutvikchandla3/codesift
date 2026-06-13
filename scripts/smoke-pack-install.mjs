import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const supportedNodeMajors = new Set([20, 22])

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    ...options
  })

  if (result.error) {
    throw result.error
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status !== 0) {
    throw new Error(`command failed: ${command} ${args.join(' ')}\n${output}`)
  }

  return output
}

function assertNoSourceBuild(installLog) {
  const sourceBuildPatterns = [
    /node-gyp/i,
    /\bgyp info\b/i,
    /\bgyp ERR\b/i,
    /prebuild-install warn install/i,
    /\bCC\(/i,
    /\bCXX\(/i,
    /make:/i
  ]

  const matchedPattern = sourceBuildPatterns.find((pattern) => pattern.test(installLog))
  if (!matchedPattern) {
    return
  }

  throw new Error(`detected native source-build fallback during npm install (${matchedPattern})`)
}

async function findTarball(packDirectory, pattern, label) {
  const entries = await readdir(packDirectory)
  const match = entries.find((entry) => pattern.test(entry))

  if (!match) {
    throw new Error(`missing packed tarball for ${label} in ${packDirectory}`)
  }

  return join(packDirectory, match)
}

async function createFixtureRepo(repoDirectory) {
  await mkdir(join(repoDirectory, 'src', 'auth'), { recursive: true })
  await writeFile(
    join(repoDirectory, 'src', 'auth', 'jwt.ts'),
    `// Validate JWT tokens and verify signatures before requests continue.
export function verifyJwtToken(token) {
  return token.startsWith('eyJ')
}
`,
    'utf8'
  )
  await writeFile(join(repoDirectory, 'README.md'), '# Smoke fixture\n', 'utf8')
}

async function main() {
  const currentNodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
  if (!supportedNodeMajors.has(currentNodeMajor)) {
    console.log(`skipping pack/install smoke test on unsupported Node ${process.versions.node}; supported majors: 20, 22`)
    return
  }

  const workDirectory = await mkdtemp(join(tmpdir(), 'codesift-pack-smoke-'))
  const packDirectory = join(workDirectory, 'packs')
  const installDirectory = join(workDirectory, 'install')
  const fixtureDirectory = join(workDirectory, 'fixture')

  try {
    await mkdir(packDirectory, { recursive: true })
    await mkdir(installDirectory, { recursive: true })
    await mkdir(fixtureDirectory, { recursive: true })

    run(pnpmBin, ['--filter', '@codesift/core', 'pack', '--pack-destination', packDirectory])
    run(pnpmBin, ['--filter', '@codesift/mcp', 'pack', '--pack-destination', packDirectory])
    run(pnpmBin, ['--filter', 'codesift', 'pack', '--pack-destination', packDirectory])

    const coreTarball = await findTarball(packDirectory, /^codesift-core-.*\.tgz$/, '@codesift/core')
    const mcpTarball = await findTarball(packDirectory, /^codesift-mcp-.*\.tgz$/, '@codesift/mcp')
    const cliTarball = await findTarball(packDirectory, /^codesift-(?!core-|mcp-).*\.tgz$/, 'codesift')

    run(npmBin, ['init', '-y'], { cwd: installDirectory })
    const installLog = run(
      npmBin,
      ['install', '--foreground-scripts', '--loglevel', 'verbose', coreTarball, mcpTarball, cliTarball],
      { cwd: installDirectory }
    )

    assertNoSourceBuild(installLog)
    await writeFile(join(workDirectory, 'install.log'), installLog, 'utf8')

    await createFixtureRepo(fixtureDirectory)

    run(npxBin, ['--no-install', 'codesift', 'index', fixtureDirectory], { cwd: installDirectory })
    const searchOutput = run(
      npxBin,
      ['--no-install', 'codesift', 'search', 'validate jwt token', '--repo', fixtureDirectory, '--compact', '-k', '1'],
      { cwd: installDirectory }
    )

    if (!searchOutput.includes('src/auth/jwt.ts')) {
      throw new Error(`smoke search did not return the indexed file\n${searchOutput}`)
    }

    const packageJson = JSON.parse(await readFile(join(installDirectory, 'package.json'), 'utf8'))
    if (!packageJson.dependencies?.codesift) {
      throw new Error('smoke install did not persist the local codesift package dependency')
    }

    console.log('pack/install smoke test passed')
  } finally {
    if (process.env.CODESIFT_KEEP_SMOKE_TMP !== '1') {
      await rm(workDirectory, { recursive: true, force: true })
    }
  }
}

await main()
