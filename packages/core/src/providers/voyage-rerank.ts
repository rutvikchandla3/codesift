import type { RerankOptions, RerankResult, Reranker } from '../types.js'

export const VOYAGE_RERANK_PROVIDER_ID = 'voyage-rerank-2.5'

const VOYAGE_RERANK_API_URL = 'https://api.voyageai.com/v1/rerank'
const VOYAGE_RERANK_MODEL = 'rerank-2.5'

interface VoyageRerankResponse {
  results?: Array<{ index?: number; relevance_score?: number }>
}

/**
 * Voyage AI `rerank-2.5` reranker. Learned, cloud-backed, OPT-IN provider.
 *
 * No network happens at import time. `rerank` reads `VOYAGE_API_KEY` lazily and
 * performs a single POST per call via `globalThis.fetch`. The default local path
 * never instantiates or calls this provider.
 */
export class VoyageReranker implements Reranker {
  readonly id = VOYAGE_RERANK_PROVIDER_ID
  readonly model = VOYAGE_RERANK_MODEL

  async rerank(query: string, documents: string[], options?: RerankOptions): Promise<RerankResult[]> {
    if (documents.length === 0) {
      return []
    }

    const apiKey = process.env.VOYAGE_API_KEY?.trim()
    if (!apiKey) {
      throw new Error(
        'VOYAGE_API_KEY is not set. Export VOYAGE_API_KEY=<your Voyage AI key> to use the voyage-rerank-2.5 reranker.'
      )
    }

    const body: Record<string, unknown> = {
      query,
      documents,
      model: VOYAGE_RERANK_MODEL
    }
    if (options?.topK !== undefined) {
      body.top_k = options.topK
    }

    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    }
    if (options?.signal) {
      init.signal = options.signal
    }

    let response: Response
    try {
      response = await globalThis.fetch(VOYAGE_RERANK_API_URL, init)
    } catch (error) {
      throw new Error(`Voyage rerank request failed: ${describeError(error)}`)
    }

    if (!response.ok) {
      const detail = await readErrorBody(response)
      throw new Error(`Voyage rerank request failed with HTTP ${response.status}${detail}`)
    }

    const payload = (await response.json()) as VoyageRerankResponse
    return parseRerankResults(payload.results, documents.length)
  }
}

function parseRerankResults(
  results: VoyageRerankResponse['results'],
  documentCount: number
): RerankResult[] {
  if (!Array.isArray(results)) {
    throw new Error('Voyage rerank response shape mismatch: missing results array.')
  }

  return results.map((entry, position) => {
    const index = entry?.index
    const score = entry?.relevance_score
    if (typeof index !== 'number' || index < 0 || index >= documentCount || typeof score !== 'number') {
      throw new Error(
        `Voyage rerank response shape mismatch: result ${position} has an invalid index or score.`
      )
    }

    return { index, score }
  })
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim()
    return text ? `: ${text.slice(0, 500)}` : ''
  } catch {
    return ''
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
