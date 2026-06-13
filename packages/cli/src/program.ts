import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Command } from 'commander'

import {
  DEFAULT_SEARCH_K,
  IndexCompatibilityError,
  getDefaultEmbeddingProvider,
  isLearnedEmbeddingProvider,
  openRepo,
  type GrepHit,
  type GrepOptions,
  type RepoStatus,
  type SearchHit,
  type SymbolDefinition,
  type SymbolKind
} from '@codesift/core'
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

export function getCliDescription(): string {
  const provider = getDefaultEmbeddingProvider()
  return isLearnedEmbeddingProvider(provider)
    ? 'Local-first hybrid lexical + semantic code search for CLI, SDK, and MCP.'
    : 'Local-first lexical code search for CLI, SDK, and MCP.'
}

export function formatStatus(status: RepoStatus): string {
  return [
    `root: ${status.root}`,
    `index: ${status.indexPath}`,
    `indexed: ${status.indexed ? 'yes' : 'no'}`,
    `stale: ${status.stale ? 'yes' : 'no'}`,
    `chunks: ${status.chunkCount}`,
    `symbols: ${status.symbolCount}`,
    `generation: ${status.indexGeneration}`,
    `provider: ${status.provider?.id ?? 'unconfigured'}`,
    `compatibility: ${formatCompatibilityStatus(status)}`,
    `vector: ${formatVectorStatus(status)}`
  ].join('\n')
}

export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) {
    return 'No hits found.'
  }

  return hits
    .map((hit) => {
      const range = `${hit.range.startLine}-${hit.range.endLine}`
      const symbol = hit.symbol ? ` · ${hit.symbol}` : ''
      return `${hit.file}:${range}${symbol} · ${hit.reason} score=${hit.score.toFixed(4)}\n${hit.snippet}`
    })
    .join('\n\n')
}

export function formatCompactHits(hits: SearchHit[]): string {
  if (hits.length === 0) {
    return 'No hits found.'
  }

  return hits
    .map((hit) => {
      const symbol = hit.symbol ? ` · ${hit.symbol}` : ''
      const snippet = hit.snippet
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(' ↩ ')

      return `${hit.reason} ${formatChunkId(hit.id)}${symbol}${snippet ? ` | ${snippet}` : ''}`
    })
    .join('\n')
}

export function formatChunkId(id: string): string {
  return id.replace(/@[a-f0-9]{8,64}$/i, '')
}

export function formatSymbols(definitions: SymbolDefinition[]): string {
  if (definitions.length === 0) {
    return 'No symbol matches found.'
  }

  return definitions
    .map((definition) => {
      const range = `${definition.range.startLine}-${definition.range.endLine}`
      return `${definition.kind} ${definition.name} — ${definition.file}:${range}`
    })
    .join('\n')
}

export function formatGrepHits(hits: GrepHit[]): string {
  if (hits.length === 0) {
    return 'No matches found.'
  }

  return hits
    .map((hit) => {
      const range = hit.range.startLine === hit.range.endLine ? String(hit.range.startLine) : `${hit.range.startLine}-${hit.range.endLine}`
      return `${hit.file}:${range}:${hit.column}\n${hit.snippet}`
    })
    .join('\n\n')
}

export function formatCompactGrepHits(hits: GrepHit[]): string {
  if (hits.length === 0) {
    return 'No matches found.'
  }

  return hits
    .map((hit) => {
      const range = hit.range.startLine === hit.range.endLine ? String(hit.range.startLine) : `${hit.range.startLine}-${hit.range.endLine}`
      const snippet = hit.snippet
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 4)
        .join(' ↩ ')
      return `${hit.file}:${range}:${hit.column}${snippet ? ` | ${snippet}` : ''}`
    })
    .join('\n')
}

function formatCompatibilityStatus(status: RepoStatus): string {
  if (status.compatibility.ok) {
    return 'ok'
  }

  return status.compatibility.message ?? 'rebuild required'
}

function formatVectorStatus(status: RepoStatus): string {
  const detail = status.vectorSearch.detail ? ` — ${status.vectorSearch.detail}` : ''

  if (status.vectorSearch.state === 'unavailable') {
    return `${status.vectorSearch.state} (${status.vectorSearch.message ?? 'unknown error'}${detail})`
  }

  return status.vectorSearch.state
}

function parseCsvList(value?: string): string[] | undefined {
  if (!value) {
    return undefined
  }

  const values = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  return values.length > 0 ? values : undefined
}

async function withCompatibilityHandling(io: CliIo, action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (error instanceof IndexCompatibilityError) {
      io.stderr(error.message)
      return
    }

    throw error
  }
}

export async function runCli(argv = process.argv, io: CliIo = defaultIo): Promise<void> {
  const program = new Command()

  program.name('codesift').description(getCliDescription()).version('0.0.0')

  program
    .command('index')
    .argument('[path]', 'repository path', process.cwd())
    .option('--rebuild', 'force a full rebuild')
    .option('--watch', 'watch for filesystem changes')
    .action(async (path: string, options: { rebuild?: boolean; watch?: boolean }) => {
      const repo = await openRepo(path)
      const result = await repo.sync(options.rebuild ? { rebuild: true } : undefined)

      io.stdout(
        `Indexed ${result.indexedFiles} files (${result.skippedFiles} skipped, ${result.skippedSymlinks} symlink skips) in ${result.durationMs}ms at ${repo.root}.`
      )
      if (options.watch) {
        io.stdout('Watch mode is reserved for M4.')
      }
    })

  program
    .command('search')
    .argument('<query>', 'natural language or symbol-aware query')
    .option('-k, --k <count>', 'number of hits', String(DEFAULT_SEARCH_K))
    .option('--repo <path>', 'repository path', process.cwd())
    .option('--lang <langs>', 'comma-separated language filter, e.g. ts,typescript,python')
    .option('--path <glob>', 'path glob filter, e.g. src/**')
    .option('--kind <kind>', 'symbol kind filter for matching chunks')
    .option('--max-tokens <tokens>', 'token budget for compact snippets')
    .option('--json', 'print JSON results')
    .option('--compact', 'print token-efficient compact results')
    .action(
      async (
        query: string,
        options: { k: string; repo: string; lang?: string; path?: string; kind?: string; maxTokens?: string; json?: boolean; compact?: boolean }
      ) => {
        await withCompatibilityHandling(io, async () => {
          const repo = await openRepo(options.repo)
          const languages = parseCsvList(options.lang)
          const searchOptions: {
            k: number
            lang?: string[]
            pathGlob?: string
            kind?: SymbolKind
            maxTokens?: number
          } = {
            k: Number(options.k)
          }

          if (languages) {
            searchOptions.lang = languages
          }

          if (options.path) {
            searchOptions.pathGlob = options.path
          }

          if (options.kind) {
            searchOptions.kind = options.kind as SymbolKind
          }

          if (options.maxTokens !== undefined) {
            searchOptions.maxTokens = Number(options.maxTokens)
          }

          const hits = await repo.search(query, searchOptions)
          const output = options.json ? JSON.stringify(hits, null, 2) : options.compact ? formatCompactHits(hits) : formatHits(hits)
          const status = await repo.status()

          io.stdout(output)

          if (status.vectorSearch.state === 'unavailable' && status.vectorSearch.message) {
            io.stderr(formatVectorStatus(status))
          }
        })
      }
    )

  program
    .command('sym')
    .argument('<name>', 'symbol name to find')
    .option('--repo <path>', 'repository path', process.cwd())
    .option('--path <glob>', 'path glob filter, e.g. src/**')
    .option('--kind <kind>', 'symbol kind filter')
    .action(async (name: string, options: { repo: string; path?: string; kind?: string }) => {
      await withCompatibilityHandling(io, async () => {
        const repo = await openRepo(options.repo)
        const findOptions: {
          pathGlob?: string
          kind?: SymbolKind
        } = {}

        if (options.path) {
          findOptions.pathGlob = options.path
        }

        if (options.kind) {
          findOptions.kind = options.kind as SymbolKind
        }

        const definitions = await repo.findSymbol(name, findOptions)
        io.stdout(formatSymbols(definitions))
      })
    })

  program
    .command('grep')
    .argument('[pattern]', 'literal pattern to search for')
    .option('-e, --regexp <pattern>', 'pattern to search for (ripgrep-compatible spelling)')
    .option('--regex', 'treat the pattern as a regular expression')
    .option('-i, --ignore-case', 'case-insensitive matching')
    .option('-w, --word-regexp', 'match whole words only')
    .option('--multiline', 'allow regex dot to span newlines')
    .option('-A, --after-context <lines>', 'lines after each match')
    .option('-B, --before-context <lines>', 'lines before each match')
    .option('-C, --context <lines>', 'lines before and after each match')
    .option('--repo <path>', 'repository path', process.cwd())
    .option('--lang <langs>', 'comma-separated language filter, e.g. ts,typescript,python')
    .option('--path <glob>', 'path glob filter, e.g. src/**')
    .option('--max-matches <count>', 'maximum matches to print')
    .option('--json', 'print JSON results')
    .option('--compact', 'print token-efficient compact results')
    .action(
      async (
        patternArgument: string | undefined,
        options: {
          regexp?: string
          regex?: boolean
          ignoreCase?: boolean
          wordRegexp?: boolean
          multiline?: boolean
          afterContext?: string
          beforeContext?: string
          context?: string
          repo: string
          lang?: string
          path?: string
          maxMatches?: string
          json?: boolean
          compact?: boolean
        }
      ) => {
        await withCompatibilityHandling(io, async () => {
          const pattern = options.regexp ?? patternArgument
          if (!pattern) {
            throw new Error('grep requires a pattern argument or -e <pattern>')
          }

          const repo = await openRepo(options.repo)
          const languages = parseCsvList(options.lang)
          const grepOptions: GrepOptions = {}

          if (options.regex) {
            grepOptions.regex = true
          }
          if (options.ignoreCase) {
            grepOptions.ignoreCase = true
          }
          if (options.wordRegexp) {
            grepOptions.wholeWord = true
          }
          if (options.multiline) {
            grepOptions.multiline = true
          }
          if (languages) {
            grepOptions.lang = languages
          }
          if (options.path) {
            grepOptions.pathGlob = options.path
          }
          if (options.context !== undefined) {
            grepOptions.contextLines = Number(options.context)
          }
          if (options.beforeContext !== undefined) {
            grepOptions.beforeContextLines = Number(options.beforeContext)
          }
          if (options.afterContext !== undefined) {
            grepOptions.afterContextLines = Number(options.afterContext)
          }
          if (options.maxMatches !== undefined) {
            grepOptions.maxMatches = Number(options.maxMatches)
          }

          const hits = await repo.grep(pattern, grepOptions)
          const output = options.json ? JSON.stringify(hits, null, 2) : options.compact ? formatCompactGrepHits(hits) : formatGrepHits(hits)
          io.stdout(output)
        })
      }
    )

  program
    .command('mcp')
    .argument('[path]', 'repository path', process.cwd())
    .action(async (path: string) => {
      const repo = await openRepo(path)
      const server = createStdioServer(repo)
      await server.start()
      io.stderr(`MCP ready with tools: ${getToolDefinitions().map((tool) => tool.name).join(', ')}`)
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
