import { describe, expect, it, vi } from 'vitest'

import { createRepoCache } from '../src/daemon.js'
import type { Repo } from '@codesift/core'

function fakeRepo(watch: () => Promise<() => Promise<void>>): Repo {
  return { root: '/fake', watch } as unknown as Repo
}

describe('daemon repo cache', () => {
  it('attaches a watcher once per root, reuses the cached repo, and stops on shutdown', async () => {
    const stop = vi.fn(async () => {})
    let watchCalls = 0
    const open = vi.fn(async () => fakeRepo(async () => {
      watchCalls += 1
      return stop
    }))

    const cache = createRepoCache(open)
    const first = await cache.getRepo('/some/root')
    const second = await cache.getRepo('/some/root')

    expect(first).toBe(second)
    expect(open).toHaveBeenCalledTimes(1)
    await new Promise((r) => setTimeout(r, 0))
    expect(watchCalls).toBe(1)

    await cache.stopAll()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('keeps serving even if watch() rejects', async () => {
    const open = vi.fn(async () => fakeRepo(async () => {
      throw new Error('watch failed')
    }))
    const cache = createRepoCache(open)
    const repo = await cache.getRepo('/root')
    expect(repo).toBeDefined()
    await new Promise((r) => setTimeout(r, 0))
    await cache.stopAll()
  })
})
