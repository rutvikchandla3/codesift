import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCallback, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'

import { VOYAGE_RERANK_PROVIDER_ID, openRepo, type FindSymbolOptions, type GrepHit, type GrepOptions, type Range, type SearchHit, type SearchOptions, type SymbolDefinition } from '@codesift/core'
import { DEFAULT_MCP_FIND_SYMBOL_MAX_TOKENS, DEFAULT_MCP_GREP_MAX_TOKENS, DEFAULT_MCP_READ_CHUNK_MAX_TOKENS, formatMcpGrepHits, formatMcpReadChunk, formatMcpSearchHits, formatMcpSymbols } from '@codesift/mcp'

const execFile = promisify(execFileCallback)

const QUERY_TYPE_ORDER = ['nl-concept', 'exact-identifier', 'string-literal', 'error-trace', 'symbol-def'] as const
const DEFAULT_RESULT_LIMIT = 10
const DEFAULT_INSPECTION_LIMIT = 5
const DEFAULT_LATENCY_TOLERANCE_MS = 15

const moduleDir = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_MANIFEST_PATH = resolve(moduleDir, '../fixtures/manifest.json')
export const DEFAULT_LOSSES_PATH = resolve(moduleDir, '../losses.json')

export type GoldenQueryType = (typeof QUERY_TYPE_ORDER)[number]
export type EvalTool = 'codesift' | 'ripgrep'
export type LossAxis = 'success' | 'tokens' | 'latency.cold' | 'latency.warm' | 'precision'

export interface BenchmarkRepo {
  id: string
  language: string
  repoPath?: string
  gitUrl?: string
  ref?: string
}

export interface ExpectedTarget {
  file: string
  symbol?: string
  /**
   * Per-target line range for a MULTI-TARGET golden (one entry per co-relevant
   * definition). When present it scopes the match to this specific target's lines,
   * so distinct same-named definitions in different files are scored independently.
   * Single-target goldens keep using the query-level {@link GoldenQuery.expectedLineRange}.
   */
  lineRange?: Range
}

export interface GoldenQuery {
  id: string
  repoId: string
  queryType: GoldenQueryType
  query: string
  expected: ExpectedTarget[]
  expectedLineRange?: Range
  expectedUsages?: string[]
  grepPattern?: string
  pathGlob?: string
}

export interface EvalRun {
  tool: EvalTool
  repoId: string
  queryId: string
  queryType: GoldenQueryType
  tokensToResolution: number
  callsToResolution: number
  wallClockMs: {
    cold: number
    warm: number
  }
  taskSuccess: boolean
  recallAt5: number
  recallAt10: number
  meanReciprocalRank: number
}

export interface LossEntry {
  repoId: string
  queryId: string
  queryType: GoldenQueryType
  axes: LossAxis[]
}

export interface LossBudget {
  losses: LossEntry[]
}

export interface QueryTypeSummary {
  queryType: GoldenQueryType
  queryCount: number
  codesift: AggregatedMetrics
  ripgrep: AggregatedMetrics
  delta: {
    tokensToResolution: number
    callsToResolution: number
    coldLatencyMs: number
    warmLatencyMs: number
    successRate: number
  }
}

export interface AggregatedMetrics {
  tokensToResolutionMedian: number
  callsToResolutionMedian: number
  coldLatencyMedianMs: number
  warmLatencyMedianMs: number
  successRate: number
  recallAt5: number
  recallAt10: number
  meanReciprocalRank: number
  mrrAt1: number
}

export interface RoutingProof {
  totalTasks: number
  codesiftPreferred: number
  hostGrepPreferred: number
  selections: Array<{ queryId: string; queryType: GoldenQueryType; selectedTool: 'search_code' | 'find_symbol' | 'grep_code' }>
}

export interface UsageReportEntry {
  repoId: string
  queryId: string
  queryType: GoldenQueryType
  usageRecall: number
  withUsagesCallsDelta: number
  expectedUsageCount: number
  matchedUsageFiles: string[]
  missingUsageFiles: string[]
  withoutUsagesCallsToResolution: number
  withUsagesCallsToResolution: number
}

export interface RerankReportEntry {
  repoId: string
  queryId: string
  baselineMrrAt1: number
  rerankMrrAt1: number
  mrrAt1Delta: number
}

export interface RerankReport {
  enabled: boolean
  entries: RerankReportEntry[]
  averageMrrAt1Delta: number
}

export interface EvalSummary {
  runs: EvalRun[]
  perQueryType: QueryTypeSummary[]
  losses: LossEntry[]
  exactRecallViolations: Array<{ queryId: string; repoId: string; queryType: GoldenQueryType; recallAt5: number }>
  routingProof: RoutingProof
  usagesReport: UsageReportEntry[]
  rerankReport: RerankReport
}

export interface EvalManifest {
  repos: BenchmarkRepo[]
  queries: GoldenQuery[]
}

export interface EvaluateManifestOptions {
  manifestPath?: string
  resultLimit?: number
  inspectionLimit?: number
  latencyToleranceMs?: number
}

export interface CandidateResult {
  file: string
  range: Range
  symbol?: string
  id?: string
}

interface PolicyRun {
  tokensToResolution: number
  callsToResolution: number
  taskSuccess: boolean
  recallAt5: number
  recallAt10: number
  meanReciprocalRank: number
}

interface SearchPolicyRun extends PolicyRun {
  hits: SearchHit[]
}

interface ManifestFileShape {
  repos?: BenchmarkRepo[]
  queries?: GoldenQuery[]
}

export interface RipgrepHit {
  file: string
  range: Range
  column: number
  match: string
  snippet: string
  context: Array<{ line: number; text: string }>
}

export function createEmptyManifest(): EvalManifest {
  return {
    repos: [],
    queries: []
  }
}

export function summarizeEmptyRun(): EvalSummary {
  return {
    runs: [],
    perQueryType: [],
    losses: [],
    exactRecallViolations: [],
    routingProof: proveRoutingPolicy([]),
    usagesReport: [],
    rerankReport: emptyRerankReport()
  }
}

export async function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH): Promise<EvalManifest> {
  const content = await readFile(manifestPath, 'utf8')
  const raw = JSON.parse(content) as ManifestFileShape

  return {
    repos: normalizeRepos(raw.repos ?? [], dirname(manifestPath)),
    queries: normalizeQueries(raw.queries ?? [])
  }
}

export async function readLossBudget(lossesPath = DEFAULT_LOSSES_PATH): Promise<LossBudget> {
  try {
    const content = await readFile(lossesPath, 'utf8')
    const parsed = JSON.parse(content) as { losses?: LossEntry[] }
    return { losses: normalizeLosses(parsed.losses ?? []) }
  } catch {
    return { losses: [] }
  }
}

export async function writeLossBudget(lossesPath: string, budget: LossBudget): Promise<void> {
  const normalized = normalizeLosses(budget.losses)
  await writeFile(lossesPath, `${JSON.stringify({ losses: normalized }, null, 2)}\n`, 'utf8')
}

export async function evaluateManifest(manifest: EvalManifest, options: EvaluateManifestOptions = {}): Promise<EvalSummary> {
  if (manifest.repos.length === 0 || manifest.queries.length === 0) {
    return summarizeEmptyRun()
  }

  const resultLimit = normalizePositiveInteger(options.resultLimit, DEFAULT_RESULT_LIMIT)
  const inspectionLimit = normalizePositiveInteger(options.inspectionLimit, DEFAULT_INSPECTION_LIMIT)
  const latencyToleranceMs = normalizeLatencyTolerance(options.latencyToleranceMs)

  const runs: EvalRun[] = []
  const usagesReport: UsageReportEntry[] = []
  const rerankEntries: RerankReportEntry[] = []
  const rerankEnabled = isRerankEvalEnabled()

  for (const repo of manifest.repos) {
    const queries = manifest.queries.filter((query) => query.repoId === repo.id)
    if (queries.length === 0) {
      continue
    }

    const stagedRepoRoot = await stageBenchmarkRepo(repo)
    let repoHandle: Awaited<ReturnType<typeof openRepo>> | undefined
    try {
      repoHandle = await openRepo(stagedRepoRoot)
      await repoHandle.sync({ rebuild: true })

      for (const query of queries) {
        const codesiftRun = await measureCodesiftRun(stagedRepoRoot, repoHandle, query, resultLimit, inspectionLimit)
        const ripgrepRun = await measureRipgrepRun(stagedRepoRoot, query, resultLimit, inspectionLimit)

        runs.push(codesiftRun, ripgrepRun)

        const usagesEntry = await measureWithUsagesReport(repoHandle, query, codesiftRun, resultLimit, inspectionLimit)
        if (usagesEntry) {
          usagesReport.push(usagesEntry)
        }

        if (rerankEnabled && query.queryType === 'nl-concept') {
          rerankEntries.push(await measureRerankReport(repoHandle, query, codesiftRun, resultLimit, inspectionLimit))
        }
      }
    } finally {
      await repoHandle?.close()
      await removeStagedRepo(stagedRepoRoot)
    }
  }

  const losses = computeLosses(manifest, runs, latencyToleranceMs)
  const exactRecallViolations = runs
    .filter((run) => run.tool === 'codesift' && (run.queryType === 'exact-identifier' || run.queryType === 'string-literal'))
    .filter((run) => run.recallAt5 < 1)
    .map((run) => ({ queryId: run.queryId, repoId: run.repoId, queryType: run.queryType, recallAt5: run.recallAt5 }))

  return {
    runs,
    perQueryType: summarizeByQueryType(runs, manifest),
    losses,
    exactRecallViolations,
    routingProof: proveRoutingPolicy(manifest.queries),
    usagesReport,
    rerankReport: rerankEnabled
      ? {
          enabled: true,
          entries: rerankEntries,
          averageMrrAt1Delta: average(rerankEntries.map((entry) => entry.mrrAt1Delta))
        }
      : emptyRerankReport()
  }
}

export function diffLossBudgets(current: LossBudget, baseline: LossBudget): { newLosses: LossEntry[]; resolvedLosses: LossEntry[] } {
  const baselineKeys = new Set(flattenLossAxes(baseline.losses))
  const currentKeys = new Set(flattenLossAxes(current.losses))

  const newLosses = current.losses
    .map((loss) => ({
      ...loss,
      axes: loss.axes.filter((axis) => !baselineKeys.has(lossKey(loss.queryId, axis)))
    }))
    .filter((loss) => loss.axes.length > 0)

  const resolvedLosses = baseline.losses
    .map((loss) => ({
      ...loss,
      axes: loss.axes.filter((axis) => !currentKeys.has(lossKey(loss.queryId, axis)))
    }))
    .filter((loss) => loss.axes.length > 0)

  return { newLosses, resolvedLosses }
}

export function formatSummary(summary: EvalSummary): string {
  if (summary.runs.length === 0) {
    return 'No benchmark queries configured.'
  }

  const lines = [
    'codesift eval summary',
    '(cold latency = prebuilt-index, MCP-spawn only — does NOT measure first-run indexing)',
    '(recall = set-recall: fraction of co-relevant targets in top-k; mrr@1 = rank-1 precision)',
    ''
  ]

  for (const row of summary.perQueryType) {
    lines.push(
      `${row.queryType} (${row.queryCount} queries)`,
      `  tokens median    codesift=${formatNumber(row.codesift.tokensToResolutionMedian)} rg=${formatNumber(row.ripgrep.tokensToResolutionMedian)} Δ=${formatSignedNumber(row.delta.tokensToResolution)}`,
      `  calls median     codesift=${formatNumber(row.codesift.callsToResolutionMedian)} rg=${formatNumber(row.ripgrep.callsToResolutionMedian)} Δ=${formatSignedNumber(row.delta.callsToResolution)}`,
      `  cold latency ms  codesift=${formatNumber(row.codesift.coldLatencyMedianMs)} rg=${formatNumber(row.ripgrep.coldLatencyMedianMs)} Δ=${formatSignedNumber(row.delta.coldLatencyMs)}`,
      `  warm latency ms  codesift=${formatNumber(row.codesift.warmLatencyMedianMs)} rg=${formatNumber(row.ripgrep.warmLatencyMedianMs)} Δ=${formatSignedNumber(row.delta.warmLatencyMs)}`,
      `  success rate     codesift=${formatRatio(row.codesift.successRate)} rg=${formatRatio(row.ripgrep.successRate)} Δ=${formatSignedNumber(row.delta.successRate)}`,
      `  recall@5 / mrr   codesift=${formatRatio(row.codesift.recallAt5)} / ${formatRatio(row.codesift.meanReciprocalRank)} rg=${formatRatio(row.ripgrep.recallAt5)} / ${formatRatio(row.ripgrep.meanReciprocalRank)}`,
      `  mrr@1            codesift=${formatRatio(row.codesift.mrrAt1)} rg=${formatRatio(row.ripgrep.mrrAt1)}`,
      ''
    )
  }

  if (summary.usagesReport.length > 0) {
    lines.push('with_usages report-only')
    for (const entry of summary.usagesReport) {
      lines.push(
        `  - ${entry.queryId}: usageRecall=${formatRatio(entry.usageRecall)} savedCallsΔ=${formatSignedNumber(entry.withUsagesCallsDelta)} bundled=${formatNumber(entry.withUsagesCallsToResolution)} baseline=${formatNumber(entry.withoutUsagesCallsToResolution)} matched=${entry.matchedUsageFiles.join(', ') || 'none'} missing=${entry.missingUsageFiles.join(', ') || 'none'}`
      )
    }
    lines.push('')
  }

  if (summary.rerankReport.enabled) {
    lines.push(`rerank report-only (avg mrr@1 Δ=${formatSignedNumber(summary.rerankReport.averageMrrAt1Delta)})`)
    for (const entry of summary.rerankReport.entries) {
      lines.push(
        `  - ${entry.queryId}: baseline=${formatRatio(entry.baselineMrrAt1)} rerank=${formatRatio(entry.rerankMrrAt1)} mrr@1Δ=${formatSignedNumber(entry.mrrAt1Delta)}`
      )
    }
    lines.push('')
  }

  if (summary.exactRecallViolations.length > 0) {
    lines.push('exact recall floor violations')
    for (const violation of summary.exactRecallViolations) {
      lines.push(`  - ${violation.queryId} (${violation.queryType}) recall@5=${formatRatio(violation.recallAt5)}`)
    }
    lines.push('')
  }

  lines.push(
    `routing proof: codesift=${summary.routingProof.codesiftPreferred}/${summary.routingProof.totalTasks} host_grep=${summary.routingProof.hostGrepPreferred}`
  )
  for (const selection of summary.routingProof.selections) {
    lines.push(`  - ${selection.queryId}: ${selection.selectedTool}`)
  }
  lines.push('')

  lines.push(`losses: ${summary.losses.length}`)
  for (const loss of summary.losses) {
    lines.push(`  - ${loss.queryId}: ${loss.axes.join(', ')}`)
  }

  return lines.join('\n').trimEnd()
}

export function isRerankEvalEnabled(): boolean {
  return process.env.CODESIFT_EVAL_RERANK === '1' && Boolean(process.env.VOYAGE_API_KEY?.trim())
}

function emptyRerankReport(): RerankReport {
  return {
    enabled: false,
    entries: [],
    averageMrrAt1Delta: 0
  }
}

function normalizeRepos(repos: BenchmarkRepo[], manifestDir: string): BenchmarkRepo[] {
  return repos.map((repo) => {
    if (!repo.repoPath && (!repo.gitUrl || !repo.ref)) {
      throw new Error(`Benchmark repo ${repo.id} must define either repoPath or gitUrl+ref`)
    }

    return {
      ...repo,
      ...(repo.repoPath ? { repoPath: resolve(manifestDir, repo.repoPath) } : {})
    }
  })
}

function normalizeQueries(queries: GoldenQuery[]): GoldenQuery[] {
  return queries.map((query) => ({
    ...query,
    expected: query.expected.map((target) => ({ ...target })),
    ...(query.expectedUsages ? { expectedUsages: [...query.expectedUsages] } : {})
  }))
}

function normalizeLosses(losses: LossEntry[]): LossEntry[] {
  return [...losses]
    .map((loss) => ({
      ...loss,
      axes: [...new Set(loss.axes)].sort() as LossAxis[]
    }))
    .sort((left, right) => `${left.queryId}:${left.axes.join(',')}`.localeCompare(`${right.queryId}:${right.axes.join(',')}`))
}

async function stageBenchmarkRepo(repo: BenchmarkRepo): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), `codesift-eval-${repo.id}-`))
  const stagedRepoRoot = join(tempRoot, repo.id)

  if (repo.gitUrl && repo.ref) {
    await clonePinnedRepo(repo.gitUrl, repo.ref, stagedRepoRoot)
    return stagedRepoRoot
  }

  if (!repo.repoPath) {
    throw new Error(`Benchmark repo ${repo.id} has no repoPath`)
  }

  await cp(repo.repoPath, stagedRepoRoot, { recursive: true })
  return stagedRepoRoot
}

async function clonePinnedRepo(gitUrl: string, ref: string, target: string): Promise<void> {
  await execFile('git', ['init', target])
  await execFile('git', ['-C', target, 'remote', 'add', 'origin', gitUrl])
  await execFile('git', ['-C', target, 'fetch', '--depth', '1', 'origin', ref], { maxBuffer: 10 * 1024 * 1024 })
  await execFile('git', ['-C', target, 'checkout', '--detach', 'FETCH_HEAD'])
}

async function removeStagedRepo(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      if (process.platform !== 'win32' || (!isNodeErrorCode(error, 'EBUSY') && !isNodeErrorCode(error, 'EPERM'))) {
        throw error
      }

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100 * (attempt + 1)))
    }
  }

  try {
    await rm(path, { recursive: true, force: true })
  } catch (error) {
    if (process.platform !== 'win32' || (!isNodeErrorCode(error, 'EBUSY') && !isNodeErrorCode(error, 'EPERM'))) {
      throw error
    }
  }
}

async function measureCodesiftRun(
  repoRoot: string,
  repo: Awaited<ReturnType<typeof openRepo>>,
  query: GoldenQuery,
  resultLimit: number,
  inspectionLimit: number
): Promise<EvalRun> {
  const coldMeasurement = await measure(async () => {
    await runCodesiftStdioFirstResult(repoRoot, query, resultLimit)
    return runCodesiftPolicy(repo, query, resultLimit, inspectionLimit)
  })
  const warmMeasurement = await measure(() => runCodesiftPolicy(repo, query, resultLimit, inspectionLimit))

  return {
    tool: 'codesift',
    repoId: query.repoId,
    queryId: query.id,
    queryType: query.queryType,
    tokensToResolution: coldMeasurement.value.tokensToResolution,
    callsToResolution: coldMeasurement.value.callsToResolution,
    wallClockMs: {
      cold: coldMeasurement.ms,
      warm: warmMeasurement.ms
    },
    taskSuccess: coldMeasurement.value.taskSuccess,
    recallAt5: coldMeasurement.value.recallAt5,
    recallAt10: coldMeasurement.value.recallAt10,
    meanReciprocalRank: coldMeasurement.value.meanReciprocalRank
  }
}

async function measureRipgrepRun(repoRoot: string, query: GoldenQuery, resultLimit: number, inspectionLimit: number): Promise<EvalRun> {
  const coldMeasurement = await measure(() => runRipgrepPolicy(repoRoot, query, resultLimit, inspectionLimit))
  const warmMeasurement = await measure(() => runRipgrepPolicy(repoRoot, query, resultLimit, inspectionLimit))

  return {
    tool: 'ripgrep',
    repoId: query.repoId,
    queryId: query.id,
    queryType: query.queryType,
    tokensToResolution: coldMeasurement.value.tokensToResolution,
    callsToResolution: coldMeasurement.value.callsToResolution,
    wallClockMs: {
      cold: coldMeasurement.ms,
      warm: warmMeasurement.ms
    },
    taskSuccess: coldMeasurement.value.taskSuccess,
    recallAt5: coldMeasurement.value.recallAt5,
    recallAt10: coldMeasurement.value.recallAt10,
    meanReciprocalRank: coldMeasurement.value.meanReciprocalRank
  }
}

async function measureWithUsagesReport(
  repo: Awaited<ReturnType<typeof openRepo>>,
  query: GoldenQuery,
  baselineRun: EvalRun,
  resultLimit: number,
  inspectionLimit: number
): Promise<UsageReportEntry | null> {
  if (!query.expectedUsages || query.expectedUsages.length === 0) {
    return null
  }

  const withUsagesRun = await runSearchPolicy(repo, query, resultLimit, inspectionLimit, { withUsages: true })
  const topDefinitionHit = withUsagesRun.hits.find((hit) => hit.symbol && hit.kind && hit.kind !== 'file' && hit.language)
  const actualUsageFiles = [...new Set((topDefinitionHit?.usages ?? []).map((usage) => normalizePath(usage.file)))].sort()
  const expectedUsageFiles = [...new Set(query.expectedUsages.map((file) => normalizePath(file)))].sort()
  const matchedUsageFiles = expectedUsageFiles.filter((file) => actualUsageFiles.includes(file))
  const missingUsageFiles = expectedUsageFiles.filter((file) => !actualUsageFiles.includes(file))
  // Report-only saved-call model: without bundling, the agent first resolves the
  // definition (existing policy) and then spends one extra "who calls X?" lookup.
  const withoutUsagesCallsToResolution = baselineRun.callsToResolution + 1

  return {
    repoId: query.repoId,
    queryId: query.id,
    queryType: query.queryType,
    usageRecall: expectedUsageFiles.length === 0 ? 0 : matchedUsageFiles.length / expectedUsageFiles.length,
    withUsagesCallsDelta: withoutUsagesCallsToResolution - withUsagesRun.callsToResolution,
    expectedUsageCount: expectedUsageFiles.length,
    matchedUsageFiles,
    missingUsageFiles,
    withoutUsagesCallsToResolution,
    withUsagesCallsToResolution: withUsagesRun.callsToResolution
  }
}

async function measureRerankReport(
  repo: Awaited<ReturnType<typeof openRepo>>,
  query: GoldenQuery,
  baselineRun: EvalRun,
  resultLimit: number,
  inspectionLimit: number
): Promise<RerankReportEntry> {
  const reranked = await withConfiguredVoyageReranker(() => runSearchPolicy(repo, query, resultLimit, inspectionLimit, { rerank: true }))
  const baselineMrrAt1 = baselineRun.meanReciprocalRank === 1 ? 1 : 0
  const rerankMrrAt1 = reranked.meanReciprocalRank === 1 ? 1 : 0

  return {
    repoId: query.repoId,
    queryId: query.id,
    baselineMrrAt1,
    rerankMrrAt1,
    mrrAt1Delta: rerankMrrAt1 - baselineMrrAt1
  }
}

async function runCodesiftStdioFirstResult(repoRoot: string, query: GoldenQuery, resultLimit: number): Promise<void> {
  const cliPath = resolve(moduleDir, '../../cli/dist/bin.js')
  const child = spawn(process.execPath, [cliPath, 'mcp', repoRoot], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const messages: unknown[] = []
  let stdoutBuffer = ''
  let parseError: Error | undefined

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    let newlineIndex = stdoutBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim()
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      if (line) {
        try {
          messages.push(JSON.parse(line))
        } catch (error) {
          parseError = error instanceof Error ? error : new Error(String(error))
        }
      }
      newlineIndex = stdoutBuffer.indexOf('\n')
    }
  })

  try {
    sendJsonRpc(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'codesift-eval', version: '0.0.0' }
      }
    })
    await waitForJsonRpcMessage(messages, (message) => rpcId(message) === 1, () => parseError, child)
    sendJsonRpc(child, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    sendJsonRpc(child, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: buildCodesiftToolCall(query, resultLimit)
    })
    await waitForJsonRpcMessage(messages, (message) => rpcId(message) === 2, () => parseError, child)
  } finally {
    child.stdin.end()
    child.kill()
    await waitForChildExit(child)
  }
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  await new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      resolvePromise()
    }, 5_000)

    child.once('exit', () => {
      clearTimeout(timeout)
      resolvePromise()
    })
  })
}

function buildCodesiftToolCall(query: GoldenQuery, resultLimit: number): { name: string; arguments: Record<string, unknown> } {
  const pathGlob = query.pathGlob ? { path_glob: query.pathGlob } : {}

  switch (query.queryType) {
    case 'symbol-def':
    case 'exact-identifier':
      return { name: 'find_symbol', arguments: { name: query.query, max_tokens: DEFAULT_MCP_FIND_SYMBOL_MAX_TOKENS, ...pathGlob } }
    case 'string-literal':
    case 'error-trace':
      return {
        name: 'grep_code',
        arguments: { pattern: query.grepPattern ?? query.query, max_matches: resultLimit, max_tokens: DEFAULT_MCP_GREP_MAX_TOKENS, ...pathGlob }
      }
    case 'nl-concept':
      return {
        name: 'search_code',
        arguments: { query: query.query, k: resultLimit, max_tokens: 700, ...pathGlob }
      }
  }
}

function sendJsonRpc(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

async function waitForJsonRpcMessage(
  messages: unknown[],
  predicate: (message: unknown) => boolean,
  getParseError: () => Error | undefined,
  child: ChildProcessWithoutNullStreams
): Promise<unknown> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 10_000) {
    const parseError = getParseError()
    if (parseError) {
      throw parseError
    }

    const found = messages.find(predicate)
    if (found) {
      return found
    }

    if (child.exitCode !== null) {
      throw new Error(`MCP child exited early with code ${child.exitCode}`)
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }

  throw new Error('Timed out waiting for JSON-RPC message')
}

function rpcId(message: unknown): number | undefined {
  if (typeof message !== 'object' || message === null || !('id' in message)) {
    return undefined
  }

  const id = (message as { id?: unknown }).id
  return typeof id === 'number' ? id : undefined
}

function buildSearchOptions(query: GoldenQuery, resultLimit: number, overrides: Partial<SearchOptions> = {}): SearchOptions {
  const options: SearchOptions = {
    k: resultLimit,
    maxTokens: 700,
    ...overrides
  }

  if (query.pathGlob) {
    options.pathGlob = query.pathGlob
  }

  return options
}

async function runSearchPolicy(
  repo: Awaited<ReturnType<typeof openRepo>>,
  query: GoldenQuery,
  resultLimit: number,
  inspectionLimit: number,
  overrides: Partial<SearchOptions> = {}
): Promise<SearchPolicyRun> {
  const hits = await repo.search(query.query, buildSearchOptions(query, resultLimit, overrides))
  const candidates = hits.map(candidateFromSearch)
  const score = scoreCandidates(candidates, query, inspectionLimit)
  const matchingRank = score.matchingRank

  let tokensToResolution = estimateTokenCount(formatMcpSearchHits(hits))
  let callsToResolution = 1

  if (matchingRank !== null && query.expected.length === 1) {
    const matchingHit = hits[matchingRank - 1]
    const bodyResolves =
      matchingHit?.body !== undefined &&
      query.expectedLineRange !== undefined &&
      bodyOverlapsExpected(matchingHit, query.expectedLineRange)

    if (!bodyResolves && matchingHit?.id) {
      const followUp = await readChunkSafely(repo, matchingHit.id)
      if (followUp !== null) {
        tokensToResolution += estimateTokenCount(followUp)
        callsToResolution = 2
      }
    }
  }

  return {
    hits,
    tokensToResolution,
    callsToResolution,
    taskSuccess: score.taskSuccess,
    recallAt5: score.recallAt5,
    recallAt10: score.recallAt10,
    meanReciprocalRank: score.meanReciprocalRank
  }
}

async function withConfiguredVoyageReranker<T>(operation: () => Promise<T>): Promise<T> {
  const previousReranker = process.env.CODESIFT_RERANKER
  process.env.CODESIFT_RERANKER = VOYAGE_RERANK_PROVIDER_ID

  try {
    return await operation()
  } finally {
    if (previousReranker === undefined) {
      delete process.env.CODESIFT_RERANKER
    } else {
      process.env.CODESIFT_RERANKER = previousReranker
    }
  }
}

async function runCodesiftPolicy(repo: Awaited<ReturnType<typeof openRepo>>, query: GoldenQuery, resultLimit: number, inspectionLimit: number): Promise<PolicyRun> {
  switch (query.queryType) {
    case 'symbol-def':
    case 'exact-identifier': {
      const options: FindSymbolOptions = {}
      if (query.pathGlob) {
        options.pathGlob = query.pathGlob
      }

      const definitions = (await repo.findSymbol(query.query, options)).slice(0, resultLimit)
      const candidates = definitions.map(candidateFromSymbol)
      const score = scoreCandidates(candidates, query, inspectionLimit)
      const matchingRank = score.matchingRank

      // Honest one-call accounting: a SINGLE-target find_symbol resolves in one call
      // only when the matching definition arrives with an inlined body covering the
      // expected lines; a body-less match (ambiguous lookup, withBody off, or a
      // non-top match) still forces a follow-up read — count it as 2 calls. A
      // MULTI-target lookup ("where are all the Xs") is answered by the location set
      // in a single call, so it is never charged a per-body follow-up.
      let tokensToResolution = estimateTokenCount(formatMcpSymbols(definitions, { maxTokens: DEFAULT_MCP_FIND_SYMBOL_MAX_TOKENS }))
      let callsToResolution = 1

      if (matchingRank !== null && query.expected.length === 1) {
        const matchingDef = definitions[matchingRank - 1]
        const bodyResolves =
          matchingDef?.body !== undefined &&
          query.expectedLineRange !== undefined &&
          rangesOverlap(matchingDef.range, query.expectedLineRange)

        if (!bodyResolves && matchingDef) {
          const followUp = await readRangeSafely(repo, matchingDef.file, matchingDef.range)
          if (followUp !== null) {
            tokensToResolution += estimateTokenCount(followUp)
            callsToResolution = 2
          }
        }
      }

      return {
        tokensToResolution,
        callsToResolution,
        taskSuccess: score.taskSuccess,
        recallAt5: score.recallAt5,
        recallAt10: score.recallAt10,
        meanReciprocalRank: score.meanReciprocalRank
      }
    }
    case 'string-literal':
    case 'error-trace': {
      const grepOptions: GrepOptions = {
        maxMatches: resultLimit
      }
      if (query.pathGlob) {
        grepOptions.pathGlob = query.pathGlob
      }

      const pattern = query.grepPattern ?? query.query
      const hits = await repo.grep(pattern, grepOptions)
      const candidates = hits.map(candidateFromGrep)
      const tokens = estimateTokenCount(formatMcpGrepHits(hits, { maxTokens: DEFAULT_MCP_GREP_MAX_TOKENS }))
      return evaluateRankedCandidates(candidates, query, tokens, inspectionLimit)
    }
    case 'nl-concept': {
      return runSearchPolicy(repo, query, resultLimit, inspectionLimit)
    }
  }
}

async function runRipgrepPolicy(repoRoot: string, query: GoldenQuery, resultLimit: number, inspectionLimit: number): Promise<PolicyRun> {
  const hits = await runRipgrep(repoRoot, query, resultLimit)
  const candidates = hits.map(candidateFromRipgrep)
  const tokens = estimateTokenCount(formatRipgrepHits(hits))
  return evaluateRankedCandidates(candidates, query, tokens, inspectionLimit)
}

const RIPGREP_CONTEXT_LINES = 5

export async function runRipgrep(repoRoot: string, query: GoldenQuery, resultLimit: number): Promise<RipgrepHit[]> {
  const pattern = query.grepPattern ?? query.query
  const args = ['--json', '--line-number', '--color', 'never', '--context', String(RIPGREP_CONTEXT_LINES), '--max-count', String(resultLimit)]

  if (query.queryType === 'exact-identifier' || query.queryType === 'symbol-def') {
    args.push('--fixed-strings', '--word-regexp')
  } else {
    args.push('--fixed-strings')
  }

  if (query.pathGlob) {
    args.push('--glob', query.pathGlob)
  }

  args.push(pattern, '.')

  let stdout: string
  try {
    const result = await execFile('rg', args, { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 })
    stdout = result.stdout
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string') {
      stdout = error.stdout
    } else {
      throw new Error(`ripgrep (rg) is required for eval runs: ${String(error)}`)
    }
  }

  // Parse in two passes. ripgrep emits after-context line events AFTER the match
  // event they belong to, so a single pass only sees before-context when building a
  // hit's window. The first pass populates contextByFile from ALL context events and
  // records match events in stream order; the second pass builds hits against the now
  // complete contextByFile so collectRipgrepContext sees the full ±5 window.
  const contextByFile = new Map<string, Array<{ line: number; text: string }>>()
  const matchEvents: RipgrepMatchEvent[] = []

  for (const line of stdout.split('\n').filter(Boolean)) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }

    if (isRipgrepContextEvent(event)) {
      const relativePath = relative(repoRoot, resolve(repoRoot, event.data.path.text)).replace(/\\/g, '/')
      const lines = contextByFile.get(relativePath) ?? []
      lines.push({ line: event.data.line_number, text: event.data.lines.text.replace(/\n$/, '') })
      contextByFile.set(relativePath, lines)
      continue
    }

    if (isRipgrepMatchEvent(event)) {
      matchEvents.push(event)
    }
  }

  const hits: RipgrepHit[] = []

  for (const event of matchEvents) {
    const pathText = event.data.path.text
    const relativePath = relative(repoRoot, resolve(repoRoot, pathText)).replace(/\\/g, '/')
    const lineNumber = event.data.line_number
    const snippet = event.data.lines.text.replace(/\n$/, '')
    const surrounding = contextByFile.get(relativePath) ?? []
    const context = collectRipgrepContext(surrounding, lineNumber, snippet)

    for (const submatch of event.data.submatches) {
      hits.push({
        file: relativePath,
        range: { startLine: lineNumber, endLine: lineNumber },
        column: submatch.start + 1,
        match: submatch.match.text,
        snippet,
        context
      })
    }
  }

  return hits.slice(0, resultLimit)
}

// Validated match-event shape, kept in lockstep with isRipgrepMatchEvent's type guard.
interface RipgrepMatchEvent {
  type: 'match'
  data: {
    path: { text: string }
    lines: { text: string }
    line_number: number
    submatches: Array<{ match: { text: string }; start: number }>
  }
}

function collectRipgrepContext(
  surrounding: Array<{ line: number; text: string }>,
  matchLine: number,
  matchText: string
): Array<{ line: number; text: string }> {
  const window = new Map<number, string>()
  for (const entry of surrounding) {
    if (Math.abs(entry.line - matchLine) <= RIPGREP_CONTEXT_LINES) {
      window.set(entry.line, entry.text)
    }
  }
  window.set(matchLine, matchText)

  return [...window.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([line, text]) => ({ line, text }))
}

function evaluateRankedCandidates(candidates: CandidateResult[], query: GoldenQuery, tokensToResolution: number, inspectionLimit: number): PolicyRun {
  const score = scoreCandidates(candidates, query, inspectionLimit)

  return {
    tokensToResolution,
    callsToResolution: 1,
    taskSuccess: score.taskSuccess,
    recallAt5: score.recallAt5,
    recallAt10: score.recallAt10,
    meanReciprocalRank: score.meanReciprocalRank
  }
}

function firstMatchingRank(candidates: CandidateResult[], query: GoldenQuery): number | null {
  const index = candidates.findIndex((candidate) => candidateMatchesExpected(candidate, query))
  return index === -1 ? null : index + 1
}

export function candidateMatchesExpected(candidate: CandidateResult, query: GoldenQuery): boolean {
  return query.expected.some((target) => candidateMatchesTarget(candidate, target, query))
}

function candidateMatchesTarget(candidate: CandidateResult, target: ExpectedTarget, query: GoldenQuery): boolean {
  if (normalizePath(candidate.file) !== normalizePath(target.file)) {
    return false
  }

  if (target.symbol && candidate.symbol && target.symbol.toLowerCase() !== candidate.symbol.toLowerCase()) {
    return false
  }

  // A per-target lineRange scopes a multi-target match to that one definition;
  // single-target goldens fall back to the query-level expectedLineRange. A target
  // with neither matches on file (+ symbol) alone.
  const lineRange = target.lineRange ?? (query.expected.length === 1 ? query.expectedLineRange : undefined)
  if (lineRange) {
    return rangesOverlap(candidate.range, lineRange)
  }

  return true
}

// Number of DISTINCT expected targets covered by some candidate within the top-k.
// For single-target goldens this is 0 or 1, so set-recall reduces exactly to today's
// binary recall; for multi-target goldens it is the count of co-relevant definitions
// surfaced, so a ranking change that silently drops a co-relevant hit is now visible.
function coveredTargetCount(candidates: CandidateResult[], query: GoldenQuery, k: number): number {
  const top = candidates.slice(0, k)
  let covered = 0
  for (const target of query.expected) {
    if (top.some((candidate) => candidateMatchesTarget(candidate, target, query))) {
      covered += 1
    }
  }
  return covered
}

// Shared ranking scorer. taskSuccess requires EVERY co-relevant target within the
// inspection window (for single-target this is "first match within inspectionLimit");
// recall is set-recall (fraction of targets in top-k); MRR remains first-relevant-rank.
function scoreCandidates(
  candidates: CandidateResult[],
  query: GoldenQuery,
  inspectionLimit: number
): { matchingRank: number | null; taskSuccess: boolean; recallAt5: number; recallAt10: number; meanReciprocalRank: number } {
  const matchingRank = firstMatchingRank(candidates, query)
  const targetCount = Math.max(1, query.expected.length)

  return {
    matchingRank,
    taskSuccess: coveredTargetCount(candidates, query, inspectionLimit) === query.expected.length,
    recallAt5: coveredTargetCount(candidates, query, 5) / targetCount,
    recallAt10: coveredTargetCount(candidates, query, 10) / targetCount,
    meanReciprocalRank: matchingRank === null ? 0 : 1 / matchingRank
  }
}

function candidateFromSearch(hit: SearchHit): CandidateResult {
  return {
    file: hit.file,
    range: hit.range,
    id: hit.id,
    ...(hit.symbol ? { symbol: hit.symbol } : {})
  }
}

function candidateFromSymbol(definition: SymbolDefinition): CandidateResult {
  return {
    file: definition.file,
    range: definition.range,
    symbol: definition.name,
    id: definition.id
  }
}

function candidateFromGrep(hit: GrepHit): CandidateResult {
  return {
    file: hit.file,
    range: hit.range
  }
}

export function candidateFromRipgrep(hit: RipgrepHit): CandidateResult {
  // ripgrep is invoked with -C5, so a hit truthfully resolves anything within its
  // collected ±5 window, not just the match line. Span the candidate's range over
  // the window so an expectedLineRange inside the context is scored as a hit. Fall
  // back to the match range when no context was collected. hit.range is left intact
  // because formatRipgrepHits relies on it for the header line.
  if (hit.context.length === 0) {
    return {
      file: hit.file,
      range: hit.range
    }
  }

  const lineNumbers = hit.context.map((entry) => entry.line)
  return {
    file: hit.file,
    range: {
      startLine: Math.min(...lineNumbers),
      endLine: Math.max(...lineNumbers)
    }
  }
}

export function proveRoutingPolicy(queries: GoldenQuery[]): RoutingProof {
  const selections = queries.map((query) => ({
    queryId: query.id,
    queryType: query.queryType,
    selectedTool: selectedCodesiftTool(query.queryType)
  }))

  return {
    totalTasks: selections.length,
    codesiftPreferred: selections.length,
    hostGrepPreferred: 0,
    selections
  }
}

function selectedCodesiftTool(queryType: GoldenQueryType): 'search_code' | 'find_symbol' | 'grep_code' {
  switch (queryType) {
    case 'symbol-def':
    case 'exact-identifier':
      return 'find_symbol'
    case 'string-literal':
    case 'error-trace':
      return 'grep_code'
    case 'nl-concept':
      return 'search_code'
  }
}

function computeLosses(manifest: EvalManifest, runs: EvalRun[], latencyToleranceMs: number): LossEntry[] {
  const losses: LossEntry[] = []

  for (const query of manifest.queries) {
    const codesift = runs.find((run) => run.tool === 'codesift' && run.queryId === query.id)
    const ripgrep = runs.find((run) => run.tool === 'ripgrep' && run.queryId === query.id)

    if (!codesift || !ripgrep) {
      continue
    }

    const axes: LossAxis[] = []

    if (ripgrep.taskSuccess && !codesift.taskSuccess) {
      axes.push('success')
    }

    if (codesift.taskSuccess && ripgrep.taskSuccess && codesift.tokensToResolution > ripgrep.tokensToResolution) {
      axes.push('tokens')
    }

    if (codesift.taskSuccess && ripgrep.taskSuccess && codesift.wallClockMs.cold > ripgrep.wallClockMs.cold + latencyToleranceMs) {
      axes.push('latency.cold')
    }

    if (codesift.taskSuccess && ripgrep.taskSuccess && codesift.wallClockMs.warm > ripgrep.wallClockMs.warm + latencyToleranceMs) {
      axes.push('latency.warm')
    }

    // Precision regression guard (self-referential, independent of ripgrep): codesift
    // resolves the answer but a false positive outranks the first relevant hit, so the
    // most-trusted rank-1 result is wrong. mrr === 1 iff the first relevant target is at
    // rank 1. Recorded in the baseline for queries where it already holds, so it gates
    // only NEW rank-1 regressions — exactly the accuracy-for-recall trade a relaxation
    // or re-ranking change can otherwise make invisibly.
    if (codesift.taskSuccess && codesift.meanReciprocalRank !== 1) {
      axes.push('precision')
    }

    if (axes.length > 0) {
      losses.push({
        repoId: query.repoId,
        queryId: query.id,
        queryType: query.queryType,
        axes
      })
    }
  }

  return normalizeLosses(losses)
}

function summarizeByQueryType(runs: EvalRun[], manifest: EvalManifest): QueryTypeSummary[] {
  return QUERY_TYPE_ORDER.map((queryType) => {
    const codesiftRuns = runs.filter((run) => run.tool === 'codesift' && run.queryType === queryType)
    const ripgrepRuns = runs.filter((run) => run.tool === 'ripgrep' && run.queryType === queryType)
    const queryCount = manifest.queries.filter((query) => query.queryType === queryType).length

    if (queryCount === 0) {
      return null
    }

    const codesift = aggregateRuns(codesiftRuns)
    const ripgrep = aggregateRuns(ripgrepRuns)

    return {
      queryType,
      queryCount,
      codesift,
      ripgrep,
      delta: {
        tokensToResolution: codesift.tokensToResolutionMedian - ripgrep.tokensToResolutionMedian,
        callsToResolution: codesift.callsToResolutionMedian - ripgrep.callsToResolutionMedian,
        coldLatencyMs: codesift.coldLatencyMedianMs - ripgrep.coldLatencyMedianMs,
        warmLatencyMs: codesift.warmLatencyMedianMs - ripgrep.warmLatencyMedianMs,
        successRate: codesift.successRate - ripgrep.successRate
      }
    }
  }).filter((summary): summary is QueryTypeSummary => summary !== null)
}

function aggregateRuns(runs: EvalRun[]): AggregatedMetrics {
  if (runs.length === 0) {
    return {
      tokensToResolutionMedian: 0,
      callsToResolutionMedian: 0,
      coldLatencyMedianMs: 0,
      warmLatencyMedianMs: 0,
      successRate: 0,
      recallAt5: 0,
      recallAt10: 0,
      meanReciprocalRank: 0,
      mrrAt1: 0
    }
  }

  return {
    tokensToResolutionMedian: median(runs.map((run) => run.tokensToResolution)),
    callsToResolutionMedian: median(runs.map((run) => run.callsToResolution)),
    coldLatencyMedianMs: median(runs.map((run) => run.wallClockMs.cold)),
    warmLatencyMedianMs: median(runs.map((run) => run.wallClockMs.warm)),
    successRate: average(runs.map((run) => (run.taskSuccess ? 1 : 0))),
    recallAt5: average(runs.map((run) => run.recallAt5)),
    recallAt10: average(runs.map((run) => run.recallAt10)),
    meanReciprocalRank: average(runs.map((run) => run.meanReciprocalRank)),
    mrrAt1: average(runs.map((run) => (run.meanReciprocalRank === 1 ? 1 : 0)))
  }
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0
  }

  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)

  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0
  }

  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

async function measure<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now()
  const value = await operation()
  return {
    value,
    ms: performance.now() - start
  }
}

function estimateTokenCount(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4))
}

function rangesOverlap(left: Range, right: Range): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine
}

function bodyOverlapsExpected(hit: SearchHit, expected: Range): boolean {
  const bodyRange = hit.range ?? hit.snippetRange
  return rangesOverlap(bodyRange, expected)
}

async function readChunkSafely(repo: Awaited<ReturnType<typeof openRepo>>, id: string): Promise<string | null> {
  try {
    return formatMcpReadChunk(await repo.readChunk(id), { maxTokens: DEFAULT_MCP_READ_CHUNK_MAX_TOKENS })
  } catch {
    return null
  }
}

async function readRangeSafely(repo: Awaited<ReturnType<typeof openRepo>>, file: string, range: Range): Promise<string | null> {
  try {
    return await repo.readRange(file, range.startLine, range.endLine)
  } catch {
    return null
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

function formatRipgrepHits(hits: RipgrepHit[]): string {
  if (hits.length === 0) {
    return 'no_matches'
  }

  return hits
    .map((hit) => {
      const header = `${hit.file}:${hit.range.startLine}:${hit.column}`
      const body = hit.context.map((entry) => `${entry.line} | ${entry.text}`).join('\n')
      return `${header}\n${body}`
    })
    .join('\n')
}

function flattenLossAxes(losses: LossEntry[]): string[] {
  return losses.flatMap((loss) => loss.axes.map((axis) => lossKey(loss.queryId, axis)))
}

function lossKey(queryId: string, axis: LossAxis): string {
  return `${queryId}:${axis}`
}

function formatNumber(value: number): string {
  return value.toFixed(1)
}

function formatSignedNumber(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`
}

function formatRatio(value: number): string {
  return value.toFixed(2)
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback
  }

  return Math.floor(value)
}

function normalizeLatencyTolerance(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_LATENCY_TOLERANCE_MS
  }

  return value
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

function isRipgrepMatchEvent(value: unknown): value is RipgrepMatchEvent {
  if (!value || typeof value !== 'object') {
    return false
  }

  const matchEvent = value as { type?: unknown; data?: unknown }
  if (matchEvent.type !== 'match' || !matchEvent.data || typeof matchEvent.data !== 'object') {
    return false
  }

  const data = matchEvent.data as { path?: unknown; lines?: unknown; line_number?: unknown; submatches?: unknown }
  return typeof data.line_number === 'number' && Array.isArray(data.submatches)
}

function isRipgrepContextEvent(value: unknown): value is {
  type: 'context'
  data: {
    path: { text: string }
    lines: { text: string }
    line_number: number
  }
} {
  if (!value || typeof value !== 'object') {
    return false
  }

  const contextEvent = value as { type?: unknown; data?: unknown }
  if (contextEvent.type !== 'context' || !contextEvent.data || typeof contextEvent.data !== 'object') {
    return false
  }

  const data = contextEvent.data as { path?: unknown; lines?: unknown; line_number?: unknown }
  if (typeof data.line_number !== 'number' || !data.path || typeof data.path !== 'object' || !data.lines || typeof data.lines !== 'object') {
    return false
  }

  return typeof (data.path as { text?: unknown }).text === 'string' && typeof (data.lines as { text?: unknown }).text === 'string'
}
