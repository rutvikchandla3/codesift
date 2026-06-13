import { describe, expect, it } from 'vitest'

import {
  getEmbeddingProvider,
  listEmbeddingProviders,
  openRepo,
  registerEmbeddingProvider
} from '../src/index.js'

describe('@codesift/core scaffold', () => {
  it('opens a repo and exposes placeholder status', async () => {
    const repo = await openRepo('/tmp/codesift')
    const status = await repo.status()

    expect(repo.root).toBe('/tmp/codesift')
    expect(status.indexPath).toContain('.codesift/index.db')
    expect(await repo.search('jwt verification')).toEqual([])
  })

  it('registers embedding providers', async () => {
    const providerId = `test-provider-${Date.now()}`

    registerEmbeddingProvider({
      id: providerId,
      dims: 768,
      maxTokens: 8192,
      async embedBatch(texts) {
        return texts.map(() => new Float32Array(768))
      }
    })

    expect(getEmbeddingProvider(providerId)?.id).toBe(providerId)
    expect(listEmbeddingProviders().some((provider) => provider.id === providerId)).toBe(true)
  })
})
