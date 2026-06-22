import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openRepo, registerEmbeddingProvider, type EdgeResult, type GrepHit, type ImpactResult, type Repo, type RepoStatus, type SearchHit, type SymbolDefinition } from '@codesift/core'

import {
  DEFAULT_MCP_FIND_SYMBOL_MAX_TOKENS,
  DEFAULT_MCP_INDEX_STATUS_MAX_TOKENS,
  DEFAULT_MCP_RELATION_MAX_TOKENS,
  DEFAULT_MCP_SEARCH_MAX_TOKENS,
  DEFAULT_MCP_READ_CHUNK_MAX_TOKENS,
  DEFAULT_SEARCH_K,
  MIN_MCP_READ_CHUNK_MAX_TOKENS,
  MCP_SERVER_INSTRUCTIONS,
  NOT_INDEXED_SENTINEL,
  createHttpServer,
  createRouter,
  createStdioServer,
  callMcpTool,
  formatMcpCallers,
  formatMcpChangesetContext,
  formatMcpGrepHits,
  formatMcpImpact,
  formatMcpImplementers,
  formatMcpImporters,
  formatMcpIndexStatus,
  formatMcpReadChunk,
  formatMcpReferences,
  formatMcpSearchHits,
  formatMcpSymbols,
  getToolDefinitions
} from '../src/index.js'

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

async function copyFixtureRepository(fixtureName: string, prefix: string): Promise<string> {
  const parentDirectory = await mkdtemp(join(tmpdir(), prefix))
  const repoRoot = join(parentDirectory, 'repo')
  temporaryDirectories.push(parentDirectory)
  await cp(join(process.cwd(), 'packages', 'eval', 'fixtures', fixtureName), repoRoot, { recursive: true })
  return repoRoot
}

describe('@codesift/mcp server', () => {
  it('exposes the planned tool surface with routing schemas', () => {
    expect(getToolDefinitions().map((tool) => tool.name)).toEqual([
      'search_code',
      'find_symbol',
      'find_callers',
      'find_refs',
      'find_importers',
      'who_implements',
      'impact',
      'changeset_context',
      'grep_code',
      'read_chunk',
      'index_status'
    ])
    expect(getToolDefinitions().find((tool) => tool.name === 'grep_code')?.inputSchema.required).toEqual(['pattern'])
    expect(getToolDefinitions().find((tool) => tool.name === 'grep_code')?.inputSchema.properties).toMatchObject({
      max_tokens: { type: 'integer', minimum: 1, maximum: 4000, default: 700 }
    })
    expect(getToolDefinitions().find((tool) => tool.name === 'find_symbol')?.inputSchema.properties).toMatchObject({
      with_callers: { type: 'boolean' },
      detail: { type: 'string', enum: ['sig', 'body'] },
      max_tokens: { type: 'integer', minimum: 1, maximum: 4000, default: DEFAULT_MCP_FIND_SYMBOL_MAX_TOKENS }
    })
    expect(getToolDefinitions().find((tool) => tool.name === 'find_callers')?.inputSchema.required).toEqual(['name'])
    expect(getToolDefinitions().find((tool) => tool.name === 'find_callers')?.inputSchema.properties).toMatchObject({
      max_tokens: { type: 'integer', minimum: 1, maximum: 4000, default: DEFAULT_MCP_RELATION_MAX_TOKENS }
    })
    expect(getToolDefinitions().find((tool) => tool.name === 'find_refs')?.inputSchema.required).toEqual(['name'])
    expect(getToolDefinitions().find((tool) => tool.name === 'find_importers')?.inputSchema.required).toEqual(['file'])
    expect(getToolDefinitions().find((tool) => tool.name === 'who_implements')?.inputSchema.required).toEqual(['name'])
    expect(getToolDefinitions().find((tool) => tool.name === 'impact')?.inputSchema.required).toEqual(['name'])
    expect(getToolDefinitions().find((tool) => tool.name === 'read_chunk')?.inputSchema.properties).toMatchObject({
      max_tokens: { type: 'integer', minimum: MIN_MCP_READ_CHUNK_MAX_TOKENS, maximum: 4000, default: DEFAULT_MCP_READ_CHUNK_MAX_TOKENS }
    })
    expect(getToolDefinitions().find((tool) => tool.name === 'search_code')?.inputSchema.properties).toMatchObject({
      max_tokens: { type: 'integer', minimum: 1, maximum: 4000, default: DEFAULT_MCP_SEARCH_MAX_TOKENS },
      context: { type: 'string', enum: ['auto', 'min', 'sig', 'body', 'graph'] },
      with_usages: { type: 'boolean' },
      with_relations: { type: 'boolean' }
    })
    expect(getToolDefinitions().find((tool) => tool.name === 'index_status')?.inputSchema.properties).toMatchObject({
      max_tokens: { type: 'integer', minimum: 1, maximum: 1000, default: DEFAULT_MCP_INDEX_STATUS_MAX_TOKENS }
    })
    expect(getToolDefinitions().find((tool) => tool.name === 'changeset_context')?.inputSchema.properties).toMatchObject({
      max_files: { type: 'integer', minimum: 1, maximum: 40, default: 40 },
      max_edges_per_file: { type: 'integer', minimum: 1, maximum: 25, default: 12 }
    })
    expect(MCP_SERVER_INSTRUCTIONS).toContain('breakage/transitive callers->impact')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('approx:name-only')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('literals/regex/errors/env/operators->grep_code')
  })

  it('asserts single-call sufficiency in instructions and tool descriptions', () => {
    const lowerInstructions = MCP_SERVER_INSTRUCTIONS.toLowerCase()
    expect(lowerInstructions).toContain('top search_code body inline')
    expect(lowerInstructions).toContain('read_chunk only for non-top/wider context')

    const tools = getToolDefinitions()
    const searchDescription = tools.find((tool) => tool.name === 'search_code')?.description ?? ''
    expect(searchDescription.toLowerCase()).toContain('top body inline')

    const findDescription = tools.find((tool) => tool.name === 'find_symbol')?.description ?? ''
    expect(findDescription.toLowerCase()).toContain('top body inline')
    expect(findDescription.toLowerCase()).toContain('relations')

    const callersDescription = tools.find((tool) => tool.name === 'find_callers')?.description ?? ''
    expect(callersDescription).toContain('approx:name-only')

    const refsDescription = tools.find((tool) => tool.name === 'find_refs')?.description ?? ''
    expect(refsDescription).toContain('approx:name-only')

    const implementersDescription = tools.find((tool) => tool.name === 'who_implements')?.description ?? ''
    expect(implementersDescription).toContain('approx:name-only')

    const impactDescription = tools.find((tool) => tool.name === 'impact')?.description ?? ''
    expect(impactDescription).toContain('approx:name-only')

    const readDescription = tools.find((tool) => tool.name === 'read_chunk')?.description ?? ''
    expect(readDescription.toLowerCase()).toContain('not needed for top search_code/find_symbol hits')
    expect(readDescription.toLowerCase()).toContain('returned inline')

    // The routing guidance for find_symbol/graph/grep_code is preserved.
    expect(MCP_SERVER_INSTRUCTIONS).toContain('identifiers->find_symbol')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('callers/uses->find_callers/find_refs')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('importers->find_importers')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('implements/extends->who_implements')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('breakage/transitive callers->impact')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('concepts/fuzzy names->search_code')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('Broad search k=5-8')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('Health is inline')
  })

  it('keeps control-plane metadata under the MCP budget', () => {
    const tools = getToolDefinitions()
    const payload = JSON.stringify({ instructions: MCP_SERVER_INSTRUCTIONS, tools })
    const toolDescriptionCeilings = new Map([
      ['search_code', 190],
      ['find_symbol', 130],
      ['find_callers', 120],
      ['find_refs', 120],
      ['find_importers', 90],
      ['who_implements', 125],
      ['impact', 110],
      ['changeset_context', 90],
      ['grep_code', 120],
      ['read_chunk', 120],
      ['index_status', 90]
    ])

    expect(payload.length).toBeLessThanOrEqual(7000)
    expect(Math.ceil(payload.length / 4)).toBeLessThanOrEqual(1750)
    expect(MCP_SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(560)
    for (const tool of tools) {
      expect(tool.description.length).toBeLessThanOrEqual(toolDescriptionCeilings.get(tool.name) ?? 120)
    }
  })

  it('uses honest lexical wording by default and semantic wording with a learned provider', () => {
    expect(getToolDefinitions()[0]?.description.toLowerCase()).not.toContain('semantic')
    expect(getToolDefinitions()[0]?.description.toLowerCase()).not.toContain('hybrid')

    const providerId = `mcp-learned-provider-${Date.now()}`
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

    expect(getToolDefinitions()[0]?.description.toLowerCase()).toContain('semantic')
    expect(getToolDefinitions()[0]?.description.toLowerCase()).toContain('hybrid')
  })

  it('returns indexing status instead of empty search output during first sync', async () => {
    const repo = {
      async status() {
        return makeStatus({
          indexExists: true,
          indexed: false,
          sync: { state: 'running', completedChunks: 2, totalChunks: 7 },
          chunkCount: 0,
          symbolCount: 0,
          indexGeneration: 0,
          provider: null
        })
      },
      async search() {
        throw new Error('search should not run while the first index is still building')
      }
    } as unknown as Repo

    await expect(callMcpTool(repo, 'search_code', { query: 'demoValue' })).resolves.toBe('indexing; sync=running chunks=2/7; retry shortly or use index_status')
  })

  it('routes tool calls through the core repo contract', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-mcp-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(
      join(repoRoot, 'src', 'demo.ts'),
      `export function demoValue(): string {\n  return 'demo'\n}\n`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()
    const router = createRouter(repo)
    const hits = await router.searchCode({ query: 'demoValue', k: 1, context: 'body', with_usages: true })

    const grepHits = await router.grepCode({ pattern: "return 'demo'", path_glob: 'src/**' })

    expect(hits[0]?.file).toBe('src/demo.ts')
    expect(hits[0]?.body).toContain("return 'demo'")

    const symbols = await router.findSymbol({ name: 'demoValue' })
    expect(symbols).toHaveLength(1)
    // find_symbol resolves the identifier in one call: the top match carries a
    // paste-ready body, rendered as a line-numbered block.
    expect(symbols[0]?.body).toContain("return 'demo'")
    const renderedSymbols = formatMcpSymbols(symbols)
    expect(renderedSymbols).toContain('#1 function demoValue src/demo.ts:')
    expect(renderedSymbols).toContain("| export function demoValue")
    expect(renderedSymbols).toContain("return 'demo'")

    // with_body:false yields a compact name→location row (no body block).
    const compactSymbols = await router.findSymbol({ name: 'demoValue', with_body: false })
    expect(compactSymbols[0]?.body).toBeUndefined()
    expect(formatMcpSymbols(compactSymbols)).not.toContain("return 'demo'")

    const signatureSymbols = await router.findSymbol({ name: 'demoValue', detail: 'sig' })
    expect(signatureSymbols[0]?.body).toBeUndefined()
    const signatureOutput = await callMcpTool(repo, 'find_symbol', { name: 'demoValue', detail: 'sig' })
    expect(signatureOutput).toContain('#1 function demoValue src/demo.ts:')
    expect(signatureOutput).not.toContain("return 'demo'")

    const partialOutput = await callMcpTool(repo, 'find_symbol', { name: 'demo', max_tokens: 80 })
    expect(partialOutput).toContain('exact_miss; partial_matches=1')
    expect(partialOutput).toContain('#1 partial function demoValue src/demo.ts:')

    expect(grepHits[0]?.file).toBe('src/demo.ts')
    expect(await router.readChunk({ id: hits[0]!.id })).toContain("return 'demo'")
    expect((await router.indexStatus()).indexed).toBe(true)
    expect(DEFAULT_SEARCH_K).toBe(8)
  })

  it('routes graph tool calls through the core repo contract', async () => {
    const repoRoot = await copyFixtureRepository('usages-ts', 'codesift-mcp-graph-router-')
    const repo = await openRepo(repoRoot)

    await repo.sync()
    const router = createRouter(repo)
    const callers = await router.findCallers({ name: 'parseToken' })
    const refs = await router.findReferences({ name: 'parseToken' })
    const importers = await router.findImporters({ file: 'src/token.ts' })

    expect(callers.map((result) => `${result.file}:${result.line}:${result.srcSymbol}:${result.edgeKind}`)).toEqual([
      'src/api.ts:4:readSubject:call',
      'src/worker.ts:4:enqueueToken:call'
    ])
    expect(refs.map((result) => `${result.file}:${result.line}:${result.srcSymbol}:${result.edgeKind}`)).toEqual([
      'src/api.ts:4:readSubject:call',
      'src/worker.ts:4:enqueueToken:call'
    ])
    expect(importers.map((result) => `${result.file}:${result.line}:${result.edgeKind}`)).toEqual([
      'src/api.ts:1:import',
      'src/worker.ts:1:import'
    ])
  })

  it('returns one-call find_symbol relations and bounded impact through the MCP contract', async () => {
    const repoRoot = await copyFixtureRepository('usages-ts', 'codesift-mcp-relations-impact-')
    await writeFile(
      join(repoRoot, 'src', 'service.ts'),
      `import { readSubject } from './api'

export function handleToken(header: string): string {
  return readSubject(header)
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'app.ts'),
      `import { handleToken } from './service'

export function runApp(header: string): string {
  return handleToken(header)
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'cli.ts'),
      `import { runApp } from './app'

export function main(header: string): string {
  return runApp(header)
}
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()
    const router = createRouter(repo)

    const symbols = await router.findSymbol({ name: 'parseToken', with_callers: true })
    expect(symbols[0]?.body).toContain('export function parseToken')
    expect(symbols[0]?.relations?.sites.map((site) => `${site.file}:${site.line}:${site.srcSymbol}:${site.edgeKind}`)).toEqual([
      'src/api.ts:4:readSubject:call',
      'src/worker.ts:4:enqueueToken:call'
    ])

    const impact = await router.impact({ name: 'parseToken', depth: 2 })
    expect(impact.nodes.map((node) => `${node.depth}:${node.file}:${node.line}:${node.srcSymbol}:${node.edgeKind}`)).toEqual([
      '0:src/api.ts:4:readSubject:call',
      '0:src/worker.ts:4:enqueueToken:call',
      '1:src/service.ts:4:handleToken:call',
      '2:src/app.ts:4:runApp:call'
    ])
    expect(impact.depthCapped).toBe(true)
  })

  it('routes implementer lookups through the core repo contract', async () => {
    const repoRoot = await copyFixtureRepository('heritage-ts', 'codesift-mcp-heritage-router-')
    const repo = await openRepo(repoRoot)

    await repo.sync()
    const router = createRouter(repo)
    const implementers = await router.findImplementers({ name: 'AuthStrategy' })

    expect(implementers.map((result) => `${result.file}:${result.line}:${result.srcSymbol}:${result.edgeKind}`)).toEqual([
      'src/impl.ts:3:JwtVerifier:implements',
      'src/impl.ts:9:StrictStrategy:extends'
    ])
  })

  it('formats graph MCP tools with honest resolution labels and definition-path disambiguation', async () => {
    const usagesRepoRoot = await copyFixtureRepository('usages-ts', 'codesift-mcp-graph-tools-')
    const usagesRepo = await openRepo(usagesRepoRoot)
    await usagesRepo.sync()

    const callersOutput = await callMcpTool(usagesRepo, 'find_callers', { name: 'parseToken', max_tokens: 80 })
    expect(callersOutput).toContain('src/api.ts:4 readSubject call import-resolved |')
    expect(callersOutput).toContain('src/worker.ts:4 enqueueToken call import-resolved |')

    const importersOutput = await callMcpTool(usagesRepo, 'find_importers', { file: 'src/token.ts', max_tokens: 80 })
    expect(importersOutput).toContain("src/api.ts:1 top-level import import-resolved | import { parseToken } from './token'")
    expect(importersOutput).toContain("src/worker.ts:1 top-level import import-resolved | import { parseToken } from './token'")

    const collisionRepoRoot = await copyFixtureRepository('collision-ts', 'codesift-mcp-graph-collision-')
    const collisionRepo = await openRepo(collisionRepoRoot)
    await collisionRepo.sync()

    const refsOutput = await callMcpTool(collisionRepo, 'find_refs', {
      name: 'validate',
      kind: 'function',
      path_glob: 'src/schema/**',
      max_tokens: 80
    })
    expect(refsOutput).toContain('src/api/handler.ts:6 handleRequest call import-resolved |')
    expect(refsOutput).not.toContain('src/auth/token.ts')
    expect(refsOutput).not.toContain('src/forms/checkout.ts')

    const ambiguousRefsOutput = await callMcpTool(collisionRepo, 'find_refs', {
      name: 'validate',
      max_tokens: 120
    })
    expect(ambiguousRefsOutput).toContain('ambiguous: 3 defs')

    const heritageRepoRoot = await copyFixtureRepository('heritage-ts', 'codesift-mcp-graph-heritage-')
    const heritageRepo = await openRepo(heritageRepoRoot)
    await heritageRepo.sync()

    const implementersOutput = await callMcpTool(heritageRepo, 'who_implements', {
      name: 'AuthStrategy',
      max_tokens: 80
    })
    expect(implementersOutput).toContain('src/impl.ts:3 JwtVerifier implements import-resolved | export class JwtVerifier extends BaseVerifier implements AuthStrategy {')
    expect(implementersOutput).toContain('src/impl.ts:9 StrictStrategy extends import-resolved | export interface StrictStrategy extends AuthStrategy {}')
  })

  it('emits a name-only lead line from real capped graph lookups', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-mcp-name-only-cap-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'auth'), { recursive: true })
    await writeFile(
      join(repoRoot, 'auth', 'token.go'),
      `package auth

type TokenVerifier struct{}

func (v TokenVerifier) VerifyToken(token string) bool {
  return token != ""
}
`,
      'utf8'
    )
    await Promise.all(Array.from({ length: 30 }, async (_, index) => {
      await writeFile(
        join(repoRoot, 'auth', `caller${index}.go`),
        `package auth

func ValidateBearer${index}(token string) bool {
  verifier := TokenVerifier{}
  return verifier.VerifyToken(token)
}
`,
        'utf8'
      )
    }))

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const output = await callMcpTool(repo, 'find_callers', {
      name: 'VerifyToken',
      kind: 'method',
      max_tokens: 600
    })
    expect(output).toContain('name_only_unscoped=30; narrow with path_glob/kind')
    expect(output).toContain('approx:name-only')
  })

  it('formats one-call find_symbol relations and bounded impact output', async () => {
    const repoRoot = await copyFixtureRepository('usages-ts', 'codesift-mcp-relations-output-')
    await writeFile(
      join(repoRoot, 'src', 'service.ts'),
      `import { readSubject } from './api'

export function handleToken(header: string): string {
  return readSubject(header)
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'app.ts'),
      `import { handleToken } from './service'

export function runApp(header: string): string {
  return handleToken(header)
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'cli.ts'),
      `import { runApp } from './app'

export function main(header: string): string {
  return runApp(header)
}
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const symbolOutput = await callMcpTool(repo, 'find_symbol', { name: 'parseToken', with_callers: true, max_tokens: 120 })
    expect(symbolOutput).toContain('#1 function parseToken src/token.ts:6-9')
    expect(symbolOutput).toContain('relations:')
    expect(symbolOutput).toContain('- call src/api.ts:4 readSubject import-resolved')
    expect(symbolOutput).toContain('- call src/worker.ts:4 enqueueToken import-resolved')
    expect(symbolOutput).toContain('- neighbor interface ParsedToken 1-4')

    const impactOutput = await callMcpTool(repo, 'impact', { name: 'parseToken', depth: 2, max_tokens: 180 })
    expect(impactOutput).toContain('src/api.ts:4 readSubject d0 call import-resolved |')
    expect(impactOutput).toContain('src/service.ts:4 handleToken d1 call import-resolved |')
    expect(impactOutput).toContain('src/app.ts:4 runApp d2 call import-resolved |')
    expect(impactOutput).toContain('depth_capped=2')
  })

  it('budgets find_symbol output through the MCP call surface', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-mcp-symbol-budget-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await Promise.all(
      Array.from({ length: 6 }, async (_, index) => {
        await writeFile(
          join(repoRoot, 'src', `shared${index}.ts`),
          `export function sharedName(): string {\n  const value = 'shared-${index}-${'x'.repeat(40)}'\n  return value\n}\n`,
          'utf8'
        )
      })
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()
    const output = await callMcpTool(repo, 'find_symbol', { name: 'sharedName', max_tokens: 35 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(35)
    expect(output).toContain('#1 function sharedName')
    expect(output).toContain('symbols_omitted=')
  })

  it('budgets search_code output through the MCP call surface, including bundled usages', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-mcp-search-budget-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(
      join(repoRoot, 'src', 'demo.ts'),
      [
        'export function demoValue(input: string): string {',
        `  const message = \`${'x'.repeat(160)}:${'y'.repeat(160)}\``,
        '  return `${input}:${message}`',
        '}',
        ''
      ].join('\n'),
      'utf8'
    )
    await Promise.all(([
      ['app.ts', "import { demoValue } from './demo'\nexport const appResult = demoValue('app' + '-'.repeat(80))\n"],
      ['worker.ts', "import { demoValue } from './demo'\nexport const workerResult = demoValue('worker' + '-'.repeat(80))\n"],
      ['job.ts', "import { demoValue } from './demo'\nexport const jobResult = demoValue('job' + '-'.repeat(80))\n"],
      ['cli.ts', "import { demoValue } from './demo'\nexport const cliResult = demoValue('cli' + '-'.repeat(80))\n"]
    ] satisfies Array<[string, string]>).map(async ([file, content]) => {
      await writeFile(join(repoRoot, 'src', file), content, 'utf8')
    }))

    const repo = await openRepo(repoRoot)
    await repo.sync()
    const output = await callMcpTool(repo, 'search_code', {
      query: 'demoValue',
      k: 3,
      context: 'body',
      with_usages: true,
      max_tokens: 45
    })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(45)
    expect(output).toContain('src/demo.ts')
    expect(output).toContain('usages_omitted=')
  })

  it('creates server handles', async () => {
    const repo = await openRepo(process.cwd())
    const stdio = createStdioServer(repo)
    const http = createHttpServer(repo, { port: 7345 })

    expect(stdio.transport).toBe('stdio')
    expect(http.transport).toBe('http')
  })

  it('serves real stdio JSON-RPC without stray stdout', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-mcp-stdio-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(
      join(repoRoot, 'src', 'demo.ts'),
      `export function demoValue(): string {\n  return 'demo'\n}\n`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const daemonSocket = process.platform === 'win32'
      ? String.raw`\\.\pipe\codesift-mcp-test-${Date.now()}`
      : join(repoRoot, '.codesift', 'daemon.sock')
    const child = spawn(process.execPath, [join(process.cwd(), 'packages/cli/dist/bin.js'), 'mcp', repoRoot], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODESIFT_DAEMON_SOCKET: daemonSocket,
        CODESIFT_DAEMON_IDLE_MS: '1000'
      }
    })
    const messages: unknown[] = []
    const stderrChunks: string[] = []
    let stdoutBuffer = ''
    let parseError: Error | undefined

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      let newlineIndex = stdoutBuffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim()
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
        if (line) {
          try {
            messages.push(JSON.parse(line))
          } catch (error) {
            parseError = error instanceof Error ? error : new Error(String(error))
          }
        }
        newlineIndex = stdoutBuffer.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk))

    try {
      sendJsonRpc(child, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'codesift-vitest', version: '0.0.0' }
        }
      })
      const initializeResult = await waitForJsonRpcMessage(messages, (message) => rpcId(message) === 1, () => parseError, child)
      expect(JSON.stringify(initializeResult)).toContain('codesift')

      sendJsonRpc(child, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
      sendJsonRpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      const toolsResult = await waitForJsonRpcMessage(messages, (message) => rpcId(message) === 2, () => parseError, child)
      expect(JSON.stringify(toolsResult)).toContain('grep_code')

      sendJsonRpc(child, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'search_code', arguments: { query: 'demoValue', k: 1 } }
      })
      const searchResult = await waitForJsonRpcMessage(messages, (message) => rpcId(message) === 3, () => parseError, child)
      const searchText = mcpText(searchResult)
      expect(searchText).toContain('src/demo.ts')
      expect(searchText).toContain('1 | export function demoValue(): string {')
      expect(searchText).toContain("2 |   return 'demo'")
      expect(searchText).toContain('tokensReturned=')
      expect(searchText).not.toContain(' ↩ ')
      const chunkId = /[=~+] ([^\s"]+)/.exec(searchText)?.[1]
      expect(chunkId).toBeTruthy()

      sendJsonRpc(child, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'read_chunk', arguments: { id: chunkId } }
      })
      const readResult = await waitForJsonRpcMessage(messages, (message) => rpcId(message) === 4, () => parseError, child)
      expect(JSON.stringify(readResult)).toContain("return 'demo'")
      expect(parseError).toBeUndefined()
      expect(stderrChunks.join('')).toContain('MCP ready')
    } finally {
      child.kill()
    }
  }, 10_000)
})

function makeHit(overrides: Partial<SearchHit>): SearchHit {
  return {
    id: 'src/auth.ts:10-14@abcdef01',
    file: 'src/auth.ts',
    range: { startLine: 10, endLine: 14 },
    score: 0.9,
    reason: '~',
    snippet: 'function verify() {\n  return true\n}',
    snippetRange: { startLine: 10, endLine: 14 },
    tokensReturned: 42,
    symbol: 'verify',
    ...overrides
  }
}

function makeSymbol(overrides: Partial<Omit<SymbolDefinition, 'body'>> & { body?: string | undefined } = {}): SymbolDefinition {
  const { body, ...rest } = overrides
  const definition: SymbolDefinition = {
    id: 'src/auth.ts:10-13@abcdef01',
    name: 'verifyToken',
    kind: 'function',
    file: 'src/auth.ts',
    range: { startLine: 10, endLine: 13 },
    body: 'export function verifyToken(token: string): boolean {\n  return token.length > 0\n}',
    ...rest
  }

  if ('body' in overrides) {
    if (body === undefined) {
      delete definition.body
    } else {
      definition.body = body
    }
  }

  return definition
}

function makeEdgeResult(overrides: Partial<Omit<EdgeResult, 'srcSymbol'>> & { srcSymbol?: string | undefined } = {}): EdgeResult {
  const { srcSymbol, ...rest } = overrides
  const result: EdgeResult = {
    file: 'src/auth.ts',
    range: { startLine: 10, endLine: 10 },
    line: 10,
    snippet: '  return verifyToken(token)',
    srcSymbol: 'handleRequest',
    edgeKind: 'call',
    resolution: 'import-resolved',
    ...rest
  }

  if ('srcSymbol' in overrides) {
    if (srcSymbol === undefined) {
      delete result.srcSymbol
    } else {
      result.srcSymbol = srcSymbol
    }
  }

  return result
}

function makeImpactResult(overrides: Partial<ImpactResult> = {}): ImpactResult {
  return {
    nodes: [
      {
        name: 'handleRequest',
        file: 'src/auth.ts',
        range: { startLine: 10, endLine: 10 },
        line: 10,
        snippet: '  return verifyToken(token)',
        srcSymbol: 'handleRequest',
        depth: 1,
        edgeKind: 'call',
        resolution: 'import-resolved'
      }
    ],
    depthLimit: 2,
    maxNodes: 50,
    ...overrides
  }
}

function makeStatus(overrides: Partial<RepoStatus> = {}): RepoStatus {
  return {
    root: '/tmp/repo',
    indexPath: '/tmp/repo/.codesift/index.db',
    indexExists: true,
    indexed: true,
    stale: false,
    sync: { state: 'completed', completedAt: '2026-06-20T00:00:00.000Z' },
    chunkCount: 123,
    symbolCount: 45,
    generatedFileCount: 0,
    generatedChunkCount: 0,
    indexGeneration: 3,
    provider: { id: 'local-hash' },
    compatibility: { ok: true },
    vectorSearch: { available: true, state: 'lazy' },
    ...overrides
  }
}

describe('formatMcpIndexStatus compact output', () => {
  it('renders healthy status as compact lines without raw paths or JSON wrappers', () => {
    const output = formatMcpIndexStatus(makeStatus())

    expect(output).toBe('indexed=yes stale=no sync=completed chunks=123 symbols=45 gen=3 generated=0/0 provider=local-hash compat=ok vector=lazy')
    expect(output).not.toContain('/tmp/repo')
    expect(output).not.toContain('indexPath')
    expect(output).not.toContain('{')
  })

  it('reports a missing index with an indexing action', () => {
    const output = formatMcpIndexStatus(makeStatus({
      indexed: false,
      sync: { state: 'idle' },
      chunkCount: 0,
      symbolCount: 0,
      indexGeneration: 0,
      provider: null
    }))

    expect(output).toContain('indexed=no')
    expect(output).toContain('provider=unconfigured')
    expect(output).toContain('action=codesift index')
  })

  it('reports stale reason codes, clipped files, and sync action', () => {
    const output = formatMcpIndexStatus(makeStatus({
      stale: true,
      staleReasons: [
        { code: 'file_modified', message: '4 files modified', count: 4, files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'] }
      ]
    }))

    expect(output).toContain('stale=yes')
    expect(output).toContain('stale_reasons=file_modified count=4 files=src/a.ts,src/b.ts,+2')
    expect(output).toContain('message=4 files modified')
    expect(output).toContain('action=codesift sync')
  })

  it('keeps sync errors and a truncation marker under small budgets when possible', () => {
    const output = formatMcpIndexStatus(makeStatus({
      sync: { state: 'failed', error: `planned failure ${'x'.repeat(300)}` }
    }), { maxTokens: 45 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(45)
    expect(output).toContain('sync=failed')
    expect(output).toContain('action=codesift sync')
    expect(output).toContain('sync_error=')
    expect(output).toContain('status_truncated=true')
  })

  it('keeps action visible by compacting the primary line for tight actionable budgets', () => {
    const output = formatMcpIndexStatus(makeStatus({
      provider: { id: `provider-${'x'.repeat(80)}`, dims: 1536, modelVersion: `model-${'y'.repeat(80)}` },
      compatibility: {
        ok: false,
        code: 'model_version_mismatch',
        message: `provider model changed ${'z'.repeat(200)}`
      }
    }), { maxTokens: 32 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(32)
    expect(output).toContain('indexed=yes')
    expect(output).toContain('action=codesift index --rebuild')
    expect(output).toContain('status_truncated=true')
  })

  it('reports compatibility mismatch without raw expected or actual snapshots', () => {
    const output = formatMcpIndexStatus(makeStatus({
      compatibility: {
        ok: false,
        code: 'provider_mismatch',
        message: 'Provider changed; run codesift index --rebuild',
        expected: { providerId: 'local-hash' },
        actual: { providerId: 'cloud-provider' }
      }
    }))

    expect(output).toContain('compat=provider_mismatch')
    expect(output).toContain('compat_message=Provider changed; run codesift index --rebuild')
    expect(output).toContain('action=codesift index --rebuild')
    expect(output).not.toContain('expected')
    expect(output).not.toContain('actual')
  })

  it('reports vector unavailability reason without dumping long detail', () => {
    const output = formatMcpIndexStatus(makeStatus({
      vectorSearch: {
        available: false,
        state: 'unavailable',
        reason: 'native-dependency-unavailable',
        message: 'vector search unavailable (native dep), lexical/symbol still works',
        detail: `missing sqlite-vec prebuild ${'x'.repeat(200)}`
      }
    }))

    expect(output).toContain('vector=unavailable')
    expect(output).toContain('vector_reason=native-dependency-unavailable')
    expect(output).toContain('vector_message=vector search unavailable')
    expect(output).not.toContain('sqlite-vec prebuild')
  })

  it('budgets index_status output through callMcpTool', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-mcp-status-budget-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(join(repoRoot, 'src', 'demo.ts'), `export const demoValue = '${'x'.repeat(200)}'\n`, 'utf8')

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const output = await callMcpTool(repo, 'index_status', { max_tokens: 40 })
    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(40)
    expect(output).toContain('indexed=yes')
    expect(output).not.toContain('indexPath')
    expect(output).not.toContain('{')
  })
})

describe('formatMcpChangesetContext output', () => {
  it('labels capped omissions as lower bounds and marks symbol clipping', () => {
    const output = formatMcpChangesetContext({
      files: [
        {
          file: 'src/auth.ts',
          symbols: Array.from({ length: 10 }, (_, index) => ({
            id: `symbol-${index}`,
            name: `symbol${index}`,
            kind: 'function',
            file: 'src/auth.ts',
            range: { startLine: index + 1, endLine: index + 1 }
          })),
          callers: [],
          importers: [],
          omitted: 1,
          omittedLowerBound: true
        }
      ],
      truncated: true
    })

    expect(output).toContain('file src/auth.ts')
    expect(output).toContain('- symbol function symbol7 8')
    expect(output).not.toContain('symbol8')
    expect(output).toContain('symbols_omitted=2; narrow files')
    expect(output).toContain('omitted>=1; raise max_edges_per_file or narrow files')
    expect(output).toContain('changeset_truncated=true')
  })
})

describe('formatMcpCallers/References/Importers/Implementers budgeted output', () => {
  it('preserves empty markers and under-budget edge rows byte-for-byte', () => {
    const results = [makeEdgeResult()]
    const expected = 'src/auth.ts:10 handleRequest call import-resolved | return verifyToken(token)'

    expect(formatMcpCallers([])).toBe('no_callers')
    expect(formatMcpReferences([])).toBe('no_refs')
    expect(formatMcpImporters([])).toBe('no_importers')
    expect(formatMcpImplementers([])).toBe('no_implementers')
    expect(formatMcpCallers(results)).toBe(expected)
    expect(formatMcpReferences(results)).toBe(expected)
    expect(formatMcpImporters([makeEdgeResult({ srcSymbol: undefined, edgeKind: 'import', snippet: "import { verifyToken } from './auth'" })])).toBe(
      "src/auth.ts:10 top-level import import-resolved | import { verifyToken } from './auth'"
    )
    expect(formatMcpImplementers([makeEdgeResult({ srcSymbol: 'JwtVerifier', edgeKind: 'implements', snippet: 'class JwtVerifier extends BaseVerifier implements AuthStrategy {' })])).toBe(
      'src/auth.ts:10 JwtVerifier implements import-resolved | class JwtVerifier extends BaseVerifier implements AuthStrategy {'
    )
  })

  it('marks name-only rows as approximate and emits omission markers when truncated', () => {
    const results = Array.from({ length: 5 }, (_, index) => makeEdgeResult({
      file: `src/callers/${index}.ts`,
      line: index + 10,
      range: { startLine: index + 10, endLine: index + 10 },
      resolution: index === 0 ? 'name-only' : 'import-resolved',
      snippet: `  return verifyToken(token, '${'x'.repeat(90)}')`
    }))

    const output = formatMcpCallers(results, { maxTokens: 35 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(35)
    expect(output).toContain('approx:name-only')
    expect(output).toContain('callers_omitted=')
    expect(output).not.toContain('src/callers/4.ts')
  })

  it('uses the tool-specific omission marker for tiny budgets', () => {
    const output = formatMcpImporters([
      makeEdgeResult({ srcSymbol: undefined, edgeKind: 'import', snippet: `import { verifyToken } from './${'deep/'.repeat(8)}auth'` }),
      makeEdgeResult({ file: 'src/other.ts', srcSymbol: undefined, edgeKind: 'import' })
    ], { maxTokens: 8 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(8)
    expect(output).toContain('importers_omitted=1')
    expect(output).not.toContain('src/other.ts')
  })

  it('uses the implementers omission marker for tight budgets', () => {
    const output = formatMcpImplementers([
      makeEdgeResult({ edgeKind: 'implements', snippet: `class JwtVerifier implements ${'AuthStrategy'.repeat(12)}` }),
      makeEdgeResult({ file: 'src/other.ts', line: 11, range: { startLine: 11, endLine: 11 }, edgeKind: 'extends', srcSymbol: 'StrictStrategy' })
    ], { maxTokens: 10 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(10)
    expect(output).toContain('implementers_omitted=1')
    expect(output).not.toContain('src/other.ts')
  })
})

describe('formatMcpImpact budgeted output', () => {
  it('renders bounded impact notes and keeps a truncation marker under tight budgets', () => {
    const output = formatMcpImpact(makeImpactResult({
      nodes: [
        {
          name: 'handleRequest',
          file: 'src/auth.ts',
          range: { startLine: 10, endLine: 10 },
          line: 10,
          snippet: `  return verifyToken(token, '${'x'.repeat(120)}')`,
          srcSymbol: 'handleRequest',
          depth: 2,
          edgeKind: 'call',
          resolution: 'name-only'
        },
        {
          name: 'runApp',
          file: 'src/app.ts',
          range: { startLine: 4, endLine: 4 },
          line: 4,
          snippet: '  return handleRequest(token)',
          srcSymbol: 'runApp',
          depth: 3,
          edgeKind: 'call',
          resolution: 'import-resolved'
        }
      ],
      depthCapped: true,
      nodesCapped: true,
      impactTruncated: true,
      depthLimit: 2,
      maxNodes: 50
    }), { maxTokens: 28 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(28)
    expect(output).toContain('approx:name-only')
    expect(output).toContain('impact_truncated=true')
    expect(output).toContain('depth_capped=2')
    expect(output).toContain('nodes_capped=50')
  })
})

describe('formatMcpSymbols budgeted output', () => {
  it('preserves no_symbols and under-budget output byte-for-byte', () => {
    const definitions = [makeSymbol()]
    const expected = [
      '#1 function verifyToken src/auth.ts:10-13',
      '10 | export function verifyToken(token: string): boolean {',
      '11 |   return token.length > 0',
      '12 | }'
    ].join('\n')

    expect(formatMcpSymbols([])).toBe('no_symbols')
    expect(formatMcpSymbols(definitions)).toBe(expected)
    expect(formatMcpSymbols(definitions, { maxTokens: 500 })).toBe(expected)
  })

  it('preserves the first definition and omits later rows when over budget', () => {
    const definitions = [
      makeSymbol({
        body: `export function verifyToken(token: string): boolean {\n  const padded = '${'x'.repeat(180)}'\n  return token + padded !== ''\n}`
      }),
      makeSymbol({ name: 'verifyToken', file: 'src/legacy.ts', range: { startLine: 1, endLine: 1 }, body: undefined }),
      makeSymbol({ name: 'verifyToken', file: 'src/other.ts', range: { startLine: 5, endLine: 5 }, body: undefined })
    ]

    const output = formatMcpSymbols(definitions, { maxTokens: 45 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(45)
    expect(output).toContain('#1 function verifyToken src/auth.ts:10-13')
    expect(output).toContain('10 | export function verifyToken')
    expect(output).toContain('symbols_omitted=')
    expect(output).not.toContain('#2 function verifyToken')
  })

  it('marks a single over-budget symbol body as truncated instead of omitted', () => {
    const output = formatMcpSymbols([
      makeSymbol({
        body: `export function verifyToken(token: string): boolean {\n  const padded = '${'x'.repeat(180)}'\n  return token + padded !== ''\n}`
      })
    ], { maxTokens: 35 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(35)
    expect(output).toContain('#1 function verifyToken src/auth.ts:10-13')
    expect(output).toContain('symbol_body_truncated=true')
    expect(output).not.toContain('symbols_omitted=0')
  })

  it('keeps a recognizable omission marker for tiny budgets when it fits', () => {
    const output = formatMcpSymbols([
      makeSymbol({ body: `export function verifyToken() {\n  return '${'x'.repeat(100)}'\n}` }),
      makeSymbol({ file: 'src/other.ts', body: undefined })
    ], { maxTokens: 5 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(5)
    expect(output).toContain('symbols_omitted=1')
  })

  it('adds a bounded relations block and relation omission marker when requested output is tight', () => {
    const output = formatMcpSymbols([
      makeSymbol({
        relations: {
          sites: Array.from({ length: 5 }, (_, index) => makeEdgeResult({
            file: `src/callers/${index}.ts`,
            line: index + 10,
            range: { startLine: index + 10, endLine: index + 10 },
            srcSymbol: `caller${index}`
          })),
          neighbors: [
            { name: 'ParsedToken', file: 'src/auth.ts', range: { startLine: 1, endLine: 4 }, kind: 'interface' }
          ],
          omitted: 3
        }
      })
    ], { maxTokens: 45 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(45)
    expect(output).toContain('relations:')
    expect(output).toContain('relations_omitted=')
  })
})

describe('formatMcpSearchHits structure-preserving output', () => {
  it('renders an inlined body as a line-numbered block starting at range.startLine with original indentation', () => {
    const body = 'function verify(token: string): boolean {\n  if (!token) {\n    return false\n  }\n  return true\n}'
    const output = formatMcpSearchHits([makeHit({ body, range: { startLine: 10, endLine: 15 } })])

    const lines = output.split('\n')
    // Header carries reason + id (hash stripped) + symbol path.
    expect(lines[0]).toBe('~ src/auth.ts:10-14 verify')
    // Body block is line-numbered from range.startLine, preserving indentation, no ' ↩ ' flattening.
    expect(lines[1]).toBe('10 | function verify(token: string): boolean {')
    expect(lines[2]).toBe('11 |   if (!token) {')
    expect(lines[3]).toBe('12 |     return false')
    expect(lines[4]).toBe('13 |   }')
    expect(lines[5]).toBe('14 |   return true')
    expect(lines[6]).toBe('15 | }')
    expect(output).not.toContain(' ↩ ')
    expect(output).toContain('tokensReturned=42')
  })

  it('renders import-resolved usages under the primary hit', () => {
    const output = formatMcpSearchHits([
      makeHit({
        body: 'export function verify() {\n  return true\n}',
        usages: [
          { file: 'src/server.ts', range: { startLine: 4, endLine: 4 }, line: 4, snippet: '  return verify(token)', resolution: 'import-resolved' }
        ]
      })
    ])

    expect(output).toContain('usages (import-resolved):')
    expect(output).toContain('- src/server.ts:4 |   return verify(token)')
  })

  it('carries [generated] and [stale] flags on the body-block header', () => {
    const output = formatMcpSearchHits([
      makeHit({ body: 'const x = 1', range: { startLine: 5, endLine: 5 }, generated: true, stale: true })
    ])
    const header = output.split('\n')[0]
    expect(header).toContain('[generated]')
    expect(header).toContain('[stale]')
    expect(output).toContain('5 | const x = 1')
  })

  it('passes the truncation marker through verbatim as a numbered line', () => {
    const body = 'function big() {\n  doThing()\n… (truncated — read_chunk src/auth.ts:10-14 for full)'
    const output = formatMcpSearchHits([makeHit({ body, range: { startLine: 1, endLine: 3 } })])
    expect(output).toContain('3 | … (truncated — read_chunk src/auth.ts:10-14 for full)')
  })

  it('renders a compact (no body) hit from snippetRange with real newlines, preserved indentation, and NN | prefixes', () => {
    const output = formatMcpSearchHits([
      makeHit({
        range: { startLine: 10, endLine: 30 },
        snippet: 'function verify() {\n  return true\n}',
        snippetRange: { startLine: 18, endLine: 20 }
      })
    ])
    expect(output).not.toContain(' ↩ ')
    const lines = output.split('\n')
    expect(lines[0]).toBe('~ src/auth.ts:10-14 verify')
    // Compact snippets are line-numbered from snippetRange.startLine; core may
    // center snippets inside a wider hit range.
    expect(lines[1]).toBe('18 | function verify() {')
    expect(lines[2]).toBe('19 |   return true')
    expect(lines[3]).toBe('20 | }')
    expect(output).toContain('tokensReturned=42')
  })

  it('preserves deep leading indentation on a compact snippet rather than trimming it', () => {
    const output = formatMcpSearchHits([
      makeHit({
        snippet: 'class Auth {\n  verify() {\n    return this.token != null\n  }\n}',
        range: { startLine: 10, endLine: 30 },
        snippetRange: { startLine: 20, endLine: 24 }
      })
    ])
    const lines = output.split('\n')
    expect(lines[1]).toBe('20 | class Auth {')
    expect(lines[2]).toBe('21 |   verify() {')
    expect(lines[3]).toBe('22 |     return this.token != null')
  })

  it('sums tokensReturned across mixed inlined and compact hits', () => {
    const output = formatMcpSearchHits([
      makeHit({ id: 'a:1-2@aaaaaaaa', body: 'const a = 1', range: { startLine: 1, endLine: 1 }, tokensReturned: 100 }),
      makeHit({ id: 'b:3-4@bbbbbbbb', snippet: 'const b = 2', tokensReturned: 23 })
    ])
    expect(output).toContain('tokensReturned=123')
  })

  it('returns no_hits for an empty result set', () => {
    expect(formatMcpSearchHits([])).toBe('no_hits')
  })

  it('leads with an "ambiguous: N defs" hint when the top hit flags a collision', () => {
    const output = formatMcpSearchHits([
      makeHit({ ambiguousDefCount: 3, file: 'src/a.ts' }),
      makeHit({ file: 'src/b.ts', id: 'src/b.ts:1-3@beef0002' })
    ])

    expect(output.split('\n')[0]).toBe('ambiguous: 3 defs')
    expect(output).toContain('tokensReturned=')
  })

  it('omits the ambiguity hint for an ordinary (non-colliding) result set', () => {
    const output = formatMcpSearchHits([makeHit({})])
    expect(output).not.toContain('ambiguous:')
  })
})

describe('formatMcpSearchHits budgeted output', () => {
  it('preserves no_hits and under-budget output byte-for-byte', () => {
    expect(formatMcpSearchHits([], { maxTokens: DEFAULT_MCP_SEARCH_MAX_TOKENS })).toBe('no_hits')

    const usageSnippet = "  return verify(token)\n    // keep trailing spaces  "
    const hits = [makeHit({
      body: 'export function verify() {\n  return true\n}',
      usages: [
        { file: 'src/server.ts', range: { startLine: 4, endLine: 5 }, line: 4, snippet: usageSnippet, resolution: 'import-resolved' }
      ]
    })]
    const expected = [
      '~ src/auth.ts:10-14 verify',
      '10 | export function verify() {',
      '11 |   return true',
      '12 | }',
      'usages (import-resolved):',
      `- src/server.ts:4 | ${usageSnippet}`,
      'tokensReturned=42'
    ].join('\n')

    expect(formatMcpSearchHits(hits)).toBe(expected)
    expect(formatMcpSearchHits(hits, { maxTokens: 200 })).toBe(expected)
  })

  it('preserves the first hit and appends a hits_omitted marker when later hits are dropped', () => {
    const hits = Array.from({ length: 5 }, (_, index) =>
      makeHit({
        id: `src/file-${index}.ts:${index + 1}-${index + 4}@abcdef0${index}`,
        file: `src/file-${index}.ts`,
        range: { startLine: index + 1, endLine: index + 4 },
        snippetRange: { startLine: index + 1, endLine: index + 4 },
        body: `export function repeated${index}() {\n  return '${'x'.repeat(70)}-${index}'\n}`,
        tokensReturned: 30 + index
      })
    )

    const output = formatMcpSearchHits(hits, { maxTokens: 40 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(40)
    expect(output).toContain('src/file-0.ts:1-4')
    expect(output).not.toContain('src/file-4.ts')
    expect(output).toContain('hits_omitted=')
  })

  it('truncates usage snippets without losing file:line locators and reports omitted usages', () => {
    const output = formatMcpSearchHits([
      makeHit({
        body: 'export function verify() {\n  return true\n}',
        usages: Array.from({ length: 5 }, (_, index) => ({
          file: `src/callers/${index}.ts`,
          range: { startLine: index + 40, endLine: index + 40 },
          line: index + 40,
          snippet: `  return verify(token, '${'x'.repeat(90)}', '${'y'.repeat(90)}')`,
          resolution: 'import-resolved' as const
        }))
      })
    ], { maxTokens: 42 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(42)
    expect(output).toContain('usages (import-resolved):')
    expect(output).toMatch(/- src\/callers\/0\.ts:40 \| /)
    expect(output).toContain('usages_omitted=')
  })

  it('keeps the bare usage omission marker when that is the only variant that fits', () => {
    const output = formatMcpSearchHits([
      makeHit({
        body: 'export function verify() {\n  const normalized = token.trim()\n  return normalized.length > 0\n}',
        usages: Array.from({ length: 5 }, (_, index) => ({
          file: `src/usage/${index}.ts`,
          range: { startLine: index + 10, endLine: index + 10 },
          line: index + 10,
          snippet: `  return verify(token, '${'x'.repeat(80)}')`,
          resolution: 'import-resolved' as const
        }))
      })
    ], { maxTokens: 12 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(12)
    expect(output).toContain('usages_omitted=5')
    expect(output).not.toContain('raise max_tokens')
  })

  it('keeps a recognizable omission marker for tiny budgets when it fits', () => {
    const output = formatMcpSearchHits([
      makeHit({ body: `export function verify() {\n  return '${'x'.repeat(120)}'\n}` }),
      makeHit({ file: 'src/other.ts', id: 'src/other.ts:1-1@beef0002' })
    ], { maxTokens: 5 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(5)
    expect(output).toContain('hits_omitted=1')
  })

  it('falls back to a truncated hit omission marker instead of a misleading bare hit when the budget is microscopic', () => {
    const output = formatMcpSearchHits([
      makeHit({ body: `export function verify() {\n  return '${'x'.repeat(120)}'\n}` }),
      makeHit({ file: 'src/other.ts', id: 'src/other.ts:1-1@beef0002' })
    ], { maxTokens: 3 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(3)
    expect(output).toContain('hits_omit')
    expect(output).not.toContain('src/auth.ts:10-14 verify')
  })

  it('falls back to a truncated usage omission marker instead of silently dropping usages', () => {
    const output = formatMcpSearchHits([
      makeHit({
        body: 'export function verify() {\n  const normalized = token.trim()\n  return normalized.length > 0\n}',
        usages: Array.from({ length: 5 }, (_, index) => ({
          file: `src/usage/${index}.ts`,
          range: { startLine: index + 10, endLine: index + 10 },
          line: index + 10,
          snippet: `  return verify(token, '${'x'.repeat(80)}')`,
          resolution: 'import-resolved' as const
        }))
      })
    ], { maxTokens: 4 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(4)
    expect(output).toContain('usages_omit')
    expect(output).not.toContain('usages (import-resolved):')
  })
})

describe('formatMcpGrepHits keeps its single-line ↩-joined format', () => {
  it('flattens the snippet with the ↩ arrow and trims each line (unchanged from search-hit rendering)', () => {
    const hit = makeGrepHit({ snippet: 'function verify() {\n  return true\n}' })
    expect(formatMcpGrepHits([hit])).toBe('src/auth.ts:10-12:3 | function verify() { ↩ return true ↩ }')
  })

  it('returns no_matches for an empty result set', () => {
    expect(formatMcpGrepHits([])).toBe('no_matches')
  })

  it('preserves not-indexed metadata on empty grep results', () => {
    const hits = [] as GrepHit[] & { meta?: { notIndexed: boolean } }
    Object.defineProperty(hits, 'meta', {
      value: { notIndexed: true },
      enumerable: false
    })
    expect(formatMcpGrepHits(hits)).toBe(NOT_INDEXED_SENTINEL)
  })

  it('leaves grep formatting unchanged when the rendered hits fit under the token budget', () => {
    const output = formatMcpGrepHits([
      makeGrepHit({ snippet: 'function verify() {\n  return true\n}' })
    ], { maxTokens: 80 })

    expect(output).toBe('src/auth.ts:10-12:3 | function verify() { ↩ return true ↩ }')
  })

  it('merges overlapping same-file context windows while keeping every match locator', () => {
    const output = formatMcpGrepHits([
      makeGrepHit({
        range: { startLine: 2, endLine: 2 },
        line: 2,
        column: 16,
        match: 'NEEDLE',
        snippet: "const before = true\nconst first = 'NEEDLE'\nconst shared = true",
        snippetRange: { startLine: 1, endLine: 3 }
      }),
      makeGrepHit({
        range: { startLine: 4, endLine: 4 },
        line: 4,
        column: 17,
        match: 'NEEDLE',
        snippet: "const shared = true\nconst second = 'NEEDLE'\nconst after = true",
        snippetRange: { startLine: 3, endLine: 5 }
      })
    ])

    expect(output).toBe([
      'src/auth.ts:2:16',
      'src/auth.ts:4:17',
      '1 | const before = true',
      "2 | const first = 'NEEDLE'",
      '3 | const shared = true',
      "4 | const second = 'NEEDLE'",
      '5 | const after = true'
    ].join('\n'))
    expect(output.match(/3 \| const shared = true/g)).toHaveLength(1)
  })

  it('keeps no-context adjacent hits in the existing compact format', () => {
    const output = formatMcpGrepHits([
      makeGrepHit({
        range: { startLine: 2, endLine: 2 },
        line: 2,
        snippet: "const first = 'NEEDLE'",
        snippetRange: { startLine: 2, endLine: 2 }
      }),
      makeGrepHit({
        range: { startLine: 3, endLine: 3 },
        line: 3,
        snippet: "const second = 'NEEDLE'",
        snippetRange: { startLine: 3, endLine: 3 }
      })
    ])

    expect(output).toBe([
      "src/auth.ts:2:3 | const first = 'NEEDLE'",
      "src/auth.ts:3:3 | const second = 'NEEDLE'"
    ].join('\n'))
  })

  it('counts omitted grouped grep entries by matches rather than groups', () => {
    const output = formatMcpGrepHits([
      makeGrepHit({
        range: { startLine: 2, endLine: 2 },
        line: 2,
        snippet: "a\nconst first = 'NEEDLE'\nb",
        snippetRange: { startLine: 1, endLine: 3 }
      }),
      makeGrepHit({
        range: { startLine: 4, endLine: 4 },
        line: 4,
        snippet: "b\nconst second = 'NEEDLE'\nc",
        snippetRange: { startLine: 3, endLine: 5 }
      }),
      makeGrepHit({
        range: { startLine: 20, endLine: 20 },
        line: 20,
        snippet: "x\nconst third = 'NEEDLE'\ny",
        snippetRange: { startLine: 19, endLine: 21 }
      }),
      makeGrepHit({
        range: { startLine: 22, endLine: 22 },
        line: 22,
        snippet: "y\nconst fourth = 'NEEDLE'\nz",
        snippetRange: { startLine: 21, endLine: 23 }
      })
    ], { maxTokens: 45 })

    expect(output).toContain('src/auth.ts:2:3')
    expect(output).toContain('src/auth.ts:4:3')
    expect(output).not.toContain('src/auth.ts:20:3')
    expect(output).not.toContain('src/auth.ts:22:3')
    expect(output).toContain('matches_omitted=2')
    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(45)
  })

  it('keeps all locators from the first merged group when its snippet is over budget', () => {
    const output = formatMcpGrepHits([
      makeGrepHit({
        range: { startLine: 2, endLine: 2 },
        line: 2,
        snippet: `${'a'.repeat(80)}\nconst first = 'NEEDLE'\n${'b'.repeat(80)}`,
        snippetRange: { startLine: 1, endLine: 3 }
      }),
      makeGrepHit({
        range: { startLine: 4, endLine: 4 },
        line: 4,
        snippet: `${'b'.repeat(80)}\nconst second = 'NEEDLE'\n${'c'.repeat(80)}`,
        snippetRange: { startLine: 3, endLine: 5 }
      }),
      makeGrepHit({
        range: { startLine: 20, endLine: 20 },
        line: 20,
        snippet: "const third = 'NEEDLE'",
        snippetRange: { startLine: 20, endLine: 20 }
      })
    ], { maxTokens: 35 })

    expect(output).toContain('src/auth.ts:2:3')
    expect(output).toContain('src/auth.ts:4:3')
    expect(output).not.toContain('src/auth.ts:20:3')
    expect(output).toContain('matches_omitted=1')
    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(35)
  })

  it('preserves first hits and appends a compact omission marker when maxTokens truncates matches', () => {
    const hits = Array.from({ length: 6 }, (_, index) =>
      makeGrepHit({
        file: `src/file-${index}.ts`,
        range: { startLine: index + 1, endLine: index + 1 },
        line: index + 1,
        snippet: `const repeated${index} = 'needle-${index}'`
      })
    )
    const output = formatMcpGrepHits(hits, { maxTokens: 32 })

    expect(output).toContain("src/file-0.ts:1:3 | const repeated0 = 'needle-0'")
    expect(output).not.toContain('src/file-5.ts')
    expect(output).toContain('matches_omitted=')
    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(32)
  })

  it('truncates only snippet text when the first grep hit alone exceeds the budget', () => {
    const output = formatMcpGrepHits([
      makeGrepHit({
        file: 'src/verbose.ts',
        range: { startLine: 7, endLine: 7 },
        line: 7,
        column: 11,
        snippet: `const message = '${'x'.repeat(400)}'`
      }),
      makeGrepHit({ file: 'src/tail.ts' })
    ], { maxTokens: 25 })

    expect(output.startsWith('src/verbose.ts:7:11 | ')).toBe(true)
    expect(output).toContain('…')
    expect(output).toContain('matches_omitted=1; refine path_glob/max_matches or raise max_tokens.')
    expect(output).not.toContain('src/tail.ts')
  })

  it('keeps long-prefix tiny-budget output within the approximate budget', () => {
    const output = formatMcpGrepHits([
      makeGrepHit({
        file: `src/${'very-long-directory/'.repeat(8)}verbose.ts`,
        range: { startLine: 1, endLine: 1 },
        line: 1,
        column: 1,
        snippet: 'const value = "needle"'
      }),
      makeGrepHit({ file: 'src/tail.ts' })
    ], { maxTokens: 8 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(8)
    expect(output).toContain('matches_omitted=1')
    expect(output).not.toContain('src/tail.ts')
  })
})

describe('grep_code MCP output budgeting', () => {
  it('budgets noisy literal output through callMcpTool while preserving the first match', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-mcp-grep-budget-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(
      join(repoRoot, 'src', 'noisy.ts'),
      Array.from({ length: 20 }, (_, index) => `export const value${index} = 'NEEDLE_${index}'`).join('\n'),
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const output = await callMcpTool(repo, 'grep_code', { pattern: 'NEEDLE', path_glob: 'src/**', max_tokens: 40 })
    expect(output).toContain("src/noisy.ts:1:24 | export const value0 = 'NEEDLE_0'")
    expect(output).toContain('matches_omitted=')
    expect(output).not.toContain('NEEDLE_19')
  })

  it('merges nearby grep_code context windows through callMcpTool', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-mcp-grep-context-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(
      join(repoRoot, 'src', 'cluster.ts'),
      [
        'const before = true',
        "const first = 'NEEDLE'",
        'const shared = true',
        "const second = 'NEEDLE'",
        'const after = true'
      ].join('\n'),
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const output = await callMcpTool(repo, 'grep_code', { pattern: 'NEEDLE', path_glob: 'src/**', context_lines: 1 })
    expect(output).toContain('src/cluster.ts:2:16')
    expect(output).toContain('src/cluster.ts:4:17')
    expect(output.match(/3 \| const shared = true/g)).toHaveLength(1)
    expect(output).toContain("2 | const first = 'NEEDLE'")
    expect(output).toContain("4 | const second = 'NEEDLE'")
  })
})

describe('read_chunk MCP output budgeting', () => {
  it('leaves under-budget chunk content byte-for-byte unchanged', () => {
    const content = 'export function demoValue(): string {\n  return "demo"\n}\n'

    expect(formatMcpReadChunk(content, { maxTokens: 80 })).toBe(content)
  })

  it('preserves the first source content and appends a compact truncation marker', () => {
    const content = Array.from({ length: 30 }, (_, index) => `export const noisyValue${index} = '${'x'.repeat(40)}'`).join('\n')
    const output = formatMcpReadChunk(content, { maxTokens: 45 })

    expect(output).toContain("export const noisyValue0 = '")
    expect(output).toContain('content_truncated=true; raise max_tokens or narrow the chunk/range.')
    expect(output).not.toContain('noisyValue29')
    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(45)
  })

  it('keeps tiny-budget output within the approximate budget with a recognizable marker', () => {
    const output = formatMcpReadChunk('const value = "' + 'x'.repeat(400) + '"', { maxTokens: 6 })

    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(6)
    expect(output).toContain('content_truncated')
  })

  it('budgets noisy read_chunk output through callMcpTool while preserving the first lines', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-mcp-read-budget-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(
      join(repoRoot, 'src', 'noisy.ts'),
      Array.from({ length: 120 }, (_, index) => `export const noisyValue${index} = '${'x'.repeat(40)}'`).join('\n'),
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const output = await callMcpTool(repo, 'read_chunk', { id: 'src/noisy.ts:1-120', max_tokens: 60 })
    expect(output).toContain("export const noisyValue0 = '")
    expect(output).toContain('content_truncated=true')
    expect(output).not.toContain('noisyValue119')
    expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(60)
  })
})

function makeGrepHit(overrides: Partial<GrepHit> = {}): GrepHit {
  return {
    file: 'src/auth.ts',
    range: { startLine: 10, endLine: 12 },
    line: 10,
    column: 3,
    match: 'verify',
    snippet: 'function verify() {\n  return true\n}',
    ...overrides
  }
}

function sendJsonRpc(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

async function waitForJsonRpcMessage(
  messages: unknown[],
  predicate: (message: unknown) => boolean,
  getParseError: () => Error | undefined,
  child: ChildProcessWithoutNullStreams
): Promise<unknown> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 5000) {
    const parseError = getParseError()
    if (parseError) {
      throw parseError
    }

    const found = messages.find(predicate)
    if (found) {
      return found
    }

    if (child.exitCode !== null) {
      throw new Error(`MCP child exited early with code ${child.exitCode}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error('Timed out waiting for JSON-RPC message')
}

function rpcId(message: unknown): number | undefined {
  if (typeof message !== 'object' || message === null || !('id' in message)) {
    return undefined
  }

  const id = (message as { id?: unknown }).id
  return typeof id === 'number' ? id : undefined
}

function mcpText(message: unknown): string {
  if (typeof message !== 'object' || message === null || !('result' in message)) {
    return ''
  }

  const result = (message as { result?: unknown }).result
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    return ''
  }

  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null || !('text' in entry)) {
        return ''
      }

      const text = (entry as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('\n')
}
