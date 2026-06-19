import { OpenAIEmbeddingProvider, OPENAI_EMBEDDING_PROVIDER_ID } from './providers/openai.js'
import { VoyageEmbeddingProvider, VOYAGE_EMBEDDING_PROVIDER_ID } from './providers/voyage.js'
import type { EmbeddingProvider, EmbeddingRole } from './types.js'

export const DEFAULT_EMBEDDING_PROVIDER_ID = 'lexical-v1'
export const LOCAL_HASH_EMBEDDING_PROVIDER_ID = 'local-hash-v1'

/**
 * Ids of the cloud (learned) embedding providers. These resolve via
 * {@link getEmbeddingProvider} but are never the default; selecting one is
 * always explicit (via `CODESIFT_EMBEDDING_PROVIDER` or `.codesift/config.json`).
 * They perform network I/O only inside `embedBatch`, never at import/registration.
 */
export const CLOUD_EMBEDDING_PROVIDER_IDS: readonly string[] = [
  VOYAGE_EMBEDDING_PROVIDER_ID,
  OPENAI_EMBEDDING_PROVIDER_ID
]
const DEFAULT_LEXICAL_DIMS = 8
const DEFAULT_HASH_DIMS = 384

export const SYNONYM_GROUPS = [
  ['auth', 'authenticate', 'authentication', 'authorize', 'authorization', 'login', 'signin'],
  ['validate', 'validation', 'verify', 'verification', 'check', 'assert'],
  ['retry', 'retries', 'backoff', 'reconnect', 'attempt'],
  ['token', 'tokens', 'jwt', 'bearer', 'session', 'credential'],
  ['config', 'configuration', 'setting', 'settings', 'option', 'options'],
  ['request', 'requests', 'http', 'https', 'fetch', 'client', 'api'],
  ['error', 'errors', 'exception', 'failure', 'fail'],
  ['cache', 'caching', 'memoize', 'memoization'],
  ['parse', 'parser', 'parsing', 'decode', 'deserialize'],
  ['serialize', 'serialization', 'encode']
] as const

const SYNONYM_MAP = new Map<string, string[]>()
for (const group of SYNONYM_GROUPS) {
  for (const token of group) {
    SYNONYM_MAP.set(
      token,
      group.filter((candidate) => candidate !== token)
    )
  }
}

/**
 * Expand a term to its synonym OR-group: the term followed by its synonyms, with
 * the term itself first. Returns just `[term]` when the term has no synonym group.
 */
export function expandTermToOrGroup(term: string): string[] {
  const synonyms = SYNONYM_MAP.get(term)
  return synonyms ? [term, ...synonyms] : [term]
}

const embeddingProviders = new Map<string, EmbeddingProvider>()

class LexicalEmbeddingProvider implements EmbeddingProvider {
  readonly id = DEFAULT_EMBEDDING_PROVIDER_ID
  readonly dims = DEFAULT_LEXICAL_DIMS
  readonly maxTokens = 8192
  readonly maxBatch = 256
  readonly maxBatchTokens = 32_768
  readonly modelVersion = 'builtin-lexical-v1'
  readonly isLearned = false

  async embedBatch(texts: string[], _options: { role: EmbeddingRole }): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(this.dims))
  }
}

class LocalHashEmbeddingProvider implements EmbeddingProvider {
  readonly id = LOCAL_HASH_EMBEDDING_PROVIDER_ID
  readonly dims = DEFAULT_HASH_DIMS
  readonly maxTokens = 8192
  readonly maxBatch = 128
  readonly maxBatchTokens = 16_384
  readonly modelVersion = 'local-hash-v1-fixture'
  readonly isLearned = false

  async embedBatch(texts: string[], _options: { role: EmbeddingRole }): Promise<Float32Array[]> {
    return texts.map((text) => embedText(text, this.dims))
  }
}

function embedText(text: string, dims: number): Float32Array {
  const vector = new Float32Array(dims)
  const tokens = tokenize(text)

  for (const token of tokens) {
    addWeightedFeature(vector, token, 1)
    addWeightedFeature(vector, stemToken(token), 0.5)

    const synonyms = SYNONYM_MAP.get(token)
    if (synonyms) {
      for (const synonym of synonyms) {
        addWeightedFeature(vector, synonym, 0.35)
      }
    }

    if (token.length >= 5) {
      for (const trigram of toTrigrams(token)) {
        addWeightedFeature(vector, trigram, 0.2)
      }
    }
  }

  for (let index = 0; index < tokens.length - 1; index += 1) {
    addWeightedFeature(vector, `${tokens[index]}:${tokens[index + 1]}`, 0.35)
  }

  normalize(vector)
  return vector
}

function addWeightedFeature(vector: Float32Array, feature: string, weight: number): void {
  if (!feature) {
    return
  }

  const bucket = stableHash(feature) % vector.length
  vector[bucket] = (vector[bucket] ?? 0) + weight
}

function normalize(vector: Float32Array): void {
  let magnitude = 0

  for (const value of vector) {
    magnitude += value * value
  }

  if (magnitude === 0) {
    return
  }

  const scale = 1 / Math.sqrt(magnitude)
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) * scale
  }
}

function toTrigrams(token: string): string[] {
  const trigrams: string[] = []
  for (let index = 0; index <= token.length - 3; index += 1) {
    trigrams.push(token.slice(index, index + 3))
  }
  return trigrams
}

function tokenize(text: string): string[] {
  const normalized = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()

  const matches = normalized.match(/[a-z0-9]+/g)
  if (!matches) {
    return []
  }

  return matches.flatMap((match) => {
    const stem = stemToken(match)
    return stem === match ? [match] : [match, stem]
  })
}

function stemToken(token: string): string {
  if (token.endsWith('ies') && token.length > 4) {
    return `${token.slice(0, -3)}y`
  }

  if (token.endsWith('ing') && token.length > 5) {
    return token.slice(0, -3)
  }

  if (token.endsWith('ed') && token.length > 4) {
    return token.slice(0, -2)
  }

  if (token.endsWith('ation') && token.length > 7) {
    return `${token.slice(0, -5)}e`
  }

  if (token.endsWith('s') && token.length > 3) {
    return token.slice(0, -1)
  }

  return token
}

function stableHash(text: string): number {
  let hash = 2166136261

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

function ensureBuiltinEmbeddingProviders(): void {
  if (!embeddingProviders.has(DEFAULT_EMBEDDING_PROVIDER_ID)) {
    embeddingProviders.set(DEFAULT_EMBEDDING_PROVIDER_ID, new LexicalEmbeddingProvider())
  }

  if (!embeddingProviders.has(LOCAL_HASH_EMBEDDING_PROVIDER_ID)) {
    embeddingProviders.set(LOCAL_HASH_EMBEDDING_PROVIDER_ID, new LocalHashEmbeddingProvider())
  }

  registerCloudEmbeddingProviders()
}

/**
 * Register the cloud (learned) providers so they resolve via
 * {@link getEmbeddingProvider} / appear in {@link listEmbeddingProviders}.
 * Constructing the providers performs no network I/O; egress happens only when
 * `embedBatch` is actually called. Idempotent. The default provider is
 * unaffected and stays {@link DEFAULT_EMBEDDING_PROVIDER_ID}.
 */
export function registerCloudEmbeddingProviders(): void {
  if (!embeddingProviders.has(VOYAGE_EMBEDDING_PROVIDER_ID)) {
    embeddingProviders.set(VOYAGE_EMBEDDING_PROVIDER_ID, new VoyageEmbeddingProvider())
  }

  if (!embeddingProviders.has(OPENAI_EMBEDDING_PROVIDER_ID)) {
    embeddingProviders.set(OPENAI_EMBEDDING_PROVIDER_ID, new OpenAIEmbeddingProvider())
  }
}

ensureBuiltinEmbeddingProviders()

export function getDefaultEmbeddingProviderId(): string {
  const configuredId = process.env.CODESIFT_EMBEDDING_PROVIDER?.trim()
  return configuredId || DEFAULT_EMBEDDING_PROVIDER_ID
}

export function getDefaultEmbeddingProvider(): EmbeddingProvider {
  ensureBuiltinEmbeddingProviders()

  const providerId = getDefaultEmbeddingProviderId()
  const provider = embeddingProviders.get(providerId)
  if (!provider) {
    throw new Error(`Embedding provider not registered: ${providerId}`)
  }

  return provider
}

export function registerEmbeddingProvider(provider: EmbeddingProvider): void {
  if (!provider.id.trim()) {
    throw new Error('Embedding provider id is required')
  }

  if (provider.dims <= 0) {
    throw new Error('Embedding provider dims must be greater than zero')
  }

  if (provider.maxTokens <= 0) {
    throw new Error('Embedding provider maxTokens must be greater than zero')
  }

  if (provider.maxBatch !== undefined && provider.maxBatch <= 0) {
    throw new Error('Embedding provider maxBatch must be greater than zero')
  }

  if (provider.maxBatchTokens !== undefined && provider.maxBatchTokens <= 0) {
    throw new Error('Embedding provider maxBatchTokens must be greater than zero')
  }

  if (embeddingProviders.has(provider.id)) {
    throw new Error(`Embedding provider already registered: ${provider.id}`)
  }

  embeddingProviders.set(provider.id, provider)
}

export function getEmbeddingProvider(id: string): EmbeddingProvider | undefined {
  return embeddingProviders.get(id)
}

export function listEmbeddingProviders(): EmbeddingProvider[] {
  return [...embeddingProviders.values()]
}

export function isLearnedEmbeddingProvider(provider: EmbeddingProvider): boolean {
  return provider.isLearned === true
}

export function isCloudEmbeddingProvider(provider: EmbeddingProvider): boolean {
  return CLOUD_EMBEDDING_PROVIDER_IDS.includes(provider.id)
}
