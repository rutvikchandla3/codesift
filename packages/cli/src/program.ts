import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Command } from 'commander'

import {
  DEFAULT_SEARCH_K,
  IndexCompatibilityError,
  getDefaultEmbeddingProvider,
  isLearnedEmbeddingProvider,
  openRepo,
  readConfig,
  setConfigValue,
  type GrepHit,
  type GrepOptions,
  type RepoStatus,
  type SearchHit,
  type SymbolDefinition,
  type SymbolKind,
  type SyncOptions
} from '@codesift/core'
import { createHttpServerHandle, createStdioServer, getToolDefinitions } from '@codesift/mcp'

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
    ...(status.staleReasons?.length ? [`stale reasons: ${status.staleReasons.map((reason) => reason.message).join('; ')}`] : []),
    `sync: ${formatSyncStatus(status)}`,
    `chunks: ${status.chunkCount}`,
    `symbols: ${status.symbolCount}`,
    `generated files: ${status.generatedFileCount}`,
    `generated chunks: ${status.generatedChunkCount}`,
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
      const symbol = formatHitSymbol(hit)
      const generated = hit.generated ? ' · generated' : ''
      const stale = hit.stale ? ' · stale' : ''
      const primary = `${hit.file}:${range}${symbol}${generated}${stale} · ${hit.reason} score=${hit.score.toFixed(4)}\n${hit.body ?? hit.snippet}`
      if (!hit.usages?.length) {
        return primary
      }

      const usages = ['usages (import-resolved):', ...hit.usages.map((usage) => `- ${usage.file}:${usage.line} | ${usage.snippet}`)].join('\n')
      return `${primary}\n${usages}`
    })
    .join('\n\n')
}

export function formatCompactHits(hits: SearchHit[]): string {
  if (hits.length === 0) {
    return 'No hits found.'
  }

  return hits
    .map((hit) => {
      const symbol = formatHitSymbol(hit)
      const generated = hit.generated ? ' [generated]' : ''
      const stale = hit.stale ? ' [stale]' : ''
      const snippet = (hit.body ?? hit.snippet)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(' ↩ ')
      const usages = hit.usages?.length ? ` | usages=${hit.usages.map((usage) => `${usage.file}:${usage.line}`).join(', ')}` : ''

      return `${hit.reason} ${formatChunkId(hit.id)}${symbol}${generated}${stale}${snippet ? ` | ${snippet}` : ''}${usages}`
    })
    .join('\n')
}

export function formatChunkId(id: string): string {
  return id.replace(/@[a-f0-9]{8,64}$/i, '')
}

function formatHitSymbol(hit: SearchHit): string {
  if (!hit.symbol) {
    return ''
  }

  return ` · ${[hit.parent, hit.symbol].filter(Boolean).join(' > ')}`
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

function formatSyncStatus(status: RepoStatus): string {
  const sync = status.sync
  const timestamp = sync.completedAt ?? sync.startedAt
  const error = sync.error ? ` — ${sync.error}` : ''
  return `${sync.state}${timestamp ? ` (${timestamp})` : ''}${error}`
}

function formatVectorStatus(status: RepoStatus): string {
  const detail = status.vectorSearch.detail ? ` — ${status.vectorSearch.detail}` : ''

  if (status.vectorSearch.state === 'unavailable') {
    return `${status.vectorSearch.state} (${status.vectorSearch.message ?? 'unknown error'}${detail})`
  }

  return status.vectorSearch.state
}

function formatConfigValue(value: unknown): string {
  return Array.isArray(value) ? value.join(',') : String(value)
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

async function waitForTermination(stop: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stopping = false
    const shutdown = () => {
      if (stopping) {
        return
      }

      stopping = true
      process.off('SIGINT', shutdown)
      process.off('SIGTERM', shutdown)
      stop().then(resolve, reject)
    }

    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}

export async function runCli(argv = process.argv, io: CliIo = defaultIo): Promise<void> {
  const program = new Command()

  program.name('codesift').description(getCliDescription()).version('0.0.0')

  program
    .command('index')
    .argument('[path]', 'repository path', process.cwd())
    .option('--rebuild', 'force a full rebuild')
    .option('--watch', 'watch for filesystem changes')
    .option('--allow-secrets', 'permit cloud embedding of secret-shaped content (redacts before send)')
    .action(async (path: string, options: { rebuild?: boolean; watch?: boolean; allowSecrets?: boolean }) => {
      const repo = await openRepo(path)
      const syncOptions: SyncOptions = {}
      if (options.rebuild) {
        syncOptions.rebuild = true
      }
      if (options.allowSecrets) {
        syncOptions.allowSecrets = true
      }
      const result = await repo.sync(syncOptions)

      io.stdout(
        `Indexed ${result.indexedFiles} files (${result.skippedFiles} skipped, ${result.skippedSymlinks} symlink skips) in ${result.durationMs}ms at ${repo.root}.`
      )
      if (options.watch) {
        const stop = await repo.watch()
        io.stdout(`Watching ${repo.root} for changes. Press Ctrl+C to stop.`)
        await waitForTermination(stop)
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
    .option('--context <mode>', 'inline policy: sig or body')
    .option('--with-usages', 'bundle top-N import-resolved/local usage sites for the top definition hit')
    .option('--rerank', 'opt-in reranker re-scoring for NL-concept queries (requires a configured reranker)')
    .option('--json', 'print JSON results')
    .option('--compact', 'print token-efficient compact results')
    .action(
      async (
        query: string,
        options: { k: string; repo: string; lang?: string; path?: string; kind?: string; maxTokens?: string; context?: 'sig' | 'body'; withUsages?: boolean; rerank?: boolean; json?: boolean; compact?: boolean }
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
            context?: 'sig' | 'body'
            withUsages?: boolean
            rerank?: boolean
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
          if (options.context !== undefined) {
            searchOptions.context = options.context
          }
          if (options.withUsages) {
            searchOptions.withUsages = true
          }
          if (options.rerank) {
            searchOptions.rerank = true
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
      const server = createHttpServerHandle(repo, {
        host: options.host,
        port: Number(options.port),
        ...(options.token ? { token: options.token } : {})
      })

      await server.start()
      const address = server.address ?? { host: options.host, port: Number(options.port) }
      io.stdout(`codesift MCP HTTP listening on http://${address.host}:${address.port}`)
      io.stdout(
        server.requiresToken
          ? 'Authentication: bearer token required (Authorization: Bearer <token>).'
          : 'Authentication: none (bind is localhost-only).'
      )
      io.stdout(`Tools: ${getToolDefinitions().map((tool) => tool.name).join(', ')}. Press Ctrl+C to stop.`)
      await waitForTermination(() => server.stop())
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
    .option('--repo <path>', 'repository path', process.cwd())
    .action(async (action: string | undefined, key: string | undefined, value: string | undefined, options: { repo: string }) => {
      const resolvedAction = action ?? 'get'

      if (resolvedAction === 'get') {
        const config = readConfig(options.repo)
        if (key) {
          const current = (config as Record<string, unknown>)[key]
          io.stdout(current === undefined ? `${key} is unset` : `${key}=${formatConfigValue(current)}`)
        } else {
          const entries = Object.entries(config)
          io.stdout(entries.length === 0 ? 'No configuration set (using local defaults).' : entries.map(([k, v]) => `${k}=${formatConfigValue(v)}`).join('\n'))
        }
        return
      }

      if (resolvedAction === 'set') {
        if (!key) {
          throw new Error('config set requires a key, e.g. codesift config set provider voyage-code-3')
        }

        setConfigValue(options.repo, key, value)
        io.stdout(value === undefined ? `Unset ${key}.` : `Set ${key}=${value}.`)

        if (key === 'provider') {
          const repo = await openRepo(options.repo)
          const status = await repo.status()
          if (status.indexed && !status.compatibility.ok) {
            io.stderr(status.compatibility.message ?? 'Provider changed — run "codesift index --rebuild" to rebuild with the new provider.')
          }
        }
        return
      }

      throw new Error(`Unknown config action: ${resolvedAction}. Use "get" or "set".`)
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
