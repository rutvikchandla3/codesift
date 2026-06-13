import { describe, expect, it } from 'vitest'

import { DEFAULT_MANIFEST_PATH, createEmptyManifest, diffLossBudgets, evaluateManifest, loadManifest, proveRoutingPolicy, summarizeEmptyRun } from '../src/index.js'

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
})
