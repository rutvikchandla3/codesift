import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openRepo } from '@codesift/core'

import {
  DEFAULT_SEARCH_K,
  createHttpServer,
  createRouter,
  createStdioServer,
  getToolDefinitions
} from '../src/index.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
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

  it('routes scaffold calls through the core repo contract', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'codesift-mcp-'))
    temporaryDirectories.push(repoRoot)

    const repo = await openRepo(repoRoot)
    const router = createRouter(repo)

    expect(await router.searchCode({ query: 'jwt validation' })).toEqual([])
    expect(await router.findSymbol({ name: 'TokenVerifier' })).toEqual([])
    expect(await router.readChunk({ id: 'chunk-1' })).toContain('Scaffold only')
    expect((await router.indexStatus()).indexed).toBe(false)
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
