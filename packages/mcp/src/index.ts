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
export const DEFAULT_MCP_SEARCH_MAX_TOKENS = 700
export const DEFAULT_MCP_GREP_MAX_TOKENS = 700
export const DEFAULT_MCP_FIND_SYMBOL_MAX_TOKENS = 700
export const DEFAULT_MCP_READ_CHUNK_MAX_TOKENS = 1000
export const MIN_MCP_READ_CHUNK_MAX_TOKENS = 6
export const MAX_MCP_READ_CHUNK_MAX_TOKENS = 4000

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
  max_tokens?: number | undefined
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
  max_tokens?: number | undefined
}

export interface FormatMcpGrepHitsOptions {
  maxTokens?: number | undefined
}

export interface FormatMcpSearchHitsOptions {
  maxTokens?: number | undefined
}

export interface FormatMcpReadChunkOptions {
  maxTokens?: number | undefined
}

export interface FormatMcpSymbolsOptions {
  maxTokens?: number | undefined
}

export interface ReadChunkArgs {
  id: string
  context_lines?: number | undefined
  max_tokens?: number | undefined
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
  'Use codesift before host grep/read. Route identifiers/definitions->find_symbol; literals/env/errors/operators/regex->grep_code; concepts/unknown names->search_code.',
  'Top search_code body is inline; read_chunk only for non-top hits/wider context. Broad search_code: k=5-8. Keep grep_code context small.',
  'Check index_status; if missing/stale/running/failed/aborted, warn and suggest codesift index/sync.'
].join('\n')

const symbolKindSchema = z.enum(SYMBOL_KINDS)
const kindFilterSchema = z.union([symbolKindSchema, z.array(symbolKindSchema)])

const searchCodeInputSchema = {
  query: z.string().min(1).describe('Concept, behavior, or fuzzy name; not exact literals/regex.'),
  k: z.number().int().positive().max(50).optional().describe('Max hits. Default 8.'),
  lang: z.array(z.string().min(1)).optional().describe('Language filter, e.g. ["typescript"].'),
  path_glob: z.string().min(1).optional().describe('Repo glob, e.g. "src/**".'),
  kind: kindFilterSchema.optional().describe('Symbol kind filter.'),
  max_tokens: z.number().int().positive().max(4000).optional().describe('Approx output tokens. Default 700.'),
  single_best: z.boolean().optional().describe('Return only best hit.'),
  context: z.enum(['sig', 'body']).optional().describe('sig=snippets; body=inline bodies within budget.'),
  with_usages: z.boolean().optional().describe('Add top usage sites for the top definition hit.')
}

const findSymbolInputSchema = {
  name: z.string().min(1).describe('Exact/partial symbol name.'),
  kind: kindFilterSchema.optional().describe('Symbol kind filter.'),
  path_glob: z.string().min(1).optional().describe('Repo glob, e.g. "src/auth/**".'),
  with_body: z.boolean().optional().describe('Inline top exact body. Default true.'),
  max_tokens: z.number().int().positive().max(4000).optional().describe('Approx output tokens. Default 700.')
}

const grepCodeInputSchema = {
  pattern: z.string().min(1).describe('Literal by default; set regex=true for regex.'),
  regex: z.boolean().optional().describe('Use JavaScript regex. Default false.'),
  ignore_case: z.boolean().optional().describe('Case-insensitive match.'),
  whole_word: z.boolean().optional().describe('Whole word/identifier match.'),
  multiline: z.boolean().optional().describe('Allow multi-line regex matches.'),
  lang: z.array(z.string().min(1)).optional().describe('Language filter, e.g. ["typescript"].'),
  path_glob: z.string().min(1).optional().describe('Repo glob, e.g. "packages/core/**".'),
  context_lines: z.number().int().min(0).max(20).optional().describe('Lines before/after each match.'),
  before_context_lines: z.number().int().min(0).max(20).optional().describe('Lines before each match.'),
  after_context_lines: z.number().int().min(0).max(20).optional().describe('Lines after each match.'),
  max_matches: z.number().int().positive().max(1000).optional().describe('Max matches. Default 1000.'),
  max_tokens: z.number().int().positive().max(4000).optional().describe('Approx output tokens. Default 700.')
}

const readChunkInputSchema = {
  id: z.string().min(1).describe('Stable search_code hit id.'),
  context_lines: z.number().int().min(0).max(50).optional().describe('Extra surrounding lines.'),
  max_tokens: z.number().int().min(MIN_MCP_READ_CHUNK_MAX_TOKENS).max(MAX_MCP_READ_CHUNK_MAX_TOKENS).optional().describe('Approx output tokens. Default 1000.')
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
    ? 'Hybrid lexical + semantic repo search for concepts/unknown names. Top body inline; read_chunk for other hits. Use grep_code for literals/regex, find_symbol for definitions.'
    : 'Lexical repo search for concepts/unknown names. Top body inline; read_chunk for other hits. Use grep_code for literals/regex, find_symbol for definitions.'

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
        max_tokens: { type: 'integer', minimum: 1, maximum: 4000, default: DEFAULT_MCP_SEARCH_MAX_TOKENS },
        single_best: { type: 'boolean' },
        context: { type: 'string', enum: ['sig', 'body'] },
        with_usages: { type: 'boolean' }
      })
    },
    {
      name: 'find_symbol',
      description: 'Exact identifier/definition lookup. Top unambiguous body inline; use before search_code for names.',
      inputSchema: jsonSchema(['name'], {
        name: { type: 'string' },
        kind: kindJsonSchema(),
        path_glob: { type: 'string' },
        with_body: { type: 'boolean', default: true },
        max_tokens: { type: 'integer', minimum: 1, maximum: 4000, default: DEFAULT_MCP_FIND_SYMBOL_MAX_TOKENS }
      })
    },
    {
      name: 'grep_code',
      description: 'Literal/regex indexed-file search for env vars, errors, operators, exact strings; keep context small.',
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
        max_matches: { type: 'integer', minimum: 1, maximum: 1000 },
        max_tokens: { type: 'integer', minimum: 1, maximum: 4000, default: 700 }
      })
    },
    {
      name: 'read_chunk',
      description: 'Read non-top hit/wider context by id. Not needed for top search_code/find_symbol hits returned inline.',
      inputSchema: jsonSchema(['id'], {
        id: { type: 'string' },
        context_lines: { type: 'integer', minimum: 0, maximum: 50 },
        max_tokens: { type: 'integer', minimum: MIN_MCP_READ_CHUNK_MAX_TOKENS, maximum: MAX_MCP_READ_CHUNK_MAX_TOKENS, default: DEFAULT_MCP_READ_CHUNK_MAX_TOKENS }
      })
    },
    {
      name: 'index_status',
      description: 'Inspect index freshness, sync state, counts, provider, vectors.',
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

      options.maxTokens = args.max_tokens ?? DEFAULT_MCP_SEARCH_MAX_TOKENS
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
      {
        const parsed = searchCodeArgsSchema.parse(args)
        return formatMcpSearchHits(await router.searchCode(parsed), { maxTokens: parsed.max_tokens ?? DEFAULT_MCP_SEARCH_MAX_TOKENS })
      }
    case 'find_symbol':
      {
        const parsed = findSymbolArgsSchema.parse(args)
        return formatMcpSymbols(await router.findSymbol(parsed), { maxTokens: parsed.max_tokens ?? DEFAULT_MCP_FIND_SYMBOL_MAX_TOKENS })
      }
    case 'grep_code':
      {
        const parsed = grepCodeArgsSchema.parse(args)
        return formatMcpGrepHits(await router.grepCode(parsed), { maxTokens: parsed.max_tokens ?? DEFAULT_MCP_GREP_MAX_TOKENS })
      }
    case 'read_chunk':
      {
        const parsed = readChunkArgsSchema.parse(args)
        return formatMcpReadChunk(await router.readChunk(parsed), { maxTokens: parsed.max_tokens ?? DEFAULT_MCP_READ_CHUNK_MAX_TOKENS })
      }
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
    textResult(formatMcpSearchHits(await router.searchCode(args), { maxTokens: args.max_tokens ?? DEFAULT_MCP_SEARCH_MAX_TOKENS }))
  )
  server.registerTool('find_symbol', { description: toolDescription('find_symbol'), inputSchema: findSymbolInputSchema }, async (args) =>
    textResult(formatMcpSymbols(await router.findSymbol(args), { maxTokens: args.max_tokens ?? DEFAULT_MCP_FIND_SYMBOL_MAX_TOKENS }))
  )
  server.registerTool('grep_code', { description: toolDescription('grep_code'), inputSchema: grepCodeInputSchema }, async (args) =>
    textResult(formatMcpGrepHits(await router.grepCode(args), { maxTokens: args.max_tokens ?? DEFAULT_MCP_GREP_MAX_TOKENS }))
  )
  server.registerTool('read_chunk', { description: toolDescription('read_chunk'), inputSchema: readChunkInputSchema }, async (args) =>
    textResult(formatMcpReadChunk(await router.readChunk(args), { maxTokens: args.max_tokens ?? DEFAULT_MCP_READ_CHUNK_MAX_TOKENS }))
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

export function formatMcpSearchHits(hits: SearchHit[], options: FormatMcpSearchHitsOptions = {}): string {
  if (hits.length === 0) {
    return 'no_hits'
  }

  const ambiguityHint = formatSearchAmbiguityHint(hits[0])
  const tokensLine = formatSearchTokensLine(hits)
  const renderedHits = hits.map((hit) => formatMcpSearchHit(hit))
  const output = joinSections([ambiguityHint, ...renderedHits, tokensLine])
  const maxTokens = options.maxTokens
  if (maxTokens === undefined || output.length <= maxTokens * 4) {
    return output
  }

  return fitSearchOutputForBudget(hits, renderedHits, ambiguityHint, tokensLine, maxTokens * 4)
}

function formatSearchAmbiguityHint(hit: SearchHit | undefined): string {
  // An identifier that collides across multiple definitions is returned as a candidate
  // set, not a single confident answer — lead with the collision count so the caller
  // disambiguates instead of trusting the first row.
  const ambiguousDefCount = hit?.ambiguousDefCount
  return ambiguousDefCount && ambiguousDefCount >= 2 ? `ambiguous: ${ambiguousDefCount} defs` : ''
}

function formatSearchTokensLine(hits: SearchHit[]): string {
  const tokensReturned = hits.reduce((sum, hit) => sum + hit.tokensReturned, 0)
  return `tokensReturned=${tokensReturned}`
}

function formatMcpSearchHit(hit: SearchHit): string {
  const sections = [formatSearchHitHeader(hit)]
  const content = formatSearchHitContent(hit)
  if (content) {
    sections.push(content)
  }
  if (hit.usages?.length) {
    sections.push(formatUsageBlock(hit.usages))
  }
  return joinSections(sections)
}

function formatSearchHitHeader(hit: SearchHit): string {
  const symbol = formatHitSymbol(hit)
  const generated = hit.generated ? ' [generated]' : ''
  const stale = hit.stale ? ' [stale]' : ''
  return `${hit.reason} ${formatChunkId(hit.id)}${symbol}${generated}${stale}`
}

function formatSearchHitContent(hit: SearchHit): string {
  if (hit.body !== undefined) {
    return formatBodyBlock(hit.body, hit.range.startLine ?? hit.snippetRange.startLine)
  }

  return compactHitSnippet(hit.snippet, hit.snippetRange.startLine ?? hit.range.startLine, 4)
}

function fitSearchOutputForBudget(
  hits: SearchHit[],
  renderedHits: string[],
  ambiguityHint: string,
  tokensLine: string,
  maxChars: number
): string {
  const leadingSections = ambiguityHint ? [ambiguityHint] : []
  const hitsOnlyOutput = joinSections([...leadingSections, ...renderedHits])
  if (hitsOnlyOutput.length <= maxChars) {
    return appendSearchTokensLineIfFits(hitsOnlyOutput, tokensLine, maxChars)
  }

  const keptHits: string[] = []
  for (let index = 0; index < renderedHits.length; index += 1) {
    const candidateHits = [...keptHits, renderedHits[index]!]
    const omitted = renderedHits.length - candidateHits.length
    const marker = omitted > 0
      ? searchHitOmissionMarker(omitted, remainingCharsForTrailingLine([...leadingSections, ...candidateHits], maxChars))
      : ''
    const candidateOutput = joinSections([...leadingSections, ...candidateHits, marker])
    if (candidateOutput.length <= maxChars) {
      keptHits.push(renderedHits[index]!)
      continue
    }

    if (keptHits.length === 0) {
      const output = fitSearchSingleHitOutput(hits[0]!, leadingSections, omitted, maxChars)
      return appendSearchTokensLineIfFits(output, tokensLine, maxChars)
    }

    break
  }

  const outputHits = [...keptHits]
  let omitted = renderedHits.length - outputHits.length
  let marker = omitted > 0
    ? searchHitOmissionMarker(omitted, remainingCharsForTrailingLine([...leadingSections, ...outputHits], maxChars))
    : ''

  while (omitted > 0 && !marker && outputHits.length > 1) {
    outputHits.pop()
    omitted += 1
    marker = searchHitOmissionMarker(omitted, remainingCharsForTrailingLine([...leadingSections, ...outputHits], maxChars))
  }

  if (omitted > 0 && !marker && outputHits.length === 1) {
    const output = fitSearchSingleHitOutput(hits[0]!, leadingSections, omitted, maxChars)
    return appendSearchTokensLineIfFits(output, tokensLine, maxChars)
  }

  const output = joinSections([...leadingSections, ...outputHits, marker])
  return appendSearchTokensLineIfFits(output, tokensLine, maxChars)
}

function fitSearchSingleHitOutput(hit: SearchHit, leadingSections: string[], omittedHits: number, maxChars: number): string {
  const leadingOnly = joinSections(leadingSections)
  const header = formatSearchHitHeader(hit)
  const trailingVariants = omittedHits > 0 ? searchHitOmissionMarkerVariants(omittedHits) : ['']

  for (const trailingLine of trailingVariants) {
    const reservedHitBudget = maxChars
      - (leadingOnly ? leadingOnly.length + 1 : 0)
      - (trailingLine ? trailingLine.length + 1 : 0)
    if (reservedHitBudget <= 0) {
      continue
    }

    const hitOutput = formatSearchHitForBudget(hit, reservedHitBudget)
    if (hitOutput) {
      const candidate = joinSections([...leadingSections, hitOutput, trailingLine])
      if (candidate.length <= maxChars) {
        return candidate
      }
    }
  }

  const hitBudget = maxChars - (leadingOnly ? leadingOnly.length + 1 : 0)
  if (omittedHits === 0 && hitBudget > 0 && hitBudget >= header.length) {
    const hitOnly = formatSearchHitForBudget(hit, hitBudget)
    if (hitOnly) {
      const candidate = joinSections([...leadingSections, hitOnly])
      if (candidate.length <= maxChars) {
        return candidate
      }
    }
  }

  if (omittedHits > 0) {
    const markerWithLeading = fitMarkerWithLeadingSections(leadingSections, trailingVariants, maxChars)
    if (markerWithLeading) {
      return markerWithLeading
    }

    return bestEffortOmissionMarker(trailingVariants, maxChars)
  }

  for (const trailingLine of trailingVariants) {
    if (trailingLine && trailingLine.length <= maxChars) {
      return trailingLine
    }
  }

  if (leadingOnly && leadingOnly.length <= maxChars) {
    return leadingOnly
  }

  return formatSearchHitForBudget(hit, maxChars)
}

function formatSearchHitForBudget(hit: SearchHit, maxChars: number): string {
  const full = formatMcpSearchHit(hit)
  if (full.length <= maxChars) {
    return full
  }

  const header = formatSearchHitHeader(hit)
  const content = formatSearchHitContent(hit)
  const usageCount = hit.usages?.length ?? 0
  if (maxChars <= header.length) {
    if (usageCount > 0) {
      return reserveUsageMarkerForSearchHit(header, content || undefined, maxChars, usageCount)
    }
    return truncateWithEllipsis(header, maxChars)
  }

  const sections = [header]

  if (content) {
    const remainingAfterHeader = maxChars - header.length - 1
    if (content.length + 1 <= remainingAfterHeader) {
      sections.push(content)
      if (usageCount > 0) {
        const usageBlock = formatUsageBlockForBudget(hit.usages!, maxChars - joinSections(sections).length - 1)
        if (usageBlock) {
          sections.push(usageBlock)
          return joinSections(sections)
        }

        return reserveUsageMarkerForSearchHit(header, content, maxChars, usageCount)
      }
      return joinSections(sections)
    }

    if (usageCount > 0) {
      return reserveUsageMarkerForSearchHit(header, content, maxChars, usageCount)
    }

    const truncatedContent = truncateSearchBlock(content, remainingAfterHeader)
    if (truncatedContent) {
      sections.push(truncatedContent)
    }
    const fallback = joinSections(sections)
    return fallback.length <= maxChars ? fallback : truncateWithEllipsis(fallback, maxChars)
  }

  if (usageCount > 0) {
    const usageBlock = formatUsageBlockForBudget(hit.usages!, maxChars - header.length - 1)
    if (usageBlock) {
      return joinSections([header, usageBlock])
    }

    return reserveUsageMarkerForSearchHit(header, undefined, maxChars, usageCount)
  }

  return truncateWithEllipsis(header, maxChars)
}

function reserveUsageMarkerForSearchHit(header: string, content: string | undefined, maxChars: number, omittedUsages: number): string {
  const markers = usageOmissionMarkerVariants(omittedUsages)

  if (content !== undefined) {
    for (const marker of markers) {
      const contentBudget = maxChars - header.length - 1 - marker.length - 1
      if (contentBudget <= 0) {
        continue
      }

      const truncatedContent = truncateSearchBlock(content, contentBudget)
      if (!truncatedContent) {
        continue
      }

      const candidate = joinSections([header, truncatedContent, marker])
      if (candidate.length <= maxChars) {
        return candidate
      }
    }
  }

  const headerWithMarker = fitMarkerWithLeadingSections([header], markers, maxChars)
  if (headerWithMarker) {
    return headerWithMarker
  }

  if (content !== undefined) {
    for (const marker of markers) {
      const contentBudget = maxChars - marker.length - 1
      if (contentBudget <= 0) {
        continue
      }

      const truncatedContent = truncateSearchBlock(content, contentBudget)
      if (!truncatedContent) {
        continue
      }

      const candidate = joinSections([truncatedContent, marker])
      if (candidate.length <= maxChars) {
        return candidate
      }
    }
  }

  return bestEffortOmissionMarker(markers, maxChars)
}

function fitMarkerWithLeadingSections(leadingSections: string[], markers: string[], maxChars: number): string {
  for (const marker of markers) {
    const markerWithLeading = joinSections([...leadingSections, marker])
    if (markerWithLeading && markerWithLeading.length <= maxChars) {
      return markerWithLeading
    }
  }

  const leadingOutput = joinSections(leadingSections)
  const remainingForMarker = maxChars - (leadingOutput ? leadingOutput.length + 1 : 0)
  if (remainingForMarker > 0) {
    const truncatedMarker = bestEffortOmissionMarker(markers, remainingForMarker)
    if (truncatedMarker) {
      const candidate = joinSections([...leadingSections, truncatedMarker])
      if (candidate.length <= maxChars) {
        return candidate
      }
    }
  }

  return ''
}

function bestEffortOmissionMarker(markers: string[], maxChars: number): string {
  if (maxChars <= 0 || markers.length === 0) {
    return ''
  }

  const fittingMarker = firstMarkerThatFits(markers, maxChars)
  if (fittingMarker) {
    return fittingMarker
  }

  return truncateWithEllipsis(markers[0]!, maxChars)
}

function formatBodyBlock(body: string, startLine: number): string {
  const lines = body.replace(/\n$/, '').split('\n')
  return lines.map((line, index) => `${startLine + index} | ${line}`).join('\n')
}

function formatUsageBlock(usages: SymbolUsage[]): string {
  const lines = ['usages (import-resolved):']
  for (const usage of usages) {
    lines.push(formatUsageLineRaw(usage))
  }
  return lines.join('\n')
}

function formatUsageBlockForBudget(usages: SymbolUsage[], maxChars: number): string {
  if (maxChars <= 0) {
    return ''
  }

  const full = formatUsageBlock(usages)
  if (full.length <= maxChars) {
    return full
  }

  const markerOnly = bestEffortOmissionMarker(usageOmissionMarkerVariants(usages.length), maxChars)
  const header = 'usages (import-resolved):'
  if (header.length > maxChars) {
    return markerOnly
  }

  const sections = [header]
  for (let index = 0; index < usages.length; index += 1) {
    const usage = usages[index]!
    const fullLine = formatUsageLineForBudget(usage)
    const omittedAfterLine = usages.length - index - 1
    const marker = omittedAfterLine > 0
      ? usageOmissionMarker(omittedAfterLine, remainingCharsForTrailingLine([...sections, fullLine], maxChars))
      : ''
    const fullCandidate = joinSections([...sections, fullLine, marker])
    if (fullCandidate.length <= maxChars) {
      sections.push(fullLine)
      continue
    }

    if (omittedAfterLine > 0) {
      for (const markerVariant of usageOmissionMarkerVariants(omittedAfterLine)) {
        const lineBudget = maxChars
          - joinSections(sections).length
          - 1
          - markerVariant.length
          - 1
        const truncatedLine = formatUsageLineForBudget(usage, lineBudget)
        if (!truncatedLine) {
          continue
        }

        const truncatedCandidate = joinSections([...sections, truncatedLine, markerVariant])
        if (truncatedCandidate.length <= maxChars) {
          return truncatedCandidate
        }
      }
    } else {
      const truncatedLine = formatUsageLineForBudget(usage, maxChars - joinSections(sections).length - 1)
      if (truncatedLine) {
        const truncatedCandidate = joinSections([...sections, truncatedLine])
        if (truncatedCandidate.length <= maxChars) {
          return truncatedCandidate
        }
      }
    }

    const omitted = usages.length - (sections.length - 1)
    for (const fallbackMarker of usageOmissionMarkerVariants(omitted)) {
      const fallback = joinSections([...sections, fallbackMarker])
      if (fallback.length <= maxChars) {
        return fallback
      }
    }

    return markerOnly
  }

  return joinSections(sections)
}

function formatUsageLineRaw(usage: SymbolUsage): string {
  return `- ${usage.file}:${usage.line} | ${usage.snippet}`
}

function formatUsageLineForBudget(usage: SymbolUsage, maxChars?: number): string {
  const prefix = `- ${usage.file}:${usage.line} | `
  const snippet = usage.snippet.replace(/\n+/g, ' ').trimEnd()
  if (maxChars === undefined || prefix.length + snippet.length <= maxChars) {
    return `${prefix}${snippet}`
  }
  if (prefix.length > maxChars) {
    return ''
  }

  return `${prefix}${truncateWithEllipsis(snippet, maxChars - prefix.length)}`
}

function formatHitSymbol(hit: SearchHit): string {
  if (!hit.symbol) {
    return ''
  }

  return ` ${[hit.parent, hit.symbol].filter(Boolean).join(' > ')}`
}

export function formatMcpSymbols(definitions: SymbolDefinition[], options: FormatMcpSymbolsOptions = {}): string {
  if (definitions.length === 0) {
    return 'no_symbols'
  }

  const rendered = definitions.map(formatMcpSymbolDefinition)
  const output = rendered.join('\n')
  const maxTokens = options.maxTokens
  if (maxTokens === undefined || output.length <= maxTokens * 4) {
    return output
  }

  return fitSymbolOutputForBudget(definitions, rendered, maxTokens * 4)
}

function formatMcpSymbolDefinition(definition: SymbolDefinition, index: number): string {
  const header = formatMcpSymbolHeader(definition, index)
  // The top exact match carries a paste-ready body so the identifier resolves
  // in a single call; render it with the same line-numbered block as search.
  if (definition.body !== undefined) {
    return `${header}\n${formatBodyBlock(definition.body, definition.range.startLine)}`
  }
  return header
}

function formatMcpSymbolHeader(definition: SymbolDefinition, index: number): string {
  return `#${index + 1} ${definition.kind} ${definition.name} ${definition.file}:${formatRange(definition.range.startLine, definition.range.endLine)}`
}

function fitSymbolOutputForBudget(definitions: SymbolDefinition[], rendered: string[], maxChars: number): string {
  const omittedAfterFirst = definitions.length - 1
  const firstOnlyMarker = omittedAfterFirst > 0
    ? symbolOmissionMarker(omittedAfterFirst, Math.max(0, maxChars - 2))
    : symbolBodyTruncationMarker(Math.max(0, maxChars - 2))
  const firstOnlyBudget = maxCharsForFirstHit(maxChars, firstOnlyMarker)
  if (rendered[0]!.length > firstOnlyBudget) {
    const first = formatMcpSymbolDefinitionForBudget(definitions[0]!, 0, firstOnlyBudget)
    return firstOnlyMarker ? [first, firstOnlyMarker].filter(Boolean).join('\n') : first
  }

  const parts = [rendered[0]!]
  for (let index = 1; index < rendered.length; index += 1) {
    const candidate = [...parts, rendered[index]!]
    const omitted = definitions.length - 1 - (candidate.length - 1)
    const marker = omitted > 0 ? symbolOmissionMarker(omitted, Math.max(0, maxChars - 2)) : undefined
    const candidateOutput = marker ? [...candidate, marker].join('\n') : candidate.join('\n')
    if (candidateOutput.length <= maxChars) {
      parts.push(rendered[index]!)
      continue
    }
    break
  }

  const omitted = definitions.length - parts.length
  const marker = omitted > 0 ? symbolOmissionMarker(omitted, Math.max(0, maxChars - 2)) : undefined
  const outputParts = marker ? [...parts, marker] : parts

  const output = outputParts.join('\n')
  return output.length <= maxChars ? output : truncateWithEllipsis(output, maxChars)
}

function formatMcpSymbolDefinitionForBudget(definition: SymbolDefinition, index: number, maxChars: number): string {
  const header = formatMcpSymbolHeader(definition, index)
  if (definition.body === undefined || maxChars <= header.length + 1) {
    return truncateWithEllipsis(header, maxChars)
  }

  const bodyBudget = maxChars - header.length - 1
  const body = truncateSymbolBodyBlock(formatBodyBlock(definition.body, definition.range.startLine), bodyBudget)
  return body ? `${header}\n${body}` : truncateWithEllipsis(header, maxChars)
}

function truncateSymbolBodyBlock(body: string, maxChars: number): string {
  if (maxChars <= 0) {
    return ''
  }
  if (body.length <= maxChars) {
    return body
  }

  return truncateWithEllipsis(body, maxChars).replace(/\n+$/g, '')
}

function symbolOmissionMarker(omitted: number, maxChars?: number): string {
  const full = `symbols_omitted=${omitted}; refine name/kind/path_glob or raise max_tokens.`
  if (maxChars === undefined || full.length <= maxChars) {
    return full
  }

  const compact = `symbols_omitted=${omitted}; raise max_tokens`
  if (compact.length <= maxChars) {
    return compact
  }

  const bare = `symbols_omitted=${omitted}`
  return bare.length <= maxChars ? bare : ''
}

function symbolBodyTruncationMarker(maxChars?: number): string {
  const full = 'symbol_body_truncated=true; refine name/kind/path_glob or raise max_tokens.'
  if (maxChars === undefined || full.length <= maxChars) {
    return full
  }

  const compact = 'symbol_body_truncated=true; raise max_tokens'
  if (compact.length <= maxChars) {
    return compact
  }

  const bare = 'symbol_body_truncated=true'
  return bare.length <= maxChars ? bare : ''
}

export function formatMcpGrepHits(hits: GrepHit[], options: FormatMcpGrepHitsOptions = {}): string {
  if (hits.length === 0) {
    return 'no_matches'
  }

  const maxTokens = options.maxTokens
  if (maxTokens === undefined) {
    return hits.map((hit) => formatMcpGrepHit(hit)).join('\n')
  }

  const maxChars = maxTokens * 4
  const rendered: string[] = []
  let usedChars = 0

  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index]!
    const line = formatMcpGrepHit(hit)
    const separatorChars = rendered.length === 0 ? 0 : 1
    if (usedChars + separatorChars + line.length <= maxChars) {
      rendered.push(line)
      usedChars += separatorChars + line.length
      continue
    }

    if (rendered.length === 0) {
      const omitted = hits.length - 1
      const marker = omitted > 0 ? grepOmissionMarker(omitted, Math.max(0, maxChars - 2)) : undefined
      const firstHit = formatMcpGrepHit(hit, maxCharsForFirstHit(maxChars, marker))
      return marker ? withGrepOmissionMarker([firstHit], marker) : firstHit
    }

    return fitGrepOutputWithMarker(rendered, hits.length - index, maxChars)
  }

  return rendered.join('\n')
}

export function formatMcpReadChunk(content: string, options: FormatMcpReadChunkOptions = {}): string {
  const maxTokens = options.maxTokens
  if (maxTokens === undefined) {
    return content
  }

  const maxChars = maxTokens * 4
  if (content.length <= maxChars) {
    return content
  }

  const marker = readChunkTruncationMarker(Math.max(0, maxChars - 1))
  if (!marker) {
    return truncateWithEllipsis('content_truncated=true', maxChars)
  }

  const contentBudget = Math.max(0, maxChars - marker.length - 1)
  const truncatedContent = truncateReadChunkContent(content, contentBudget)
  if (!truncatedContent) {
    return marker.length <= maxChars ? marker : truncateWithEllipsis(marker, maxChars)
  }

  return `${truncatedContent}\n${marker}`
}

function truncateReadChunkContent(content: string, maxChars: number): string {
  if (maxChars <= 0) {
    return ''
  }
  if (content.length <= maxChars) {
    return content
  }

  const truncated = truncateWithEllipsis(content, maxChars)
  return truncated.replace(/\n+$/g, '')
}

function readChunkTruncationMarker(maxChars?: number): string {
  const full = 'content_truncated=true; raise max_tokens or narrow the chunk/range.'
  if (maxChars === undefined || full.length <= maxChars) {
    return full
  }

  const compact = 'content_truncated=true; raise max_tokens'
  if (compact.length <= maxChars) {
    return compact
  }

  const bare = 'content_truncated=true'
  return bare.length <= maxChars ? bare : ''
}

function formatMcpGrepHit(hit: GrepHit, maxChars?: number): string {
  const range = formatRange(hit.range.startLine, hit.range.endLine)
  const suffix = `:${range}:${hit.column} | `
  const prefix = maxChars === undefined ? `${hit.file}${suffix}` : formatGrepPrefix(hit.file, suffix, maxChars)
  const snippet = compactSnippet(hit.snippet, 5).split('\n').join(' ↩ ')

  if (maxChars === undefined || prefix.length + snippet.length <= maxChars) {
    return `${prefix}${snippet}`
  }

  return `${prefix}${truncateWithEllipsis(snippet, maxChars - prefix.length)}`
}

function formatGrepPrefix(file: string, suffix: string, maxChars: number): string {
  const prefix = `${file}${suffix}`
  if (prefix.length <= maxChars) {
    return prefix
  }

  const fileChars = Math.max(0, maxChars - suffix.length - 1)
  if (fileChars > 0) {
    return `…${file.slice(-fileChars)}${suffix}`
  }

  return suffix.length <= maxChars ? suffix : suffix.slice(-maxChars)
}

function fitGrepOutputWithMarker(rendered: string[], omitted: number, maxChars: number): string {
  const kept = [...rendered]
  let omittedCount = omitted
  let marker = grepOmissionMarker(omittedCount, Math.max(0, maxChars - 2))

  while (kept.length > 1 && joinedLength(kept, marker) > maxChars) {
    kept.pop()
    omittedCount += 1
    marker = grepOmissionMarker(omittedCount, Math.max(0, maxChars - 2))
  }

  if (!marker) {
    return formatMcpGrepLineForBudget(kept[0]!, maxChars)
  }

  if (joinedLength(kept, marker) <= maxChars) {
    return withGrepOmissionMarker(kept, marker)
  }

  const line = formatMcpGrepLineForBudget(kept[0]!, maxCharsForFirstHit(maxChars, marker))
  return marker ? withGrepOmissionMarker([line], marker) : line
}

function formatMcpGrepLineForBudget(line: string, maxChars: number): string {
  const separator = ' | '
  const separatorIndex = line.indexOf(separator)
  if (separatorIndex < 0 || line.length <= maxChars) {
    return line
  }

  let prefix = line.slice(0, separatorIndex + separator.length)
  const snippet = line.slice(separatorIndex + separator.length)
  if (prefix.length > maxChars) {
    prefix = `…${prefix.slice(-(Math.max(0, maxChars - 1)))}`
  }
  return `${prefix}${truncateWithEllipsis(snippet, maxChars - prefix.length)}`
}

function maxCharsForFirstHit(maxChars: number, marker: string | undefined): number {
  return marker === undefined ? maxChars : Math.max(0, maxChars - marker.length - 1)
}

function joinedLength(rendered: string[], marker: string): number {
  return rendered.join('\n').length + 1 + marker.length
}

function searchHitOmissionMarker(omitted: number, maxChars?: number): string {
  return firstMarkerThatFits(searchHitOmissionMarkerVariants(omitted), maxChars)
}

function usageOmissionMarker(omitted: number, maxChars?: number): string {
  return firstMarkerThatFits(usageOmissionMarkerVariants(omitted), maxChars)
}

function grepOmissionMarker(omitted: number, maxChars?: number): string {
  const full = `matches_omitted=${omitted}; refine path_glob/max_matches or raise max_tokens.`
  if (maxChars === undefined || full.length <= maxChars) {
    return full
  }

  const compact = `matches_omitted=${omitted}; raise max_tokens`
  if (compact.length <= maxChars) {
    return compact
  }

  const bare = `matches_omitted=${omitted}`
  return bare.length <= maxChars ? bare : ''
}

function withGrepOmissionMarker(rendered: string[], marker: string): string {
  return `${rendered.join('\n')}\n${marker}`
}

function searchHitOmissionMarkerVariants(omitted: number): string[] {
  return [
    `hits_omitted=${omitted}; refine query/path_glob/k or raise max_tokens.`,
    `hits_omitted=${omitted}; raise max_tokens`,
    `hits_omitted=${omitted}`
  ]
}

function usageOmissionMarkerVariants(omitted: number): string[] {
  return [
    `usages_omitted=${omitted}; raise max_tokens`,
    `usages_omitted=${omitted}`
  ]
}

function firstMarkerThatFits(markers: string[], maxChars?: number): string {
  if (maxChars === undefined) {
    return markers[0] ?? ''
  }

  for (const marker of markers) {
    if (marker.length <= maxChars) {
      return marker
    }
  }

  return ''
}

function joinSections(sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section)).join('\n')
}

function remainingCharsForTrailingLine(sections: string[], maxChars: number): number {
  const output = joinSections(sections)
  return Math.max(0, maxChars - output.length - 1)
}

function appendSearchTokensLineIfFits(output: string, tokensLine: string, maxChars: number): string {
  if (!output) {
    return tokensLine.length <= maxChars ? tokensLine : truncateWithEllipsis(tokensLine, maxChars)
  }

  const withTokens = `${output}\n${tokensLine}`
  return withTokens.length <= maxChars ? withTokens : output
}

function truncateSearchBlock(block: string, maxChars: number): string {
  if (maxChars <= 0) {
    return ''
  }
  if (block.length <= maxChars) {
    return block
  }

  const lines = block.split('\n')
  const kept: string[] = []
  let used = 0

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const separator = kept.length === 0 ? 0 : 1
    if (used + separator + line.length <= maxChars) {
      kept.push(line)
      used += separator + line.length
      continue
    }

    const lineBudget = maxChars - used - separator
    if (lineBudget > 0) {
      const truncatedLine = truncateWithEllipsis(line, lineBudget)
      if (truncatedLine) {
        kept.push(truncatedLine)
      }
    }
    break
  }

  if (kept.length === 0) {
    return truncateWithEllipsis(block, maxChars)
  }

  return kept.join('\n').replace(/\n+$/g, '')
}

function truncateWithEllipsis(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return ''
  }
  if (text.length <= maxChars) {
    return text
  }
  if (maxChars === 1) {
    return '…'
  }
  return `${text.slice(0, maxChars - 1).trimEnd()}…`
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
