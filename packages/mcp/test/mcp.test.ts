import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openRepo, registerEmbeddingProvider, type GrepHit, type SearchHit } from '@codesift/core'

import {
  DEFAULT_SEARCH_K,
  MCP_SERVER_INSTRUCTIONS,
  createHttpServer,
  createRouter,
  createStdioServer,
  formatMcpGrepHits,
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
    expect(getToolDefinitions().find((tool) => tool.name === 'search_code')?.inputSchema.properties).toMatchObject({
      context: { type: 'string', enum: ['sig', 'body'] },
      with_usages: { type: 'boolean' }
    })
    expect(MCP_SERVER_INSTRUCTIONS).toContain('use grep_code for literal strings')
  })

  it('asserts single-call sufficiency in instructions and tool descriptions', () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain('search_code returns the complete top result inline')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('no follow-up read is normally needed')
    expect(MCP_SERVER_INSTRUCTIONS.toLowerCase()).toContain('read_chunk only to expand an additional hit')

    const tools = getToolDefinitions()
    const searchDescription = tools.find((tool) => tool.name === 'search_code')?.description ?? ''
    expect(searchDescription).toContain('complete top result inline')
    expect(searchDescription.toLowerCase()).toContain('no follow-up read is normally needed')

    const readDescription = tools.find((tool) => tool.name === 'read_chunk')?.description ?? ''
    expect(readDescription).toContain('ADDITIONAL')
    expect(readDescription.toLowerCase()).toContain('already returned inline')

    // The routing guidance for find_symbol/grep_code is preserved.
    expect(MCP_SERVER_INSTRUCTIONS).toContain('use find_symbol for exact identifiers/definitions')
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
      const searchText = JSON.stringify(searchResult)
      expect(searchText).toContain('src/demo.ts')
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

describe('formatMcpSearchHits structure-preserving output', () => {
  it('renders an inlined body as a line-numbered block starting at range.startLine with original indentation', () => {
    const body = 'function verify(token: string): boolean {\n  if (!token) {\n    return false\n  }\n  return true\n}'
    const output = formatMcpSearchHits([makeHit({ body, range: { startLine: 10, endLine: 15 } })])

    const lines = output.split('\n')
    // Header carries reason + id (hash stripped) + symbol path.
    expect(lines[0]).toBe('~ src/auth.ts:10-14 verify')
    // Body block is line-numbered from startLine, preserving indentation, no ' ↩ ' flattening.
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

  it('renders a compact (no body) hit with real newlines, preserved indentation, and NN | line-number prefixes', () => {
    const output = formatMcpSearchHits([
      makeHit({ snippet: 'function verify() {\n  return true\n}' })
    ])
    expect(output).not.toContain(' ↩ ')
    const lines = output.split('\n')
    expect(lines[0]).toBe('~ src/auth.ts:10-14 verify')
    // Compact snippet is line-numbered from range.startLine and keeps original indentation.
    expect(lines[1]).toBe('10 | function verify() {')
    expect(lines[2]).toBe('11 |   return true')
    expect(lines[3]).toBe('12 | }')
    expect(output).toContain('tokensReturned=42')
  })

  it('preserves deep leading indentation on a compact snippet rather than trimming it', () => {
    const output = formatMcpSearchHits([
      makeHit({
        snippet: 'class Auth {\n  verify() {\n    return this.token != null\n  }\n}',
        range: { startLine: 20, endLine: 24 }
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

describe('formatMcpGrepHits keeps its single-line ↩-joined format', () => {
  it('flattens the snippet with the ↩ arrow and trims each line (unchanged from search-hit rendering)', () => {
    const hit: GrepHit = {
      file: 'src/auth.ts',
      range: { startLine: 10, endLine: 12 },
      line: 10,
      column: 3,
      match: 'verify',
      snippet: 'function verify() {\n  return true\n}'
    }
    expect(formatMcpGrepHits([hit])).toBe('src/auth.ts:10-12:3 | function verify() { ↩ return true ↩ }')
  })

  it('returns no_matches for an empty result set', () => {
    expect(formatMcpGrepHits([])).toBe('no_matches')
  })
})

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
