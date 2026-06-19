import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openRepo, registerEmbeddingProvider, type GrepHit, type SearchHit, type SymbolDefinition } from '@codesift/core'

import {
  DEFAULT_MCP_FIND_SYMBOL_MAX_TOKENS,
  DEFAULT_MCP_SEARCH_MAX_TOKENS,
  DEFAULT_MCP_READ_CHUNK_MAX_TOKENS,
  DEFAULT_SEARCH_K,
  MIN_MCP_READ_CHUNK_MAX_TOKENS,
  MCP_SERVER_INSTRUCTIONS,
  createHttpServer,
  createRouter,
  createStdioServer,
  callMcpTool,
  formatMcpGrepHits,
  formatMcpReadChunk,
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

describe('@codesift/mcp server', () => {
  it('exposes the planned tool surface with routing schemas', () => {
    expect(getToolDefinitions().map((tool) => tool.name)).toEqual([
      'search_code',
      'find_symbol',
      'grep_code',
      'read_chunk',
      'index_status'
    ])
    expect(getToolDefinitions().find((tool) => tool.name === 'grep_code')?.inputSchema.required).toEqual(['pattern'])
    expect(getToolDefinitions().find((tool) => tool.name === 'grep_code')?.inputSchema.properties).toMatchObject({
      max_tokens: { type: 'integer', minimum: 1, maximum: 4000, default: 700 }
    })
    expect(getToolDefinitions().find((tool) => tool.name === 'find_symbol')?.inputSchema.properties).toMatchObject({
      max_tokens: { type: 'integer', minimum: 1, maximum: 4000, default: DEFAULT_MCP_FIND_SYMBOL_MAX_TOKENS }
    })
    expect(getToolDefinitions().find((tool) => tool.name === 'read_chunk')?.inputSchema.properties).toMatchObject({
      max_tokens: { type: 'integer', minimum: MIN_MCP_READ_CHUNK_MAX_TOKENS, maximum: 4000, default: DEFAULT_MCP_READ_CHUNK_MAX_TOKENS }
    })
    expect(getToolDefinitions().find((tool) => tool.name === 'search_code')?.inputSchema.properties).toMatchObject({
      max_tokens: { type: 'integer', minimum: 1, maximum: 4000, default: DEFAULT_MCP_SEARCH_MAX_TOKENS },
      context: { type: 'string', enum: ['sig', 'body'] },
      with_usages: { type: 'boolean' }
    })
    expect(MCP_SERVER_INSTRUCTIONS).toContain('literals/env/errors/operators/regex->grep_code')
  })

  it('asserts single-call sufficiency in instructions and tool descriptions', () => {
    const lowerInstructions = MCP_SERVER_INSTRUCTIONS.toLowerCase()
    expect(lowerInstructions).toContain('top search_code body is inline')
    expect(lowerInstructions).toContain('read_chunk only for non-top hits/wider context')

    const tools = getToolDefinitions()
    const searchDescription = tools.find((tool) => tool.name === 'search_code')?.description ?? ''
    expect(searchDescription.toLowerCase()).toContain('top body inline')

    const findDescription = tools.find((tool) => tool.name === 'find_symbol')?.description ?? ''
    expect(findDescription.toLowerCase()).toContain('top unambiguous body inline')

    const readDescription = tools.find((tool) => tool.name === 'read_chunk')?.description ?? ''
    expect(readDescription.toLowerCase()).toContain('not needed for top search_code/find_symbol hits')
    expect(readDescription.toLowerCase()).toContain('returned inline')

    // The routing guidance for find_symbol/grep_code is preserved.
    expect(MCP_SERVER_INSTRUCTIONS).toContain('identifiers/definitions->find_symbol')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('concepts/unknown names->search_code')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('Broad search_code: k=5-8')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('Check index_status')
  })

  it('keeps control-plane metadata under the MCP budget', () => {
    const tools = getToolDefinitions()
    const payload = JSON.stringify({ instructions: MCP_SERVER_INSTRUCTIONS, tools })
    const toolDescriptionCeilings = new Map([
      ['search_code', 190],
      ['find_symbol', 130],
      ['grep_code', 120],
      ['read_chunk', 120],
      ['index_status', 90]
    ])

    expect(payload.length).toBeLessThanOrEqual(3500)
    expect(Math.ceil(payload.length / 4)).toBeLessThanOrEqual(875)
    expect(MCP_SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(430)
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

    expect(grepHits[0]?.file).toBe('src/demo.ts')
    expect(await router.readChunk({ id: hits[0]!.id })).toContain("return 'demo'")
    expect((await router.indexStatus()).indexed).toBe(true)
    expect(DEFAULT_SEARCH_K).toBe(8)
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

  it('leaves grep formatting unchanged when the rendered hits fit under the token budget', () => {
    const output = formatMcpGrepHits([
      makeGrepHit({ snippet: 'function verify() {\n  return true\n}' })
    ], { maxTokens: 80 })

    expect(output).toBe('src/auth.ts:10-12:3 | function verify() { ↩ return true ↩ }')
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
