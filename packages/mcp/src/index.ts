import {
  DEFAULT_SEARCH_K as CORE_DEFAULT_SEARCH_K,
  getDefaultEmbeddingProvider,
  isLearnedEmbeddingProvider,
  type FindSymbolOptions,
  type Repo,
  type RepoStatus,
  type SearchHit,
  type SearchOptions,
  type SymbolDefinition
} from '@codesift/core'

export const DEFAULT_SEARCH_K = CORE_DEFAULT_SEARCH_K

export const MCP_TOOL_NAMES = [
  'search_code',
  'find_symbol',
  'read_chunk',
  'index_status'
] as const

export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

export interface SearchCodeArgs {
  query: string
  k?: number
  lang?: string[]
  path_glob?: string
  kind?: SearchOptions['kind']
}

export interface FindSymbolArgs {
  name: string
  kind?: FindSymbolOptions['kind']
}

export interface ReadChunkArgs {
  id: string
  context_lines?: number
}

export interface McpToolDefinition {
  name: McpToolName
  description: string
}

export interface HttpServerOptions {
  host?: string
  port?: number
  token?: string
}

export interface McpServerHandle {
  readonly transport: 'stdio' | 'http'
  readonly tools: readonly McpToolDefinition[]
  start(): Promise<void>
  stop(): Promise<void>
}

export interface McpRouter {
  searchCode(args: SearchCodeArgs): Promise<SearchHit[]>
  findSymbol(args: FindSymbolArgs): Promise<SymbolDefinition[]>
  readChunk(args: ReadChunkArgs): Promise<string>
  indexStatus(): Promise<RepoStatus>
}

class ScaffoldServerHandle implements McpServerHandle {
  constructor(
    readonly transport: 'stdio' | 'http',
    private readonly _repo: Repo,
    readonly options?: HttpServerOptions
  ) {}

  get tools(): readonly McpToolDefinition[] {
    return getToolDefinitions()
  }

  async start(): Promise<void> {
    return undefined
  }

  async stop(): Promise<void> {
    return undefined
  }
}

export function getToolDefinitions(): readonly McpToolDefinition[] {
  const provider = getDefaultEmbeddingProvider()
  const searchDescription = isLearnedEmbeddingProvider(provider)
    ? 'Hybrid lexical + semantic code search over the current repo index.'
    : 'Lexical code search over the current repo index.'

  return [
    {
      name: 'search_code',
      description: searchDescription
    },
    {
      name: 'find_symbol',
      description: 'Definition lookup from the symbols table.'
    },
    {
      name: 'read_chunk',
      description: 'Expand a prior hit into a larger chunk with surrounding context.'
    },
    {
      name: 'index_status',
      description: 'Inspect freshness, counts, and model metadata for the current index.'
    }
  ]
}

export function createRouter(repo: Repo): McpRouter {
  return {
    async searchCode(args) {
      const options: SearchOptions = {
        k: args.k ?? DEFAULT_SEARCH_K
      }

      if (args.lang) {
        options.lang = args.lang
      }

      if (args.path_glob) {
        options.pathGlob = args.path_glob
      }

      if (args.kind) {
        options.kind = args.kind
      }

      return repo.search(args.query, options)
    },
    async findSymbol(args) {
      const options: FindSymbolOptions = {}

      if (args.kind) {
        options.kind = args.kind
      }

      return repo.findSymbol(args.name, options)
    },
    async readChunk(args) {
      return repo.readChunk(args.id, args.context_lines === undefined ? undefined : { contextLines: args.context_lines })
    },
    async indexStatus() {
      return repo.status()
    }
  }
}

export function createStdioServer(repo: Repo): McpServerHandle {
  return new ScaffoldServerHandle('stdio', repo)
}

export function createHttpServer(repo: Repo, options: HttpServerOptions = {}): McpServerHandle {
  return new ScaffoldServerHandle('http', repo, options)
}
