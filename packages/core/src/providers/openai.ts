import type { EmbeddingBatchOptions, EmbeddingProvider } from '../types.js'

export const OPENAI_EMBEDDING_PROVIDER_ID = 'openai-text-embedding-3-small'

const OPENAI_API_URL = 'https://api.openai.com/v1/embeddings'
const OPENAI_MODEL = 'text-embedding-3-small'
const OPENAI_DIMS = 1536

interface OpenAIEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>
}

/**
 * OpenAI `text-embedding-3-small` embeddings. Learned, cloud-backed provider.
 *
 * No network happens at import time. `embedBatch` reads `OPENAI_API_KEY` lazily
 * and performs a single POST per call via `globalThis.fetch`. The default local
 * path never instantiates or calls this provider.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = OPENAI_EMBEDDING_PROVIDER_ID
  readonly dims = OPENAI_DIMS
  readonly maxTokens = 8191
  readonly maxBatch = 128
  readonly maxBatchTokens = 200_000
  readonly model = OPENAI_MODEL
  readonly modelVersion = OPENAI_MODEL
  readonly isLearned = true

  async embedBatch(
    texts: string[],
    _options: EmbeddingBatchOptions,
    signal?: AbortSignal
  ): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return []
    }

    const apiKey = process.env.OPENAI_API_KEY?.trim()
    if (!apiKey) {
      throw new Error(
        'OPENAI_API_KEY is not set. Export OPENAI_API_KEY=<your OpenAI key> to use the openai-text-embedding-3-small embedding provider.'
      )
    }

    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        input: texts,
        model: OPENAI_MODEL
      })
    }
    if (signal) {
      init.signal = signal
    }

    let response: Response
    try {
      response = await globalThis.fetch(OPENAI_API_URL, init)
    } catch (error) {
      throw new Error(`OpenAI embeddings request failed: ${describeError(error)}`)
    }

    if (!response.ok) {
      const detail = await readErrorBody(response)
      throw new Error(`OpenAI embeddings request failed with HTTP ${response.status}${detail}`)
    }

    const payload = (await response.json()) as OpenAIEmbeddingResponse
    return parseEmbeddings(payload.data, texts.length, this.dims)
  }
}

function parseEmbeddings(
  data: OpenAIEmbeddingResponse['data'],
  expectedCount: number,
  dims: number
): Float32Array[] {
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new Error(
      `OpenAI embeddings response shape mismatch: expected ${expectedCount} vectors, received ${
        Array.isArray(data) ? data.length : 'none'
      }.`
    )
  }

  // OpenAI guarantees the response order matches the input order, but the
  // optional `index` field lets us defensively reorder when present.
  const ordered = data.every((entry) => typeof entry?.index === 'number')
    ? [...data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
    : data

  return ordered.map((entry, index) => {
    const embedding = entry?.embedding
    if (!Array.isArray(embedding) || embedding.length !== dims) {
      throw new Error(
        `OpenAI embeddings response shape mismatch: vector ${index} has ${
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
