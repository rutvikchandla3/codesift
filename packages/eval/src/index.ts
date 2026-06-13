export interface BenchmarkRepo {
  id: string
  language: string
  gitUrl: string
  ref: string
}

export interface ExpectedTarget {
  file: string
  symbol?: string
}

export interface GoldenQuery {
  id: string
  repoId: string
  query: string
  expected: ExpectedTarget[]
}

export interface EvalSummary {
  recallAt5: number
  recallAt10: number
  meanReciprocalRank: number
}

export interface EvalManifest {
  repos: BenchmarkRepo[]
  queries: GoldenQuery[]
}

export function createEmptyManifest(): EvalManifest {
  return {
    repos: [],
    queries: []
  }
}

export function summarizeEmptyRun(): EvalSummary {
  return {
    recallAt5: 0,
    recallAt10: 0,
    meanReciprocalRank: 0
  }
}
