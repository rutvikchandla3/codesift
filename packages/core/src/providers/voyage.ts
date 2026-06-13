import type { EmbeddingBatchOptions, EmbeddingProvider } from '../types.js'

export const VOYAGE_EMBEDDING_PROVIDER_ID = 'voyage-code-3'

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings'
const VOYAGE_MODEL = 'voyage-code-3'
const VOYAGE_DIMS = 1024

interface VoyageEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>
}

/**
 * Voyage AI `voyage-code-3` embeddings. Learned, cloud-backed provider.
 *
 * No network happens at import time. `embedBatch` reads `VOYAGE_API_KEY` lazily
 * and performs a single POST per call via `globalThis.fetch`. The default local
 * path never instantiates or calls this provider.
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly id = VOYAGE_EMBEDDING_PROVIDER_ID
  readonly dims = VOYAGE_DIMS
  readonly maxTokens = 16_000
  readonly maxBatch = 128
  readonly maxBatchTokens = 120_000
  readonly model = VOYAGE_MODEL
  readonly modelVersion = VOYAGE_MODEL
  readonly isLearned = true

  async embedBatch(
    texts: string[],
    options: EmbeddingBatchOptions,
    signal?: AbortSignal
  ): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return []
    }

    const apiKey = process.env.VOYAGE_API_KEY?.trim()
    if (!apiKey) {
      throw new Error(
        'VOYAGE_API_KEY is not set. Export VOYAGE_API_KEY=<your Voyage AI key> to use the voyage-code-3 embedding provider.'
      )
    }

    const inputType = options.role === 'query' ? 'query' : 'document'

    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        input: texts,
        model: VOYAGE_MODEL,
        input_type: inputType
      })
    }
    if (signal) {
      init.signal = signal
    }

    let response: Response
    try {
      response = await globalThis.fetch(VOYAGE_API_URL, init)
    } catch (error) {
      throw new Error(`Voyage embeddings request failed: ${describeError(error)}`)
    }

    if (!response.ok) {
      const detail = await readErrorBody(response)
      throw new Error(`Voyage embeddings request failed with HTTP ${response.status}${detail}`)
    }

    const payload = (await response.json()) as VoyageEmbeddingResponse
    return parseEmbeddings(payload.data, texts.length, this.dims, 'Voyage')
  }
}

function parseEmbeddings(
  data: VoyageEmbeddingResponse['data'],
  expectedCount: number,
  dims: number,
  providerLabel: string
): Float32Array[] {
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new Error(
      `${providerLabel} embeddings response shape mismatch: expected ${expectedCount} vectors, received ${
        Array.isArray(data) ? data.length : 'none'
      }.`
    )
  }

  return data.map((entry, index) => {
    const embedding = entry?.embedding
    if (!Array.isArray(embedding) || embedding.length !== dims) {
      throw new Error(
        `${providerLabel} embeddings response shape mismatch: vector ${index} has ${
          Array.isArray(embedding) ? embedding.length : 'no'
        } dimensions, expected ${dims}.`
      )
    }

    return Float32Array.from(embedding)
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
