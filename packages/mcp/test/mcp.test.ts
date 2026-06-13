import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openRepo, registerEmbeddingProvider } from '@codesift/core'

import {
  DEFAULT_SEARCH_K,
  createHttpServer,
  createRouter,
  createStdioServer,
  getToolDefinitions
} from '../src/index.js'

const temporaryDirectories: string[] = []
const originalEmbeddingProvider = process.env.CODESIFT_EMBEDDING_PROVIDER

afterEach(async () => {
  if (originalEmbeddingProvider === undefined) {
    delete process.env.CODESIFT_EMBEDDING_PROVIDER
  } else {
    process.env.CODESIFT_EMBEDDING_PROVIDER = originalEmbeddingProvider
  }

  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true })
    })
  )
})

describe('@codesift/mcp scaffold', () => {
  it('exposes the planned tool surface', () => {
    expect(getToolDefinitions().map((tool) => tool.name)).toEqual([
      'search_code',
      'find_symbol',
      'read_chunk',
      'index_status'
    ])
  })

  it('uses honest lexical wording by default and semantic wording with a learned provider', () => {
    expect(getToolDefinitions()[0]?.description.toLowerCase()).not.toContain('semantic')
    expect(getToolDefinitions()[0]?.description.toLowerCase()).not.toContain('hybrid')

    const providerId = `mcp-learned-provider-${Date.now()}`
    registerEmbeddingProvider({
      id: providerId,
      dims: 8,
      maxTokens: 8192,
      modelVersion: `${providerId}-model`,
      isLearned: true,
      async embedBatch(texts) {
        return texts.map(() => new Float32Array(8))
      }
    })
    process.env.CODESIFT_EMBEDDING_PROVIDER = providerId

    expect(getToolDefinitions()[0]?.description.toLowerCase()).toContain('semantic')
    expect(getToolDefinitions()[0]?.description.toLowerCase()).toContain('hybrid')
  })

  it('routes scaffold calls through the core repo contract', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-mcp-'))
    temporaryDirectories.push(repoRoot)

    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(
      join(repoRoot, 'src', 'demo.ts'),
      `export function demoValue(): string {\n  return 'demo'\n}\n`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()
    const router = createRouter(repo)
    const hits = await router.searchCode({ query: 'demoValue', k: 1 })

    expect(hits[0]?.file).toBe('src/demo.ts')
    expect(await router.findSymbol({ name: 'demoValue' })).toHaveLength(1)
    expect(await router.readChunk({ id: hits[0]!.id })).toContain("return 'demo'")
    expect((await router.indexStatus()).indexed).toBe(true)
    expect(DEFAULT_SEARCH_K).toBe(8)
  })

  it('creates placeholder server handles', async () => {
    const repo = await openRepo(process.cwd())
    const stdio = createStdioServer(repo)
    const http = createHttpServer(repo, { port: 7345 })

    expect(stdio.transport).toBe('stdio')
    expect(http.transport).toBe('http')
  })
})
