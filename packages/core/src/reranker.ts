import { readConfig } from './config.js'
import { VoyageReranker, VOYAGE_RERANK_PROVIDER_ID } from './providers/voyage-rerank.js'
import type { RerankOptions, RerankResult, Reranker } from './types.js'

/**
 * Id of the deterministic in-memory fixture reranker. Test-only, registered via
 * {@link registerFixtureReranker}. Scores documents by query-term overlap so the
 * rerank stage can be exercised with NO network — under the offline gate too.
 */
export const FIXTURE_RERANKER_ID = 'fixture-overlap-v1'

const rerankers = new Map<string, Reranker>()

/**
 * Register the cloud (learned) rerankers so they resolve via {@link getReranker} /
 * appear in {@link listRerankers}. Constructing the provider performs no network
 * I/O; egress happens only when `rerank` is actually called. Idempotent. Rerankers
 * are always opt-in: nothing here flips on the default search path.
 */
export function registerCloudRerankers(): void {
  if (!rerankers.has(VOYAGE_RERANK_PROVIDER_ID)) {
    rerankers.set(VOYAGE_RERANK_PROVIDER_ID, new VoyageReranker())
  }
}

registerCloudRerankers()

export function registerReranker(reranker: Reranker): void {
  if (!reranker.id.trim()) {
    throw new Error('Reranker id is required')
  }

  if (rerankers.has(reranker.id)) {
    throw new Error(`Reranker already registered: ${reranker.id}`)
  }

  rerankers.set(reranker.id, reranker)
}

export function getReranker(id: string): Reranker | undefined {
  return rerankers.get(id)
}

export function listRerankers(): Reranker[] {
  return [...rerankers.values()]
}

/**
 * Resolve the active reranker. Precedence: explicit `explicitId` >
 * `CODESIFT_RERANKER` env > `.codesift/config.json` `reranker` field > none.
 * Returns undefined when nothing is configured, so the default behavior (no
 * reranking) is unchanged.
 */
export function resolveReranker(root: string, explicitId?: string): Reranker | undefined {
  const envId = process.env.CODESIFT_RERANKER?.trim()
  const configuredId = readConfig(root).reranker?.trim()
  const rerankerId = explicitId?.trim() || envId || configuredId
  if (!rerankerId) {
    return undefined
  }

  return rerankers.get(rerankerId)
}

/**
 * Register the deterministic in-memory fixture reranker. Test-only; scores each
 * document by how many query-term occurrences it contains (case-insensitive
 * term-frequency overlap), so the rerank stage is exercisable with zero network.
 * Idempotent.
 */
export function registerFixtureReranker(): void {
  if (rerankers.has(FIXTURE_RERANKER_ID)) {
    return
  }

  rerankers.set(FIXTURE_RERANKER_ID, new FixtureOverlapReranker())
}

class FixtureOverlapReranker implements Reranker {
  readonly id = FIXTURE_RERANKER_ID
  readonly model = 'fixture-overlap-v1'

  async rerank(query: string, documents: string[], options?: RerankOptions): Promise<RerankResult[]> {
    const queryTerms = new Set(tokenizeForOverlap(query))

    const scored: RerankResult[] = documents.map((document, index) => {
      let overlap = 0
      for (const term of tokenizeForOverlap(document)) {
        if (queryTerms.has(term)) {
          overlap += 1
        }
      }

      return { index, score: overlap }
    })

    scored.sort((left, right) => right.score - left.score || left.index - right.index)

    return options?.topK === undefined ? scored : scored.slice(0, Math.max(0, options.topK))
  }
}

function tokenizeForOverlap(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}
