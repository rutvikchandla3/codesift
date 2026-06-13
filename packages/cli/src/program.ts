import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Command } from 'commander'

import { openRepo, type RepoStatus, type SearchHit, type SymbolDefinition } from '@codesift/core'
import { createHttpServer, createStdioServer, getToolDefinitions } from '@codesift/mcp'

export interface CliIo {
  stdout(message: string): void
  stderr(message: string): void
}

const defaultIo: CliIo = {
  stdout(message) {
    process.stdout.write(`${message}\n`)
  },
  stderr(message) {
    process.stderr.write(`${message}\n`)
  }
}

export function formatStatus(status: RepoStatus): string {
  return [
    `root: ${status.root}`,
    `index: ${status.indexPath}`,
    `indexed: ${status.indexed ? 'yes' : 'no'}`,
    `stale: ${status.stale ? 'yes' : 'no'}`,
    `chunks: ${status.chunkCount}`,
    `symbols: ${status.symbolCount}`,
    `provider: ${status.provider?.id ?? 'unconfigured'}`
  ].join('\n')
}

export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) {
    return 'No hits yet. The search pipeline lands in M1.'
  }

  return hits
    .map((hit) => {
      const range = `${hit.range.startLine}-${hit.range.endLine}`
      const symbol = hit.symbol ? ` · ${hit.symbol}` : ''
      return `${hit.file}:${range}${symbol}\n${hit.snippet}`
    })
    .join('\n\n')
}

export function formatSymbols(definitions: SymbolDefinition[]): string {
  if (definitions.length === 0) {
    return 'No symbol matches yet. Symbol indexing lands in M2.'
  }

  return definitions
    .map((definition) => {
      const range = `${definition.range.startLine}-${definition.range.endLine}`
      return `${definition.kind} ${definition.name} — ${definition.file}:${range}`
    })
    .join('\n')
}

export async function runCli(argv = process.argv, io: CliIo = defaultIo): Promise<void> {
  const program = new Command()

  program
    .name('codesift')
    .description('Local-first hybrid code search for CLI, SDK, and MCP.')
    .version('0.0.0')

  program
    .command('index')
    .argument('[path]', 'repository path', process.cwd())
    .option('--rebuild', 'force a full rebuild')
    .option('--watch', 'watch for filesystem changes')
    .action(async (path: string, options: { rebuild?: boolean; watch?: boolean }) => {
      const repo = await openRepo(path)
      const result = await repo.sync(options.rebuild ? { rebuild: true } : undefined)

      io.stdout(`Scaffold only: indexed ${result.indexedFiles} files in ${repo.root}.`)
      if (options.watch) {
        io.stdout('Watch mode is reserved for M4.')
      }
    })

  program
    .command('search')
    .argument('<query>', 'natural language or symbol-aware query')
    .option('-k, --k <count>', 'number of hits', '10')
    .option('--json', 'print JSON results')
    .action(async (query: string, options: { k: string; json?: boolean }) => {
      const repo = await openRepo(process.cwd())
      const hits = await repo.search(query, { k: Number(options.k) })

      io.stdout(options.json ? JSON.stringify(hits, null, 2) : formatHits(hits))
    })

  program
    .command('sym')
    .argument('<name>', 'symbol name to find')
    .action(async (name: string) => {
      const repo = await openRepo(process.cwd())
      const definitions = await repo.findSymbol(name)
      io.stdout(formatSymbols(definitions))
    })

  program
    .command('mcp')
    .argument('[path]', 'repository path', process.cwd())
    .action(async (path: string) => {
      const repo = await openRepo(path)
      const server = createStdioServer(repo)
      await server.start()
      io.stdout(`Scaffold MCP ready with tools: ${getToolDefinitions().map((tool) => tool.name).join(', ')}`)
    })

  program
    .command('serve')
    .argument('[path]', 'repository path', process.cwd())
    .option('--host <host>', 'bind host', '127.0.0.1')
    .option('--port <port>', 'bind port', '7345')
    .option('--token <token>', 'optional bearer token')
    .action(async (path: string, options: { host: string; port: string; token?: string }) => {
      const repo = await openRepo(path)
      const server = createHttpServer(repo, {
        host: options.host,
        port: Number(options.port),
        ...(options.token ? { token: options.token } : {})
      })

      await server.start()
      io.stdout(`Scaffold HTTP server ready on ${options.host}:${options.port}.`)
    })

  program
    .command('status')
    .argument('[path]', 'repository path', process.cwd())
    .option('--json', 'print JSON status')
    .action(async (path: string, options: { json?: boolean }) => {
      const repo = await openRepo(path)
      const status = await repo.status()
      io.stdout(options.json ? JSON.stringify(status, null, 2) : formatStatus(status))
    })

  program
    .command('config')
    .argument('[action]', 'get or set')
    .argument('[key]')
    .argument('[value]')
    .action((_action?: string, _key?: string, _value?: string) => {
      io.stdout('Configuration management is scaffolded and will land with provider support in M5.')
    })

  program
    .command('clean')
    .argument('[path]', 'repository path', process.cwd())
    .action(async (path: string) => {
      const target = resolve(path, '.codesift')
      await rm(target, { recursive: true, force: true })
      io.stdout(`Removed ${target}`)
    })

  await program.parseAsync(argv)
}
