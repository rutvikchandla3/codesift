import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import { type Repo } from '@codesift/core'

import { createSdkServer, getToolDefinitions, type HttpServerOptions, type McpServerHandle, type McpToolDefinition } from './index.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 7345

/**
 * Real streamable HTTP MCP server backed by a node:http listener that delegates to the SDK's
 * StreamableHTTPServerTransport in stateless mode. Each request gets a fresh transport + server
 * wrapping the same createSdkServer tool registry used by the stdio transport.
 */
export class HttpMcpServerHandle implements McpServerHandle {
  readonly transport = 'http' as const

  private readonly host: string
  private readonly requestedPort: number
  private readonly token: string | undefined
  private readonly expectedTokenDigest: Buffer | undefined
  private server: Server | undefined

  constructor(
    private readonly repo: Repo,
    readonly options: HttpServerOptions = {}
  ) {
    this.host = options.host ?? DEFAULT_HOST
    this.requestedPort = options.port ?? DEFAULT_PORT
    this.token = options.token
    this.expectedTokenDigest = this.token ? sha256(this.token) : undefined
  }

  get tools(): readonly McpToolDefinition[] {
    return getToolDefinitions()
  }

  /** Whether a bearer token is required for every request. */
  get requiresToken(): boolean {
    return this.token !== undefined
  }

  /** The actually-bound address once start() has resolved, or undefined before listening. */
  get address(): { host: string; port: number } | undefined {
    const address = this.server?.address()
    if (address === null || address === undefined || typeof address === 'string') {
      return undefined
    }

    return { host: address.address, port: address.port }
  }

  /** The actually-bound port once start() has resolved (supports ephemeral port 0). */
  get port(): number | undefined {
    return this.address?.port
  }

  async start(): Promise<void> {
    if (this.server) {
      return
    }

    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        log(`request handling failed: ${describeError(error)}`)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify(jsonRpcError(-32603, 'Internal server error')))
        }
      })
    })

    this.server = server

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server = undefined
        reject(error)
      }

      server.once('error', onError)
      server.listen(this.requestedPort, this.host, () => {
        server.removeListener('error', onError)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) {
      return
    }

    this.server = undefined
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorize(req)) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="codesift"'
      })
      res.end(JSON.stringify(jsonRpcError(-32001, 'Unauthorized')))
      return
    }

    // Stateless mode: every request uses a fresh transport + server. Reusing a stateless
    // transport across requests throws in the SDK (message id collisions), so we create and
    // tear down per request. This wraps the SAME createSdkServer tool registry as stdio.
    const server = createSdkServer(this.repo)
    // Stateless: omit sessionIdGenerator entirely (passing `undefined` violates
    // exactOptionalPropertyTypes; an absent key is the same `undefined` at runtime).
    const transport = new StreamableHTTPServerTransport({})

    res.on('close', () => {
      void transport.close()
      void server.close()
    })

    try {
      // The SDK declares the transport's `onclose` getter as `(() => void) | undefined`,
      // which is not assignable to Transport's exact-optional `onclose?` under
      // exactOptionalPropertyTypes. The assertion bridges that upstream type friction;
      // the class genuinely implements Transport.
      await server.connect(transport as Transport)
      await transport.handleRequest(req, res)
    } catch (error) {
      log(`mcp request failed: ${describeError(error)}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify(jsonRpcError(-32603, 'Internal server error')))
      }
    }
  }

  private authorize(req: IncomingMessage): boolean {
    if (this.expectedTokenDigest === undefined) {
      return true
    }

    const provided = extractBearerToken(req.headers.authorization)
    if (provided === undefined) {
      return false
    }

    // Compare fixed-length sha256 digests so timingSafeEqual never sees unequal-length buffers
    // and the comparison cost does not leak the token length via an early return.
    return timingSafeEqual(sha256(provided), this.expectedTokenDigest)
  }
}

export function createHttpServerHandle(repo: Repo, options: HttpServerOptions = {}): HttpMcpServerHandle {
  return new HttpMcpServerHandle(repo, options)
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined
  }

  const match = /^Bearer (.+)$/.exec(header.trim())
  return match ? match[1] : undefined
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function jsonRpcError(code: number, message: string): { jsonrpc: '2.0'; id: null; error: { code: number; message: string } } {
  return { jsonrpc: '2.0', id: null, error: { code, message } }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }

  return String(error)
}

function log(message: string): void {
  process.stderr.write(`codesift mcp http: ${message}\n`)
}
