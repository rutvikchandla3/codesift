import { describe, expect, it } from 'vitest'

import { DEFAULT_MANIFEST_PATH, createEmptyManifest, diffLossBudgets, loadManifest, proveRoutingPolicy, summarizeEmptyRun } from '../src/index.js'

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

    expect(manifest.repos).toHaveLength(3)
    expect(manifest.queries.length).toBeGreaterThanOrEqual(10)
    expect(manifest.queries.some((query) => query.queryType === 'exact-identifier')).toBe(true)
    expect(manifest.queries.some((query) => query.queryType === 'nl-concept')).toBe(true)
  })

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
