import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openRepo } from '@codesift/core'

import { HttpMcpServerHandle, NOT_INDEXED_SENTINEL, createHttpServer } from '../src/index.js'

const PROTOCOL_VERSION = '2025-06-18'
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true })
    })
  )
})

describe('@codesift/mcp http transport', () => {
  it('serves a real streamable-HTTP initialize -> tools/list -> tools/call round-trip', async () => {
    const repoRoot = await createDemoRepo()
    const repo = await openRepo(repoRoot)
    await repo.sync()

    const handle = createHttpServer(repo, { port: 0 }) as HttpMcpServerHandle
    await handle.start()

    try {
      expect(handle.transport).toBe('http')
      expect(handle.requiresToken).toBe(false)
      const port = handle.port
      expect(typeof port).toBe('number')
      expect(handle.address?.host).toBe('127.0.0.1')

      const base = `http://127.0.0.1:${port}/`

      const initialize = await mcpCall(base, undefined, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'codesift-vitest-http', version: '0.0.0' }
        }
      })
      expect(initialize.status).toBe(200)
      expect(JSON.stringify(initialize.message.result)).toContain('codesift')

      const list = await mcpCall(base, undefined, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      })
      expect(list.status).toBe(200)
      expect(JSON.stringify(list.message.result)).toContain('search_code')

      const call = await mcpCall(base, undefined, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'search_code', arguments: { query: 'demoValue', k: 1 } }
      })
      expect(call.status).toBe(200)
      const callText = JSON.stringify(call.message.result)
      expect(callText).toContain('content')
      expect(callText).toContain('src/demo.ts')
    } finally {
      await handle.stop()
    }
  }, 15_000)

  it('enforces a bearer token when configured', async () => {
    const repoRoot = await createDemoRepo()
    const repo = await openRepo(repoRoot)
    await repo.sync()

    const token = 'super-secret-token-value'
    const handle = createHttpServer(repo, { port: 0, token }) as HttpMcpServerHandle
    await handle.start()

    try {
      expect(handle.requiresToken).toBe(true)
      const base = `http://127.0.0.1:${handle.port}/`

      const initialize = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'codesift-vitest-http', version: '0.0.0' }
        }
      }

      const missing = await rawPost(base, undefined, initialize)
      expect(missing.status).toBe(401)

      const wrong = await rawPost(base, 'Bearer not-the-token', initialize)
      expect(wrong.status).toBe(401)

      const wrongScheme = await rawPost(base, token, initialize)
      expect(wrongScheme.status).toBe(401)

      const ok = await mcpCall(base, `Bearer ${token}`, initialize)
      expect(ok.status).toBe(200)
      expect(JSON.stringify(ok.message.result)).toContain('codesift')
    } finally {
      await handle.stop()
    }
  }, 15_000)

  it('returns the not-indexed sentinel through the SDK server path', async () => {
    const repoRoot = await createDemoRepo()
    const repo = await openRepo(repoRoot)
    const handle = createHttpServer(repo, { port: 0 }) as HttpMcpServerHandle
    await handle.start()

    try {
      const base = `http://127.0.0.1:${handle.port}/`
      const initialize = await mcpCall(base, undefined, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'codesift-vitest-http', version: '0.0.0' }
        }
      })
      expect(initialize.status).toBe(200)

      const call = await mcpCall(base, undefined, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_chunk', arguments: { id: 'src/demo.ts:1-2@missing' } }
      })

      expect(call.status).toBe(200)
      expect(JSON.stringify(call.message.result)).toContain(NOT_INDEXED_SENTINEL)
      expect(JSON.stringify(call.message.result)).not.toContain('isError')
    } finally {
      await handle.stop()
    }
  }, 15_000)
})

async function createDemoRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-mcp-http-'))
  temporaryDirectories.push(repoRoot)
  await mkdir(join(repoRoot, 'src'), { recursive: true })
  await writeFile(
    join(repoRoot, 'src', 'demo.ts'),
    `export function demoValue(): string {\n  return 'demo'\n}\n`,
    'utf8'
  )
  return repoRoot
}

interface JsonRpcMessage {
  jsonrpc: string
  id?: string | number | null
  result?: unknown
  error?: unknown
}

async function rawPost(base: string, authorization: string | undefined, body: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION
  }
  if (authorization !== undefined) {
    headers.authorization = authorization
  }

  return globalThis.fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
}

async function mcpCall(
  base: string,
  authorization: string | undefined,
  body: unknown
): Promise<{ status: number; message: JsonRpcMessage }> {
  const response = await rawPost(base, authorization, body)
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text()
  const message = contentType.includes('text/event-stream')
    ? parseSseJsonRpc(text)
    : (JSON.parse(text) as JsonRpcMessage)
  return { status: response.status, message }
}

function parseSseJsonRpc(payload: string): JsonRpcMessage {
  // SSE frames are separated by a blank line; each "data:" line carries a JSON-RPC message.
  // Return the first frame that parses to a JSON-RPC response with our id/result/error.
  for (const frame of payload.split(/\r?\n\r?\n/)) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())

    if (dataLines.length === 0) {
      continue
    }

    const data = dataLines.join('\n')
    if (!data) {
      continue
    }

    try {
      return JSON.parse(data) as JsonRpcMessage
    } catch {
      continue
    }
  }

  throw new Error(`no JSON-RPC message found in SSE payload: ${payload}`)
}
