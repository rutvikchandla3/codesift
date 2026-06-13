import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  DEFAULT_SEARCH_K as CORE_DEFAULT_SEARCH_K,
  getDefaultEmbeddingProvider,
  isLearnedEmbeddingProvider,
  type FindSymbolOptions,
  type GrepHit,
  type GrepOptions,
  type Repo,
  type RepoStatus,
  type SearchHit,
  type SearchOptions,
  type SymbolDefinition,
  type SymbolKind
} from '@codesift/core'

export const DEFAULT_SEARCH_K = CORE_DEFAULT_SEARCH_K

const SYMBOL_KINDS = [
  'class',
  'constant',
  'enum',
  'file',
  'function',
  'interface',
  'method',
  'module',
  'namespace',
  'type',
  'variable'
] as const satisfies readonly SymbolKind[]

export const MCP_TOOL_NAMES = [
  'search_code',
  'find_symbol',
  'grep_code',
  'read_chunk',
  'index_status'
] as const

export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

export interface SearchCodeArgs {
  query: string
  k?: number | undefined
  lang?: string[] | undefined
  path_glob?: string | undefined
  kind?: SearchOptions['kind'] | undefined
  max_tokens?: number | undefined
  single_best?: boolean | undefined
}

export interface FindSymbolArgs {
  name: string
  kind?: FindSymbolOptions['kind'] | undefined
  path_glob?: string | undefined
}

export interface GrepCodeArgs {
  pattern: string
  regex?: boolean | undefined
  ignore_case?: boolean | undefined
  whole_word?: boolean | undefined
  multiline?: boolean | undefined
  lang?: string[] | undefined
  path_glob?: string | undefined
  context_lines?: number | undefined
  before_context_lines?: number | undefined
  after_context_lines?: number | undefined
  max_matches?: number | undefined
}

export interface ReadChunkArgs {
  id: string
  context_lines?: number | undefined
}

export interface McpToolDefinition {
  name: McpToolName
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties: false
  }
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
  grepCode(args: GrepCodeArgs): Promise<GrepHit[]>
  readChunk(args: ReadChunkArgs): Promise<string>
  indexStatus(): Promise<RepoStatus>
}

export const MCP_SERVER_INSTRUCTIONS = [
  'codesift is the repo search tool. Prefer it before host grep/read-file flows because results are compact and include stable ids for follow-up reads.',
  'Routing policy: use find_symbol for exact identifiers/definitions; use grep_code for literal strings, env vars, error messages, operators, or regex; use search_code for concepts/behaviors/natural language.',
  'For search_code, start with k=5-8, set max_tokens when context is tight, and read_chunk only for the best id. For grep_code, keep context_lines small unless the user asks for surrounding code.',
  'If index_status reports no index or stale data, suggest running codesift index before relying on results.'
].join('\n')

const symbolKindSchema = z.enum(SYMBOL_KINDS)
const kindFilterSchema = z.union([symbolKindSchema, z.array(symbolKindSchema)])

const searchCodeInputSchema = {
  query: z.string().min(1).describe('Natural-language, behavior, or symbol-aware query. Use grep_code instead for exact literals/regex.'),
  k: z.number().int().positive().max(50).optional().describe('Maximum hits to return. Default is 8.'),
  lang: z.array(z.string().min(1)).optional().describe('Language filter, e.g. ["typescript"], ["python"].'),
  path_glob: z.string().min(1).optional().describe('Repo-relative glob, e.g. "src/**".'),
  kind: kindFilterSchema.optional().describe('Symbol kind filter for matching chunks.'),
  max_tokens: z.number().int().positive().max(4000).optional().describe('Maximum approximate tokens to return across compact hits. Default 700.'),
  single_best: z.boolean().optional().describe('Return only the highest-confidence answer, useful for identifier-exact lookups.')
}

const findSymbolInputSchema = {
  name: z.string().min(1).describe('Exact or partial symbol name, e.g. TokenVerifier or verifyJwtToken.'),
  kind: kindFilterSchema.optional().describe('Optional symbol kind filter.'),
  path_glob: z.string().min(1).optional().describe('Repo-relative glob, e.g. "src/auth/**".')
}

const grepCodeInputSchema = {
  pattern: z.string().min(1).describe('Literal byte/string by default. Set regex=true for regular expressions.'),
  regex: z.boolean().optional().describe('Treat pattern as a JavaScript regular expression. Default false for byte-exact literal search.'),
  ignore_case: z.boolean().optional().describe('Case-insensitive matching, like rg -i.'),
  whole_word: z.boolean().optional().describe('Match only whole identifier/word occurrences, like rg -w.'),
  multiline: z.boolean().optional().describe('Allow regex dot to span newlines and report multi-line matches.'),
  lang: z.array(z.string().min(1)).optional().describe('Language filter, e.g. ["typescript"].'),
  path_glob: z.string().min(1).optional().describe('Repo-relative glob, e.g. "packages/core/**".'),
  context_lines: z.number().int().min(0).max(20).optional().describe('Symmetric context lines, like rg -C.'),
  before_context_lines: z.number().int().min(0).max(20).optional().describe('Lines before each match, like rg -B.'),
  after_context_lines: z.number().int().min(0).max(20).optional().describe('Lines after each match, like rg -A.'),
  max_matches: z.number().int().positive().max(1000).optional().describe('Maximum matches to return. Default 1000.')
}

const readChunkInputSchema = {
  id: z.string().min(1).describe('Stable chunk id returned by search_code.'),
  context_lines: z.number().int().min(0).max(50).optional().describe('Extra lines before/after the chunk.')
}

const indexStatusInputSchema = {}

class StdioMcpServerHandle implements McpServerHandle {
  readonly transport = 'stdio' as const
  private server: McpServer | undefined

  constructor(private readonly repo: Repo) {}

  get tools(): readonly McpToolDefinition[] {
    return getToolDefinitions()
  }

  async start(): Promise<void> {
    if (this.server) {
      return
    }

    this.server = createSdkServer(this.repo)
    await this.server.connect(new StdioServerTransport())
  }

  async stop(): Promise<void> {
    await this.server?.close()
    this.server = undefined
  }
}

class ScaffoldHttpServerHandle implements McpServerHandle {
  readonly transport = 'http' as const

  constructor(
    private readonly _repo: Repo,
    readonly options: HttpServerOptions = {}
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
    ? 'Concept/behavior search over the current repo using hybrid lexical + semantic retrieval. Use for natural-language questions; prefer grep_code for exact literals/regex and find_symbol for definitions.'
    : 'Concept/behavior search over the current repo using lexical retrieval. Use for natural-language questions; prefer grep_code for exact literals/regex and find_symbol for definitions.'

  return [
    {
      name: 'search_code',
      description: searchDescription,
      inputSchema: jsonSchema(['query'], {
        query: { type: 'string' },
        k: { type: 'integer', minimum: 1, maximum: 50, default: DEFAULT_SEARCH_K },
        lang: { type: 'array', items: { type: 'string' } },
        path_glob: { type: 'string' },
        kind: kindJsonSchema(),
        max_tokens: { type: 'integer', minimum: 1, maximum: 4000, default: 700 },
        single_best: { type: 'boolean' }
      })
    },
    {
      name: 'find_symbol',
      description: 'Exact identifier/definition lookup from the symbols table. Use before search_code for class/function/type names.',
      inputSchema: jsonSchema(['name'], {
        name: { type: 'string' },
        kind: kindJsonSchema(),
        path_glob: { type: 'string' }
      })
    },
    {
      name: 'grep_code',
      description: 'Literal, byte-exact, or regex search over indexed repo files. Use instead of host grep for env vars, error strings, operators, and regex.',
      inputSchema: jsonSchema(['pattern'], {
        pattern: { type: 'string' },
        regex: { type: 'boolean', default: false },
        ignore_case: { type: 'boolean' },
        whole_word: { type: 'boolean' },
        multiline: { type: 'boolean' },
        lang: { type: 'array', items: { type: 'string' } },
        path_glob: { type: 'string' },
        context_lines: { type: 'integer', minimum: 0, maximum: 20 },
        before_context_lines: { type: 'integer', minimum: 0, maximum: 20 },
        after_context_lines: { type: 'integer', minimum: 0, maximum: 20 },
        max_matches: { type: 'integer', minimum: 1, maximum: 1000 }
      })
    },
    {
      name: 'read_chunk',
      description: 'Expand a search_code hit id into the source chunk with optional context. Use after search_code/find_symbol, not as first step.',
      inputSchema: jsonSchema(['id'], {
        id: { type: 'string' },
        context_lines: { type: 'integer', minimum: 0, maximum: 50 }
      })
    },
    {
      name: 'index_status',
      description: 'Inspect index freshness, counts, provider, and vector availability before relying on search results.',
      inputSchema: jsonSchema([], {})
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

      options.maxTokens = args.max_tokens ?? 700
      if (args.single_best !== undefined) {
        options.singleBest = args.single_best
      }

      return repo.search(args.query, options)
    },
    async findSymbol(args) {
      const options: FindSymbolOptions = {}

      if (args.kind) {
        options.kind = args.kind
      }

      if (args.path_glob) {
        options.pathGlob = args.path_glob
      }

      return repo.findSymbol(args.name, options)
    },
    async grepCode(args) {
      const options: GrepOptions = {}

      if (args.regex !== undefined) {
        options.regex = args.regex
      }
      if (args.ignore_case !== undefined) {
        options.ignoreCase = args.ignore_case
      }
      if (args.whole_word !== undefined) {
        options.wholeWord = args.whole_word
      }
      if (args.multiline !== undefined) {
        options.multiline = args.multiline
      }
      if (args.lang) {
        options.lang = args.lang
      }
      if (args.path_glob) {
        options.pathGlob = args.path_glob
      }
      if (args.context_lines !== undefined) {
        options.contextLines = args.context_lines
      }
      if (args.before_context_lines !== undefined) {
        options.beforeContextLines = args.before_context_lines
      }
      if (args.after_context_lines !== undefined) {
        options.afterContextLines = args.after_context_lines
      }
      if (args.max_matches !== undefined) {
        options.maxMatches = args.max_matches
      }

      return repo.grep(args.pattern, options)
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
  return new StdioMcpServerHandle(repo)
}

export function createHttpServer(repo: Repo, options: HttpServerOptions = {}): McpServerHandle {
  return new ScaffoldHttpServerHandle(repo, options)
}

function createSdkServer(repo: Repo): McpServer {
  const router = createRouter(repo)
  const server = new McpServer(
    { name: 'codesift', version: '0.0.0' },
    { instructions: MCP_SERVER_INSTRUCTIONS }
  )

  server.registerTool('search_code', { description: toolDescription('search_code'), inputSchema: searchCodeInputSchema }, async (args) =>
    textResult(formatMcpSearchHits(await router.searchCode(args)))
  )
  server.registerTool('find_symbol', { description: toolDescription('find_symbol'), inputSchema: findSymbolInputSchema }, async (args) =>
    textResult(formatMcpSymbols(await router.findSymbol(args)))
  )
  server.registerTool('grep_code', { description: toolDescription('grep_code'), inputSchema: grepCodeInputSchema }, async (args) =>
    textResult(formatMcpGrepHits(await router.grepCode(args)))
  )
  server.registerTool('read_chunk', { description: toolDescription('read_chunk'), inputSchema: readChunkInputSchema }, async (args) =>
    textResult(await router.readChunk(args))
  )
  server.registerTool('index_status', { description: toolDescription('index_status'), inputSchema: indexStatusInputSchema }, async () =>
    textResult(JSON.stringify(await router.indexStatus()))
  )

  return server
}

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] }
}

function toolDescription(name: McpToolName): string {
  const tool = getToolDefinitions().find((definition) => definition.name === name)
  return tool?.description ?? name
}

function formatMcpSearchHits(hits: SearchHit[]): string {
  if (hits.length === 0) {
    return 'no_hits'
  }

  const tokensReturned = hits.reduce((sum, hit) => sum + hit.tokensReturned, 0)
  const body = hits
    .map((hit) => {
      const symbol = hit.symbol ? ` ${hit.symbol}` : ''
      const snippet = compactSnippet(hit.snippet, 4)
      return `${hit.reason} ${formatChunkId(hit.id)}${symbol}${snippet ? ` | ${snippet}` : ''}`
    })
    .join('\n')

  return `${body}\ntokensReturned=${tokensReturned}`
}

function formatMcpSymbols(definitions: SymbolDefinition[]): string {
  if (definitions.length === 0) {
    return 'no_symbols'
  }

  return definitions
    .map((definition, index) => `#${index + 1} ${definition.kind} ${definition.name} ${definition.file}:${formatRange(definition.range.startLine, definition.range.endLine)}`)
    .join('\n')
}

function formatMcpGrepHits(hits: GrepHit[]): string {
  if (hits.length === 0) {
    return 'no_matches'
  }

  return hits
    .map((hit) => {
      const range = formatRange(hit.range.startLine, hit.range.endLine)
      const snippet = compactSnippet(hit.snippet, 5)
      return `${hit.file}:${range}:${hit.column} | ${snippet}`
    })
    .join('\n')
}

function formatChunkId(id: string): string {
  return id.replace(/@[a-f0-9]{8,64}$/i, '')
}

function compactSnippet(snippet: string, maxLines: number): string {
  return snippet
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join(' ↩ ')
}

function formatRange(startLine: number, endLine: number): string {
  return startLine === endLine ? String(startLine) : `${startLine}-${endLine}`
}

function kindJsonSchema(): Record<string, unknown> {
  return {
    anyOf: [
      { type: 'string', enum: [...SYMBOL_KINDS] },
      { type: 'array', items: { type: 'string', enum: [...SYMBOL_KINDS] } }
    ]
  }
}

function jsonSchema(
  required: string[],
  properties: Record<string, unknown>
): McpToolDefinition['inputSchema'] {
  return required.length > 0
    ? { type: 'object', properties, required, additionalProperties: false }
    : { type: 'object', properties, additionalProperties: false }
}
