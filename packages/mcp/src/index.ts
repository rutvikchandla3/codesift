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
  type SymbolKind,
  type SymbolUsage
} from '@codesift/core'

import { createHttpServerHandle } from './http.js'

export { HttpMcpServerHandle, createHttpServerHandle } from './http.js'

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
  context?: SearchOptions['context'] | undefined
  with_usages?: boolean | undefined
}

export interface FindSymbolArgs {
  name: string
  kind?: FindSymbolOptions['kind'] | undefined
  path_glob?: string | undefined
  with_body?: boolean | undefined
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

export interface McpJsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

export type McpJsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: unknown } }

export const MCP_SERVER_INSTRUCTIONS = [
  'codesift is the repo search tool. Prefer it before host grep/read-file flows because results are compact and include stable ids for follow-up reads.',
  'Routing policy: use find_symbol for exact identifiers/definitions; use grep_code for literal strings, env vars, error messages, operators, or regex; use search_code for concepts/behaviors/natural language.',
  'search_code returns the complete top result inline (the full enclosing symbol body); no follow-up read is normally needed. Use read_chunk only to expand an ADDITIONAL hit beyond the top result or to widen context.',
  'For search_code, start with k=5-8 and set max_tokens when context is tight. For grep_code, keep context_lines small unless the user asks for surrounding code.',
  'If index_status reports no index, stale data, or a running/failed/aborted sync, suggest running codesift index before relying on results.'
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
  single_best: z.boolean().optional().describe('Return only the highest-confidence answer, useful for identifier-exact lookups.'),
  context: z.enum(['sig', 'body']).optional().describe('Inline policy: sig=compact signatures/snippets only, body=inline full bodies wherever the budget allows.'),
  with_usages: z.boolean().optional().describe('Bundle top-N import-resolved/local usage sites for the top definition hit (TS/JS + Python only).')
}

const findSymbolInputSchema = {
  name: z.string().min(1).describe('Exact or partial symbol name, e.g. TokenVerifier or verifyJwtToken.'),
  kind: kindFilterSchema.optional().describe('Optional symbol kind filter.'),
  path_glob: z.string().min(1).optional().describe('Repo-relative glob, e.g. "src/auth/**".'),
  with_body: z.boolean().optional().describe('Inline the top exact match\'s full definition body so it resolves in one call. Default true; set false for a compact name→location list.')
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

const searchCodeArgsSchema = z.object(searchCodeInputSchema).strict()
const findSymbolArgsSchema = z.object(findSymbolInputSchema).strict()
const grepCodeArgsSchema = z.object(grepCodeInputSchema).strict()
const readChunkArgsSchema = z.object(readChunkInputSchema).strict()
const toolCallParamsSchema = z.object({
  name: z.enum(MCP_TOOL_NAMES),
  arguments: z.unknown().optional()
}).strict()

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

export function getToolDefinitions(): readonly McpToolDefinition[] {
  const provider = getDefaultEmbeddingProvider()
  const searchDescription = isLearnedEmbeddingProvider(provider)
    ? 'Concept/behavior search over the current repo using hybrid lexical + semantic retrieval. Returns the complete top result inline (full enclosing symbol body); no follow-up read is normally needed. Use for natural-language questions; prefer grep_code for exact literals/regex and find_symbol for definitions.'
    : 'Concept/behavior search over the current repo using lexical retrieval. Returns the complete top result inline (full enclosing symbol body); no follow-up read is normally needed. Use for natural-language questions; prefer grep_code for exact literals/regex and find_symbol for definitions.'

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
        single_best: { type: 'boolean' },
        context: { type: 'string', enum: ['sig', 'body'] },
        with_usages: { type: 'boolean' }
      })
    },
    {
      name: 'find_symbol',
      description: 'Exact identifier/definition lookup from the symbols table. Returns the top match\'s full definition body inline (no follow-up read normally needed). Use before search_code for class/function/type names.',
      inputSchema: jsonSchema(['name'], {
        name: { type: 'string' },
        kind: kindJsonSchema(),
        path_glob: { type: 'string' },
        with_body: { type: 'boolean', default: true }
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
      description: 'Expand an ADDITIONAL search_code hit id into its source chunk, or widen context around one. The top search_code result is already returned inline, so this is rarely needed for the best hit; use it for secondary hits or extra surrounding lines, not as a first step.',
      inputSchema: jsonSchema(['id'], {
        id: { type: 'string' },
        context_lines: { type: 'integer', minimum: 0, maximum: 50 }
      })
    },
    {
      name: 'index_status',
      description: 'Inspect index freshness, sync/crash state, counts, provider, and vector availability before relying on search results.',
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
      if (args.context !== undefined) {
        options.context = args.context
      }
      if (args.with_usages !== undefined) {
        options.withUsages = args.with_usages
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

      if (args.with_body !== undefined) {
        options.withBody = args.with_body
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
  return createHttpServerHandle(repo, options)
}

export async function callMcpTool(repo: Repo, name: McpToolName, args: unknown): Promise<string> {
  const router = createRouter(repo)

  switch (name) {
    case 'search_code':
      return formatMcpSearchHits(await router.searchCode(searchCodeArgsSchema.parse(args)))
    case 'find_symbol':
      return formatMcpSymbols(await router.findSymbol(findSymbolArgsSchema.parse(args)))
    case 'grep_code':
      return formatMcpGrepHits(await router.grepCode(grepCodeArgsSchema.parse(args)))
    case 'read_chunk':
      return router.readChunk(readChunkArgsSchema.parse(args))
    case 'index_status':
      return JSON.stringify(await router.indexStatus())
  }
}

export async function handleMcpJsonRpcRequest(repo: Repo, request: McpJsonRpcRequest): Promise<McpJsonRpcResponse | null> {
  const id = request.id ?? null
  const method = request.method

  if (!method) {
    return jsonRpcError(id, -32600, 'Invalid request')
  }

  if (method.startsWith('notifications/')) {
    return null
  }

  if (method === 'initialize') {
    const protocolVersion = readProtocolVersion(request.params) ?? '2025-11-25'
    return jsonRpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'codesift', version: '0.0.0' },
      instructions: MCP_SERVER_INSTRUCTIONS
    })
  }

  if (method === 'ping') {
    return jsonRpcResult(id, {})
  }

  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools: getToolDefinitions() })
  }

  if (method === 'tools/call') {
    const call = toolCallParamsSchema.safeParse(request.params)
    if (!call.success) {
      return jsonRpcResult(id, textErrorResult(`invalid tool call: ${call.error.message}`))
    }

    try {
      return jsonRpcResult(id, textResult(await callMcpTool(repo, call.data.name, call.data.arguments ?? {})))
    } catch (error) {
      return jsonRpcResult(id, textErrorResult(extractErrorMessage(error)))
    }
  }

  if (method === 'resources/list') {
    return jsonRpcResult(id, { resources: [] })
  }

  if (method === 'prompts/list') {
    return jsonRpcResult(id, { prompts: [] })
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`)
}

export function createSdkServer(repo: Repo): McpServer {
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

function textErrorResult(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text }], isError: true }
}

function jsonRpcResult(id: string | number | null, result: unknown): McpJsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): McpJsonRpcResponse {
  return data === undefined
    ? { jsonrpc: '2.0', id, error: { code, message } }
    : { jsonrpc: '2.0', id, error: { code, message, data } }
}

function readProtocolVersion(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null || !('protocolVersion' in params)) {
    return undefined
  }

  const protocolVersion = (params as { protocolVersion?: unknown }).protocolVersion
  return typeof protocolVersion === 'string' ? protocolVersion : undefined
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }

  return String(error)
}

function toolDescription(name: McpToolName): string {
  const tool = getToolDefinitions().find((definition) => definition.name === name)
  return tool?.description ?? name
}

export function formatMcpSearchHits(hits: SearchHit[]): string {
  if (hits.length === 0) {
    return 'no_hits'
  }

  // An identifier that collides across multiple definitions is returned as a candidate
  // set, not a single confident answer — lead with the collision count so the caller
  // disambiguates instead of trusting the first row.
  const ambiguousDefCount = hits[0]?.ambiguousDefCount
  const ambiguityHint = ambiguousDefCount && ambiguousDefCount >= 2 ? `ambiguous: ${ambiguousDefCount} defs\n` : ''

  const tokensReturned = hits.reduce((sum, hit) => sum + hit.tokensReturned, 0)
  const body = hits
    .map((hit) => {
      const symbol = formatHitSymbol(hit)
      const generated = hit.generated ? ' [generated]' : ''
      const stale = hit.stale ? ' [stale]' : ''
      const header = `${hit.reason} ${formatChunkId(hit.id)}${symbol}${generated}${stale}`

      if (hit.body !== undefined) {
        const block = `${header}\n${formatBodyBlock(hit.body, hit.range.startLine ?? hit.snippetRange.startLine)}`
        return hit.usages?.length ? `${block}\n${formatUsageBlock(hit.usages)}` : block
      }

      const snippet = compactHitSnippet(hit.snippet, hit.snippetRange.startLine ?? hit.range.startLine, 4)
      const block = snippet ? `${header}\n${snippet}` : header
      return hit.usages?.length ? `${block}\n${formatUsageBlock(hit.usages)}` : block
    })
    .join('\n')

  return `${ambiguityHint}${body}\ntokensReturned=${tokensReturned}`
}

function formatBodyBlock(body: string, startLine: number): string {
  const lines = body.replace(/\n$/, '').split('\n')
  return lines.map((line, index) => `${startLine + index} | ${line}`).join('\n')
}

function formatUsageBlock(usages: SymbolUsage[]): string {
  const lines = ['usages (import-resolved):']
  for (const usage of usages) {
    lines.push(`- ${usage.file}:${usage.line} | ${usage.snippet}`)
  }
  return lines.join('\n')
}

function formatHitSymbol(hit: SearchHit): string {
  if (!hit.symbol) {
    return ''
  }

  return ` ${[hit.parent, hit.symbol].filter(Boolean).join(' > ')}`
}

export function formatMcpSymbols(definitions: SymbolDefinition[]): string {
  if (definitions.length === 0) {
    return 'no_symbols'
  }

  return definitions
    .map((definition, index) => {
      const header = `#${index + 1} ${definition.kind} ${definition.name} ${definition.file}:${formatRange(definition.range.startLine, definition.range.endLine)}`
      // The top exact match carries a paste-ready body so the identifier resolves
      // in a single call; render it with the same line-numbered block as search.
      if (definition.body !== undefined) {
        return `${header}\n${formatBodyBlock(definition.body, definition.range.startLine)}`
      }
      return header
    })
    .join('\n')
}

export function formatMcpGrepHits(hits: GrepHit[]): string {
  if (hits.length === 0) {
    return 'no_matches'
  }

  return hits
    .map((hit) => {
      const range = formatRange(hit.range.startLine, hit.range.endLine)
      const snippet = compactSnippet(hit.snippet, 5).split('\n').join(' ↩ ')
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
    .join('\n')
}

// Structure-preserving renderer for compact (no-body) search hits: keeps
// original indentation and emits `NN | code` prefixes from the centered snippet
// range. Only trailing whitespace and a trailing newline are dropped.
function compactHitSnippet(snippet: string, startLine: number, maxLines: number): string {
  const lines = snippet.replace(/\n$/, '').split('\n').slice(0, maxLines)
  if (lines.length === 0) {
    return ''
  }
  return lines.map((line, index) => `${startLine + index} | ${line.replace(/\s+$/, '')}`).join('\n')
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
