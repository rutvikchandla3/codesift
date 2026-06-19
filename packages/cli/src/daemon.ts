import { createServer, type Server, type Socket } from 'node:net'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { handleMcpJsonRpcRequest, type McpJsonRpcRequest } from '@codesift/mcp'
import { openRepo, type Repo, type StopWatching } from '@codesift/core'

import { getDefaultDaemonSocketPath } from './daemon-path.js'

interface DaemonEnvelope {
  repoRoot?: string
  message?: unknown
}

const DEFAULT_DAEMON_IDLE_MS = 5 * 60 * 1000

export interface RepoCache {
  getRepo(root: string): Promise<Repo>
  stopAll(): Promise<void>
}

/**
 * Cache one Repo per root and keep each one's index fresh by attaching
 * Repo.watch() the first time a root is opened. watch() is fire-and-forget (it
 * scans the manifest, so awaiting it would stall the request) and its stop
 * handle is retained for clean shutdown. `open` is injectable for tests.
 */
export function createRepoCache(open: (root: string) => Promise<Repo> = openRepo): RepoCache {
  const repos = new Map<string, Repo>()
  const watchers = new Map<string, StopWatching>()

  const getRepo = async (root: string): Promise<Repo> => {
    const repoRoot = resolve(root)
    const existing = repos.get(repoRoot)
    if (existing) {
      return existing
    }

    const repo = await open(repoRoot)
    repos.set(repoRoot, repo)
    // Do NOT await: watch() scans the manifest before returning its stop handle.
    void repo
      .watch()
      .then((stop) => {
        watchers.set(repoRoot, stop)
      })
      .catch(() => {
        // A watch failure must never take down the daemon; queries still work,
        // they just fall back to the existing markStaleHits backstop.
      })
    return repo
  }

  const stopAll = async (): Promise<void> => {
    const stops = [...watchers.values()]
    watchers.clear()
    repos.clear()
    await Promise.all(stops.map((stop) => stop().catch(() => {})))
  }

  return { getRepo, stopAll }
}

export async function runDaemon(argv = process.argv): Promise<void> {
  const socketPath = readOption(argv, '--socket') ?? process.env.CODESIFT_DAEMON_SOCKET ?? getDefaultDaemonSocketPath()
  const idleMs = readNumberOption(argv, '--idle-ms') ?? readNumberEnv('CODESIFT_DAEMON_IDLE_MS') ?? DEFAULT_DAEMON_IDLE_MS
  await startDaemon(socketPath, idleMs)
}

async function startDaemon(socketPath: string, idleMs: number): Promise<void> {
  const cache = createRepoCache()
  const getRepo = cache.getRepo
  let activeSockets = 0
  let idleTimer: NodeJS.Timeout | undefined
  let server: Server

  const resetIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }

    if (idleMs > 0 && activeSockets === 0) {
      idleTimer = setTimeout(() => {
        void cache.stopAll().finally(() => {
          server.close(() => process.exit(0))
        })
      }, idleMs)
      idleTimer.unref()
    }
  }

  server = createServer((socket) => {
    activeSockets += 1
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }

    handleSocket(socket, getRepo).finally(() => {
      activeSockets = Math.max(0, activeSockets - 1)
      resetIdleTimer()
    })
  })

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      process.exit(0)
    }

    process.stderr.write(`codesift daemon error: ${error.message}\n`)
    process.exit(1)
  })

  if (process.platform !== 'win32' && existsSync(socketPath)) {
    await rm(socketPath, { force: true })
  }

  await new Promise<void>((resolvePromise, reject) => {
    server.once('listening', resolvePromise)
    server.once('error', reject)
    server.listen(socketPath)
  })

  process.stderr.write(`codesift daemon listening on ${socketPath}\n`)
  resetIdleTimer()
}

async function handleSocket(socket: Socket, getRepo: (root: string) => Promise<Repo>): Promise<void> {
  socket.setEncoding('utf8')
  let buffer = ''
  let chain = Promise.resolve()

  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newlineIndex = buffer.indexOf('\n')

    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (line) {
        chain = chain.then(() => handleLine(socket, line, getRepo))
      }
      newlineIndex = buffer.indexOf('\n')
    }
  })

  await new Promise<void>((resolvePromise) => {
    socket.once('close', resolvePromise)
    socket.once('end', resolvePromise)
  })

  await chain.catch(() => undefined)
}

async function handleLine(socket: Socket, line: string, getRepo: (root: string) => Promise<Repo>): Promise<void> {
  try {
    const envelope = JSON.parse(line) as DaemonEnvelope
    if (!envelope.repoRoot || !envelope.message) {
      socket.write(`${JSON.stringify({ error: 'invalid daemon request' })}\n`)
      return
    }

    const repo = await getRepo(envelope.repoRoot)
    const response = await handleMcpJsonRpcRequest(repo, envelope.message as McpJsonRpcRequest)
    socket.write(`${JSON.stringify({ response })}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    socket.write(`${JSON.stringify({ error: message })}\n`)
  }
}

function readOption(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index < 0) {
    return undefined
  }

  return argv[index + 1]
}

function readNumberOption(argv: string[], name: string): number | undefined {
  const value = readOption(argv, name)
  if (!value) {
    return undefined
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function readNumberEnv(name: string): number | undefined {
  const value = process.env[name]
  if (!value) {
    return undefined
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}
