import { describe, expect, it } from 'vitest'

import { formatHits, formatStatus, formatSymbols } from '../src/program.js'

describe('codesift CLI formatters', () => {
  it('renders placeholder status output', () => {
    expect(
      formatStatus({
        root: '/tmp/codesift',
        indexPath: '/tmp/codesift/.codesift/index.db',
        indexed: false,
        stale: false,
        chunkCount: 0,
        symbolCount: 0,
        provider: null
      })
    ).toContain('provider: unconfigured')
  })

  it('renders empty states', () => {
    expect(formatHits([])).toContain('No hits found')
    expect(formatSymbols([])).toContain('No symbol matches found')
  })
})
