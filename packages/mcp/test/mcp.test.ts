import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openRepo, registerEmbeddingProvider } from '@codesift/core'

import {
  DEFAULT_SEARCH_K,
  MCP_SERVER_INSTRUCTIONS,
  createHttpServer,
  createRouter,
  createStdioServer,
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
    expect(MCP_SERVER_INSTRUCTIONS).toContain('use grep_code for literal strings')
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
    const hits = await router.searchCode({ query: 'demoValue', k: 1 })

    const grepHits = await router.grepCode({ pattern: "return 'demo'", path_glob: 'src/**' })

    expect(hits[0]?.file).toBe('src/demo.ts')
    expect(await router.findSymbol({ name: 'demoValue' })).toHaveLength(1)
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

    const child = spawn(process.execPath, [join(process.cwd(), 'packages/cli/dist/bin.js'), 'mcp', repoRoot], {
      stdio: ['pipe', 'pipe', 'pipe']
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
