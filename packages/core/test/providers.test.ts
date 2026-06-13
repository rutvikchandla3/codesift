import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  OPENAI_EMBEDDING_PROVIDER_ID,
  OpenAIEmbeddingProvider,
  VOYAGE_EMBEDDING_PROVIDER_ID,
  VoyageEmbeddingProvider,
  getEmbeddingProvider,
  isCloudEmbeddingProvider,
  isLearnedEmbeddingProvider,
  listEmbeddingProviders,
  prepareForCloud,
  redactSecrets,
  scanSecrets,
  type EmbeddingProvider
} from '../src/index.js'

const originalVoyageKey = process.env.VOYAGE_API_KEY
const originalOpenAIKey = process.env.OPENAI_API_KEY

afterEach(() => {
  vi.restoreAllMocks()

  restoreEnv('VOYAGE_API_KEY', originalVoyageKey)
  restoreEnv('OPENAI_API_KEY', originalOpenAIKey)
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function vectorPayload(count: number, dims: number): { data: Array<{ embedding: number[]; index: number }> } {
  return {
    data: Array.from({ length: count }, (_unused, index) => ({
      index,
      embedding: Array.from({ length: dims }, (_value, dimension) => (index + 1) * 0.001 * (dimension + 1))
    }))
  }
}

describe('cloud embedding providers', () => {
  it('registers Voyage and OpenAI as resolvable, learned, non-default cloud providers', () => {
    const voyage = getEmbeddingProvider(VOYAGE_EMBEDDING_PROVIDER_ID)
    const openai = getEmbeddingProvider(OPENAI_EMBEDDING_PROVIDER_ID)

    expect(voyage?.id).toBe(VOYAGE_EMBEDDING_PROVIDER_ID)
    expect(voyage?.dims).toBe(1024)
    expect(voyage?.isLearned).toBe(true)
    expect(openai?.id).toBe(OPENAI_EMBEDDING_PROVIDER_ID)
    expect(openai?.dims).toBe(1536)
    expect(openai?.isLearned).toBe(true)

    expect(isLearnedEmbeddingProvider(voyage as EmbeddingProvider)).toBe(true)
    expect(isCloudEmbeddingProvider(voyage as EmbeddingProvider)).toBe(true)
    expect(isCloudEmbeddingProvider(openai as EmbeddingProvider)).toBe(true)

    const ids = listEmbeddingProviders().map((provider) => provider.id)
    expect(ids).toContain(VOYAGE_EMBEDDING_PROVIDER_ID)
    expect(ids).toContain(OPENAI_EMBEDDING_PROVIDER_ID)
  })

  it('Voyage embedBatch posts the correct URL, auth, model, body and parses vectors', async () => {
    process.env.VOYAGE_API_KEY = 'voyage-test-key'
    const provider = new VoyageEmbeddingProvider()

    const fetchMock = vi.fn(async () => jsonResponse(vectorPayload(2, provider.dims)))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const vectors = await provider.embedBatch(['alpha', 'beta'], { role: 'document' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.voyageai.com/v1/embeddings')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer voyage-test-key')
    const body = JSON.parse(init.body as string) as { input: string[]; model: string; input_type: string }
    expect(body.model).toBe('voyage-code-3')
    expect(body.input).toEqual(['alpha', 'beta'])
    expect(body.input_type).toBe('document')

    expect(vectors).toHaveLength(2)
    expect(vectors[0]).toBeInstanceOf(Float32Array)
    expect(vectors[0]?.length).toBe(provider.dims)
  })

  it('Voyage maps the query role to input_type query', async () => {
    process.env.VOYAGE_API_KEY = 'voyage-test-key'
    const provider = new VoyageEmbeddingProvider()
    const fetchMock = vi.fn(async () => jsonResponse(vectorPayload(1, provider.dims)))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    await provider.embedBatch(['find auth helper'], { role: 'query' })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { input_type: string }
    expect(body.input_type).toBe('query')
  })

  it('OpenAI embedBatch posts the correct URL, auth, model, body and parses vectors', async () => {
    process.env.OPENAI_API_KEY = 'openai-test-key'
    const provider = new OpenAIEmbeddingProvider()

    const fetchMock = vi.fn(async () => jsonResponse(vectorPayload(3, provider.dims)))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const vectors = await provider.embedBatch(['one', 'two', 'three'], { role: 'document' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/embeddings')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer openai-test-key')
    const body = JSON.parse(init.body as string) as { input: string[]; model: string }
    expect(body.model).toBe('text-embedding-3-small')
    expect(body.input).toEqual(['one', 'two', 'three'])
    expect('input_type' in body).toBe(false)

    expect(vectors).toHaveLength(3)
    expect(vectors[2]?.length).toBe(provider.dims)
  })

  it('forwards the AbortSignal to fetch', async () => {
    process.env.VOYAGE_API_KEY = 'voyage-test-key'
    const provider = new VoyageEmbeddingProvider()
    const fetchMock = vi.fn(async () => jsonResponse(vectorPayload(1, provider.dims)))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const controller = new AbortController()
    await provider.embedBatch(['x'], { role: 'document' }, controller.signal)

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })

  it('throws an actionable error when the API key is missing and never calls fetch', async () => {
    delete process.env.VOYAGE_API_KEY
    delete process.env.OPENAI_API_KEY

    const fetchMock = vi.fn(async () => jsonResponse({}))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    await expect(new VoyageEmbeddingProvider().embedBatch(['x'], { role: 'document' })).rejects.toThrow(
      /VOYAGE_API_KEY/
    )
    await expect(new OpenAIEmbeddingProvider().embedBatch(['x'], { role: 'document' })).rejects.toThrow(
      /OPENAI_API_KEY/
    )

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws on a non-200 response', async () => {
    process.env.OPENAI_API_KEY = 'openai-test-key'
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'nope' }, 401))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    await expect(new OpenAIEmbeddingProvider().embedBatch(['x'], { role: 'document' })).rejects.toThrow(/HTTP 401/)
  })

  it('throws on a vector dimension mismatch', async () => {
    process.env.VOYAGE_API_KEY = 'voyage-test-key'
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3] }] }))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    await expect(new VoyageEmbeddingProvider().embedBatch(['x'], { role: 'document' })).rejects.toThrow(
      /shape mismatch/
    )
  })

  it('returns an empty array without calling fetch for an empty batch', async () => {
    process.env.OPENAI_API_KEY = 'openai-test-key'
    const fetchMock = vi.fn(async () => jsonResponse({}))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const vectors = await new OpenAIEmbeddingProvider().embedBatch([], { role: 'document' })

    expect(vectors).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('secret scanning', () => {
  it('flags planted secrets', () => {
    const awsFinding = scanSecrets('const id = "AKIAIOSFODNN7EXAMPLE"')
    expect(awsFinding.map((finding) => finding.kind)).toContain('aws-access-key-id')

    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAabc123
-----END RSA PRIVATE KEY-----`
    const pemFinding = scanSecrets(pem)
    expect(pemFinding.map((finding) => finding.kind)).toContain('private-key')

    const assignment = scanSecrets('FOO_API_KEY = "super-secret-value-123"')
    expect(assignment.map((finding) => finding.kind)).toContain('generic-credential-assignment')

    const github = scanSecrets('token: ghp_0123456789abcdefghijklmnopqrstuvwxyz')
    expect(github.map((finding) => finding.kind)).toContain('github-token')

    const slack = scanSecrets('xoxb-' + '1234567890-abcdefghijklmnop')
    expect(slack.map((finding) => finding.kind)).toContain('slack-token')

    const bearer = scanSecrets('Authorization: Bearer eyJhbGciOiJI.eyJzdWIiOiIxMjM.SflKxwRJSM')
    expect(bearer.map((finding) => finding.kind)).toContain('bearer-jwt')
  })

  it('reports a 1-based line number for each finding', () => {
    const findings = scanSecrets('line one\nFOO_API_KEY=abcdef123456\nline three')
    expect(findings[0]?.line).toBe(2)
  })

  it('returns no findings for ordinary code', () => {
    const code = `export function add(a: number, b: number): number {
  return a + b
}

const greeting = 'hello world'
`
    expect(scanSecrets(code)).toEqual([])
  })

  it('redacts the secret value while preserving structure', () => {
    const redacted = redactSecrets('FOO_API_KEY = "super-secret-value-123"')
    expect(redacted).toContain('FOO_API_KEY')
    expect(redacted).not.toContain('super-secret-value-123')
    expect(redacted).toContain('[REDACTED]')

    const bearer = redactSecrets('Bearer eyJhbGciOiJI.eyJzdWIiOiIxMjM.SflKxwRJSM')
    expect(bearer).toContain('Bearer')
    expect(bearer).not.toContain('eyJzdWIiOiIxMjM')
  })
})

describe('prepareForCloud gate', () => {
  it('returns texts unchanged when there are no findings', () => {
    const texts = ['const x = 1', 'function noop() {}']
    expect(prepareForCloud(texts, { allowSecrets: false })).toBe(texts)
  })

  it('refuses without allowSecrets and names the secret kind', () => {
    expect(() => prepareForCloud(['AKIAIOSFODNN7EXAMPLE'], { allowSecrets: false })).toThrow(/--allow-secrets/)
    expect(() => prepareForCloud(['AKIAIOSFODNN7EXAMPLE'], {})).toThrow(/AWS access key id/)
  })

  it('redacts every text when allowSecrets is true', () => {
    const result = prepareForCloud(['FOO_API_KEY=super-secret-value-123', 'clean line'], { allowSecrets: true })
    expect(result[0]).not.toContain('super-secret-value-123')
    expect(result[0]).toContain('[REDACTED]')
    expect(result[1]).toBe('clean line')
  })
})
