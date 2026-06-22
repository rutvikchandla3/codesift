import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_MCP_FIND_SYMBOL_MAX_TOKENS, DEFAULT_MCP_READ_CHUNK_MAX_TOKENS } from '@codesift/mcp'

import { DEFAULT_MANIFEST_PATH, candidateFromRipgrep, candidateMatchesExpected, createEmptyManifest, diffLossBudgets, evaluateManifest, formatSummary, isRerankEvalEnabled, loadManifest, proveRoutingPolicy, runRipgrep, summarizeEmptyRun, type GoldenQuery, type GoldenQueryType, type RipgrepHit } from '../src/index.js'

const temporaryDirectories: string[] = []
const stableLocalTokenCeilings: Partial<Record<GoldenQueryType, number>> = {
  'nl-concept': 180,
  'symbol-def': 125,
  'exact-identifier': 95,
  'string-literal': 40,
  'error-trace': 40
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true })
    })
  )
})

describe('@codesift/eval', () => {
  it('creates empty manifests for future golden sets', () => {
    expect(createEmptyManifest()).toEqual({
      repos: [],
      queries: []
    })
  })

  it('summarizes an empty run without metrics or losses', () => {
    expect(summarizeEmptyRun()).toEqual({
      runs: [],
      perQueryType: [],
      losses: [],
      exactRecallViolations: [],
      routingProof: {
        totalTasks: 0,
        codesiftPreferred: 0,
        hostGrepPreferred: 0,
        selections: []
      },
      usagesReport: [],
      rerankReport: {
        enabled: false,
        entries: [],
        averageMrrAt1Delta: 0
      }
    })
  })

  it('loads the default fixture manifest', async () => {
    const manifest = await loadManifest(DEFAULT_MANIFEST_PATH)

    expect(manifest.repos.length).toBeGreaterThanOrEqual(8)
    expect(manifest.queries.length).toBeGreaterThanOrEqual(20)
    expect(manifest.repos.some((repo) => repo.id === 'collision-ts')).toBe(true)
    // A multi-target ambiguous-identifier golden now exists for set-recall coverage.
    expect(manifest.queries.some((query) => query.expected.length > 1)).toBe(true)
    expect(manifest.queries.some((query) => query.queryType === 'exact-identifier')).toBe(true)
    expect(manifest.queries.some((query) => query.queryType === 'nl-concept')).toBe(true)
    expect(manifest.repos.map((repo) => repo.language)).toEqual(
      expect.arrayContaining(['go', 'java', 'ruby', 'rust'])
    )
  })

  it('evaluates local M3 language spot-check fixtures with codesift success', async () => {
    const manifest = await loadManifest(DEFAULT_MANIFEST_PATH)
    const m3Manifest = {
      repos: manifest.repos.filter((repo) => repo.id.startsWith('m3-')),
      queries: manifest.queries.filter((query) => query.repoId.startsWith('m3-'))
    }
    const summary = await evaluateManifest(m3Manifest, { resultLimit: 5, inspectionLimit: 5, latencyToleranceMs: Number.POSITIVE_INFINITY })
    const codesiftRuns = summary.runs.filter((run) => run.tool === 'codesift')

    expect(codesiftRuns).toHaveLength(12)
    expect(codesiftRuns.every((run) => run.taskSuccess)).toBe(true)
    expect(summary.exactRecallViolations).toEqual([])
    expect(summary.routingProof.selections.map((selection) => selection.selectedTool)).toEqual(
      expect.arrayContaining(['search_code', 'find_symbol', 'grep_code'])
    )
  }, 30_000)

  it('keeps stable local codesift runs at one-call rank-1 resolution with low token envelopes', async () => {
    const manifest = await loadManifest(DEFAULT_MANIFEST_PATH)
    const stableLocalManifest = {
      repos: manifest.repos.filter((repo) => repo.id.startsWith('m3-') || repo.id === 'collision-ts' || repo.id === 'usages-ts'),
      queries: manifest.queries.filter((query) => query.repoId.startsWith('m3-') || query.repoId === 'collision-ts' || query.repoId === 'usages-ts')
    }
    const summary = await evaluateManifest(stableLocalManifest, { resultLimit: 10, inspectionLimit: 5, latencyToleranceMs: Number.POSITIVE_INFINITY })
    const codesiftRuns = summary.runs.filter((run) => run.tool === 'codesift')

    expect(codesiftRuns).toHaveLength(stableLocalManifest.queries.length)
    for (const run of codesiftRuns) {
      expect(run.taskSuccess).toBe(true)
      expect(run.callsToResolution).toBe(1)
      expect(run.meanReciprocalRank).toBe(1)

      const tokenCeiling = stableLocalTokenCeilings[run.queryType]
      expect(tokenCeiling).toBeDefined()
      expect(run.tokensToResolution).toBeLessThanOrEqual(tokenCeiling!)
    }
  }, 30_000)

  it('accounts string-literal grep results with the MCP default token budget', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-eval-grep-budget-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(
      join(repoRoot, 'src', 'noisy.ts'),
      Array.from({ length: 160 }, (_, index) => `export const noisy${index} = 'LOUD_LITERAL_${index}_${'x'.repeat(80)}'`).join('\n'),
      'utf8'
    )

    const summary = await evaluateManifest({
      repos: [{ id: 'noisy-grep', language: 'typescript', repoPath: repoRoot }],
      queries: [
        {
          id: 'noisy-literal',
          repoId: 'noisy-grep',
          queryType: 'string-literal',
          query: 'LOUD_LITERAL',
          grepPattern: 'LOUD_LITERAL',
          expected: [{ file: 'src/noisy.ts' }],
          expectedLineRange: { startLine: 1, endLine: 1 }
        }
      ]
    }, { resultLimit: 160, inspectionLimit: 5, latencyToleranceMs: Number.POSITIVE_INFINITY })

    const codesiftRun = summary.runs.find((run) => run.tool === 'codesift')
    expect(codesiftRun?.taskSuccess).toBe(true)
    expect(codesiftRun?.meanReciprocalRank).toBe(1)
    expect(codesiftRun?.tokensToResolution).toBeLessThanOrEqual(730)
  }, 30_000)

  it('accounts body-less symbol follow-ups through the read_chunk MCP budget', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-eval-symbol-followup-budget-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })

    const makeFunction = (returnValue: string) => [
      'export function inflateTarget() {',
      ...Array.from({ length: 140 }, (_, index) => `  const noisy${index} = '${returnValue}_${index}_${'x'.repeat(180)}'`),
      `  return '${returnValue}'`,
      '}',
      ''
    ].join('\n')

    await Promise.all([
      writeFile(join(repoRoot, 'src', 'a.ts'), makeFunction('target'), 'utf8'),
      writeFile(join(repoRoot, 'src', 'b.ts'), makeFunction('otherB'), 'utf8'),
      writeFile(join(repoRoot, 'src', 'c.ts'), makeFunction('otherC'), 'utf8'),
      writeFile(join(repoRoot, 'src', 'd.ts'), makeFunction('otherD'), 'utf8')
    ])

    const summary = await evaluateManifest({
      repos: [{ id: 'symbol-followup-budget', language: 'typescript', repoPath: repoRoot }],
      queries: [
        {
          id: 'symbol-followup-budget',
          repoId: 'symbol-followup-budget',
          queryType: 'symbol-def',
          query: 'inflateTarget',
          expected: [{ file: 'src/a.ts', symbol: 'inflateTarget' }],
          expectedLineRange: { startLine: 1, endLine: 143 }
        }
      ]
    }, { resultLimit: 10, inspectionLimit: 5, latencyToleranceMs: Number.POSITIVE_INFINITY })

    const codesiftRun = summary.runs.find((run) => run.tool === 'codesift')

    expect(codesiftRun?.taskSuccess).toBe(true)
    expect(codesiftRun?.callsToResolution).toBe(2)
    expect(codesiftRun?.tokensToResolution).toBeLessThanOrEqual(
      DEFAULT_MCP_FIND_SYMBOL_MAX_TOKENS + DEFAULT_MCP_READ_CHUNK_MAX_TOKENS
    )
  }, 30_000)

  it('measures end-to-end calls-to-resolution truthfully across both tools', async () => {
    const manifest = await loadManifest(DEFAULT_MANIFEST_PATH)
    const m3Manifest = {
      repos: manifest.repos.filter((repo) => repo.id.startsWith('m3-')),
      queries: manifest.queries.filter((query) => query.repoId.startsWith('m3-'))
    }
    const summary = await evaluateManifest(m3Manifest, { resultLimit: 5, inspectionLimit: 5, latencyToleranceMs: Number.POSITIVE_INFINITY })

    // Every run reports a concrete, end-to-end call count and token count.
    for (const run of summary.runs) {
      expect(run.callsToResolution).toBeGreaterThanOrEqual(1)
      expect(run.tokensToResolution).toBeGreaterThan(0)
    }

    // nl-concept resolves end-to-end on codesift: either the inlined body covers the
    // expected lines (1 call) or the harness simulates the follow-up read (2 calls).
    const codesiftConcept = summary.runs.filter((run) => run.tool === 'codesift' && run.queryType === 'nl-concept')
    expect(codesiftConcept).toHaveLength(4)
    expect(codesiftConcept.every((run) => run.taskSuccess)).toBe(true)
    expect(codesiftConcept.every((run) => run.callsToResolution === 1 || run.callsToResolution === 2)).toBe(true)

    // ripgrep is invoked with context (-C 5); a found, covering match resolves in one call.
    const ripgrepRuns = summary.runs.filter((run) => run.tool === 'ripgrep')
    expect(ripgrepRuns.every((run) => run.callsToResolution === 1)).toBe(true)
    expect(ripgrepRuns.filter((run) => run.taskSuccess).every((run) => run.meanReciprocalRank > 0)).toBe(true)
  }, 30_000)

  it('surfaces per-query-type calls median and MRR@1 in the aggregated summary', async () => {
    const manifest = await loadManifest(DEFAULT_MANIFEST_PATH)
    const m3Manifest = {
      repos: manifest.repos.filter((repo) => repo.id.startsWith('m3-')),
      queries: manifest.queries.filter((query) => query.repoId.startsWith('m3-'))
    }
    const summary = await evaluateManifest(m3Manifest, { resultLimit: 5, inspectionLimit: 5, latencyToleranceMs: Number.POSITIVE_INFINITY })

    const conceptRow = summary.perQueryType.find((row) => row.queryType === 'nl-concept')
    expect(conceptRow).toBeDefined()
    expect(conceptRow?.codesift.callsToResolutionMedian).toBeGreaterThanOrEqual(1)
    // codesift resolves every nl-concept rank-1; ripgrep cannot, so MRR@1 splits hard.
    expect(conceptRow?.codesift.mrrAt1).toBe(1)
    expect(conceptRow?.ripgrep.mrrAt1).toBe(0)
    expect(conceptRow?.delta).toHaveProperty('callsToResolution')

    const rendered = formatSummary(summary)
    expect(rendered).toContain('calls median')
    expect(rendered).toContain('mrr@1')
  }, 30_000)

  it('reports with_usages recall and saved-call delta on the local usages fixture', async () => {
    const manifest = await loadManifest(DEFAULT_MANIFEST_PATH)
    const usagesManifest = {
      repos: manifest.repos.filter((repo) => repo.id === 'usages-ts'),
      queries: manifest.queries.filter((query) => query.repoId === 'usages-ts')
    }
    const summary = await evaluateManifest(usagesManifest, { resultLimit: 5, inspectionLimit: 5, latencyToleranceMs: Number.POSITIVE_INFINITY })

    expect(summary.usagesReport).toHaveLength(1)
    expect(summary.usagesReport[0]).toMatchObject({
      queryId: 'usages-parse-token-identifier',
      repoId: 'usages-ts',
      queryType: 'exact-identifier',
      usageRecall: 1,
      expectedUsageCount: 2,
      matchedUsageFiles: ['src/api.ts', 'src/worker.ts'],
      missingUsageFiles: []
    })
    expect(summary.usagesReport[0]?.withUsagesCallsDelta).toBeGreaterThanOrEqual(1)
    expect(summary.usagesReport[0]?.withUsagesTokensToResolution).toBeGreaterThan(0)
    expect(summary.usagesReport[0]?.withUsagesCallsToResolution).toBeLessThan(summary.usagesReport[0]?.withoutUsagesCallsToResolution ?? 0)

    const rendered = formatSummary(summary)
    expect(rendered).toContain('with_usages report-only')
    expect(rendered).toContain('bundledTokens=')
    expect(rendered).toContain('usageRecall=1.00')
  }, 30_000)

  it('keeps the cloud rerank report disabled when the env gate is unset', async () => {
    const originalEvalRerank = process.env.CODESIFT_EVAL_RERANK
    const originalVoyageApiKey = process.env.VOYAGE_API_KEY
    delete process.env.CODESIFT_EVAL_RERANK
    delete process.env.VOYAGE_API_KEY

    try {
      expect(isRerankEvalEnabled()).toBe(false)

      const manifest = await loadManifest(DEFAULT_MANIFEST_PATH)
      const usagesManifest = {
        repos: manifest.repos.filter((repo) => repo.id === 'usages-ts'),
        queries: manifest.queries.filter((query) => query.repoId === 'usages-ts')
      }
      const summary = await evaluateManifest(usagesManifest, { resultLimit: 5, inspectionLimit: 5, latencyToleranceMs: Number.POSITIVE_INFINITY })

      expect(summary.rerankReport).toEqual({
        enabled: false,
        entries: [],
        averageMrrAt1Delta: 0
      })
    } finally {
      if (originalEvalRerank === undefined) {
        delete process.env.CODESIFT_EVAL_RERANK
      } else {
        process.env.CODESIFT_EVAL_RERANK = originalEvalRerank
      }

      if (originalVoyageApiKey === undefined) {
        delete process.env.VOYAGE_API_KEY
      } else {
        process.env.VOYAGE_API_KEY = originalVoyageApiKey
      }
    }
  }, 30_000)

  it('proves the deterministic agent policy prefers codesift tools over host grep', async () => {
    const manifest = await loadManifest(DEFAULT_MANIFEST_PATH)
    const proof = proveRoutingPolicy(manifest.queries)

    expect(proof.totalTasks).toBe(manifest.queries.length)
    expect(proof.codesiftPreferred).toBe(manifest.queries.length)
    expect(proof.hostGrepPreferred).toBe(0)
    expect(proof.selections.some((selection) => selection.selectedTool === 'search_code')).toBe(true)
    expect(proof.selections.some((selection) => selection.selectedTool === 'grep_code')).toBe(true)
    expect(proof.selections.some((selection) => selection.selectedTool === 'find_symbol')).toBe(true)
  })

  it('detects newly introduced losses by query axis', () => {
    const baseline = {
      losses: [
        {
          repoId: 'auth-service',
          queryId: 'auth-refresh-concept',
          queryType: 'nl-concept' as const,
          axes: ['tokens' as const]
        }
      ]
    }

    const current = {
      losses: [
        {
          repoId: 'auth-service',
          queryId: 'auth-refresh-concept',
          queryType: 'nl-concept' as const,
          axes: ['tokens' as const, 'latency.cold' as const]
        }
      ]
    }

    expect(diffLossBudgets(current, baseline)).toEqual({
      newLosses: [
        {
          repoId: 'auth-service',
          queryId: 'auth-refresh-concept',
          queryType: 'nl-concept',
          axes: ['latency.cold']
        }
      ],
      resolvedLosses: []
    })
  })

  it('matches multi-target goldens per-target by file and lineRange', () => {
    const query: GoldenQuery = {
      id: 'multi-validate',
      repoId: 'tmp',
      queryType: 'symbol-def',
      query: 'validate',
      expected: [
        { file: 'src/a.ts', symbol: 'validate', lineRange: { startLine: 3, endLine: 10 } },
        { file: 'src/b.ts', symbol: 'validate', lineRange: { startLine: 1, endLine: 13 } }
      ]
    }

    // A candidate inside target A's own range matches that target.
    expect(candidateMatchesExpected({ file: 'src/a.ts', symbol: 'validate', range: { startLine: 4, endLine: 9 } }, query)).toBe(true)
    // Same file + symbol but OUTSIDE the per-target range is not a match — per-target
    // lineRange scopes each co-relevant definition independently.
    expect(candidateMatchesExpected({ file: 'src/a.ts', symbol: 'validate', range: { startLine: 40, endLine: 45 } }, query)).toBe(false)
    // The second target is matched on its own file + range.
    expect(candidateMatchesExpected({ file: 'src/b.ts', symbol: 'validate', range: { startLine: 5, endLine: 5 } }, query)).toBe(true)
  })

  it('measures multi-target set-recall on the ambiguous-identifier collision fixture', async () => {
    const manifest = await loadManifest(DEFAULT_MANIFEST_PATH)
    const collisionManifest = {
      repos: manifest.repos.filter((repo) => repo.id === 'collision-ts'),
      queries: manifest.queries.filter((query) => query.repoId === 'collision-ts')
    }
    const summary = await evaluateManifest(collisionManifest, { resultLimit: 10, inspectionLimit: 5, latencyToleranceMs: Number.POSITIVE_INFINITY })

    const collisionRun = summary.runs.find((run) => run.tool === 'codesift' && run.queryId === 'collision-validate-symbol')
    expect(collisionRun).toBeDefined()
    // All three same-named definitions surface in the top-5 → full set-recall, and a
    // multi-target task only succeeds when EVERY co-relevant def is found.
    expect(collisionRun?.recallAt5).toBe(1)
    expect(collisionRun?.taskSuccess).toBe(true)
    // The whole location set arrives in a single find_symbol call — a multi-target
    // "where are all the Xs" lookup is never charged a per-body follow-up read.
    expect(collisionRun?.callsToResolution).toBe(1)
    // rank-1 is one of the relevant defs, so the precision axis must not fire here.
    const collisionLoss = summary.losses.find((loss) => loss.queryId === 'collision-validate-symbol')
    expect(collisionLoss?.axes ?? []).not.toContain('precision')
  }, 30_000)

  it('collects ripgrep context lines after the match line, not just before', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-eval-rg-context-'))
    temporaryDirectories.push(repoRoot)

    // The marker sits on line 8; lines 9-13 are after-context that ripgrep emits as
    // events AFTER the match event. A single-pass parse would miss them.
    const lines = Array.from({ length: 20 }, (_, index) => (index + 1 === 8 ? 'NEEDLE_MARKER token' : `filler line ${index + 1}`))
    await writeFile(join(repoRoot, 'source.txt'), `${lines.join('\n')}\n`, 'utf8')

    const query: GoldenQuery = {
      id: 'context-after',
      repoId: 'tmp',
      queryType: 'string-literal',
      query: 'NEEDLE_MARKER',
      expected: [{ file: 'source.txt' }]
    }

    const hits = await runRipgrep(repoRoot, query, 5)

    expect(hits).toHaveLength(1)
    const hit = hits[0]!
    expect(hit.range.startLine).toBe(8)

    const contextLineNumbers = hit.context.map((entry) => entry.line)
    // The full ±5 window is present, including the after-context lines 9-13.
    expect(contextLineNumbers).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(contextLineNumbers.some((line) => line > 8)).toBe(true)
  })

  it('scores a ripgrep candidate as a hit when expected lines fall inside the -C5 window', () => {
    // Match on line 40, with the collected ±5 window spanning lines 35-45.
    const hit: RipgrepHit = {
      file: 'src/service.ts',
      range: { startLine: 40, endLine: 40 },
      column: 1,
      match: 'handler',
      snippet: 'const handler = createHandler()',
      context: Array.from({ length: 11 }, (_, index) => ({ line: 35 + index, text: `line ${35 + index}` }))
    }

    const candidate = candidateFromRipgrep(hit)

    // The candidate range spans the whole context window, not just the match line.
    expect(candidate.range).toEqual({ startLine: 35, endLine: 45 })
    // hit.range is left intact for formatRipgrepHits' header.
    expect(hit.range).toEqual({ startLine: 40, endLine: 40 })

    const query: GoldenQuery = {
      id: 'context-window-hit',
      repoId: 'tmp',
      queryType: 'string-literal',
      query: 'handler',
      expected: [{ file: 'src/service.ts' }],
      // Expected lines sit inside the window but off the match line.
      expectedLineRange: { startLine: 36, endLine: 37 }
    }

    expect(candidateMatchesExpected(candidate, query)).toBe(true)

    // Sanity: the old single-line range would have missed this expected range.
    expect(candidateMatchesExpected({ file: hit.file, range: hit.range }, query)).toBe(false)
  })
})
