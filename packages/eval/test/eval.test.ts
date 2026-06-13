import { describe, expect, it } from 'vitest'

import { createEmptyManifest, summarizeEmptyRun } from '../src/index.js'

describe('@codesift/eval scaffold', () => {
  it('creates empty manifests for future golden sets', () => {
    expect(createEmptyManifest()).toEqual({
      repos: [],
      queries: []
    })
  })

  it('summarizes an empty run with zeroed metrics', () => {
    expect(summarizeEmptyRun()).toEqual({
      recallAt5: 0,
      recallAt10: 0,
      meanReciprocalRank: 0
    })
  })
})
