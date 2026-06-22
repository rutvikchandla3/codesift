import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { resolve } from 'node:path'

import { findRepoRoot } from '@codesift/core'
import { MCP_TOOL_NAMES } from '@codesift/mcp'

import { getDefaultDaemonSocketPath } from './daemon-path.js'

interface DaemonReply {
  response?: unknown
  error?: string
}

const DAEMON_CONNECT_TIMEOUT_MS = 3000

export async function runMcpShim(argv = process.argv): Promise<void> {
  const explicitPath = readPathArgument(argv)
  const repoRoot = explicitPath ? resolve(explicitPath) : await findRepoRoot(process.cwd())
  const socketPath = process.env.CODESIFT_DAEMON_SOCKET ?? getDefaultDaemonSocketPath()

  await ensureDaemon(socketPath)
  process.stderr.write(`MCP ready with tools: ${MCP_TOOL_NAMES.join(', ')}\n`)

  process.stdin.setEncoding('utf8')
  let buffer = ''
  let chain = Promise.resolve()

  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    let newlineIndex = buffer.indexOf('\n')

    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (line) {
        chain = chain.then(() => forwardLine(socketPath, repoRoot, line)).catch((error: unknown) => {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        })
      }
      newlineIndex = buffer.indexOf('\n')
    }
  })

  await new Promise<void>((resolvePromise) => {
    process.stdin.once('end', resolvePromise)
    process.stdin.once('close', resolvePromise)
  })

  await chain
}

function readPathArgument(argv: string[]): string | undefined {
  const args = argv.slice(3).filter((arg) => !arg.startsWith('--'))
  return args[0]
}

async function ensureDaemon(socketPath: string): Promise<void> {
  if (await canConnect(socketPath)) {
    return
  }

  const child = spawn(process.execPath, [process.argv[1]!, 'daemon', '--socket', socketPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env
  })
  child.unref()

  const startedAt = Date.now()
  while (Date.now() - startedAt < DAEMON_CONNECT_TIMEOUT_MS) {
    if (await canConnect(socketPath)) {
      return
    }

    await sleep(50)
  }

  throw new Error('Timed out starting codesift daemon')
}

async function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection(socketPath)
    const done = (ok: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolvePromise(ok)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(300, () => done(false))
  })
}

async function forwardLine(socketPath: string, repoRoot: string, line: string): Promise<void> {
  const reply = await requestDaemon(socketPath, { repoRoot, message: JSON.parse(line) })
  if (reply.error) {
    throw new Error(reply.error)
  }

  if (reply.response !== null && reply.response !== undefined) {
    process.stdout.write(`${JSON.stringify(reply.response)}\n`)
  }
}

async function requestDaemon(socketPath: string, payload: unknown): Promise<DaemonReply> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    let settled = false

    const settle = (callback: () => void) => {
      if (settled) {
        return
      }

      settled = true
      socket.removeAllListeners()
      socket.destroy()
      callback()
    }

    socket.setEncoding('utf8')
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`)
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex < 0) {
        return
      }

      const line = buffer.slice(0, newlineIndex).trim()
      settle(() => {
        try {
          resolvePromise(JSON.parse(line) as DaemonReply)
        } catch (error) {
          reject(error)
        }
      })
    })
    socket.once('error', (error) => settle(() => reject(error)))
    socket.setTimeout(DAEMON_CONNECT_TIMEOUT_MS, () => settle(() => reject(new Error('Timed out waiting for codesift daemon'))))
  })
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
