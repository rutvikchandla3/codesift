import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_MANIFEST_PATH, candidateFromRipgrep, candidateMatchesExpected, createEmptyManifest, diffLossBudgets, evaluateManifest, formatSummary, loadManifest, proveRoutingPolicy, runRipgrep, summarizeEmptyRun, type GoldenQuery, type RipgrepHit } from '../src/index.js'

const temporaryDirectories: string[] = []

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
      }
    })
  })

  it('loads the default fixture manifest', async () => {
    const manifest = await loadManifest(DEFAULT_MANIFEST_PATH)

    expect(manifest.repos).toHaveLength(7)
    expect(manifest.queries.length).toBeGreaterThanOrEqual(20)
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
