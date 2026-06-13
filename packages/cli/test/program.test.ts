import { describe, expect, it } from 'vitest'

import { formatHits, formatStatus, formatSymbols } from '../src/program.js'

describe('codesift CLI scaffold formatters', () => {
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

  it('renders placeholder empty states', () => {
    expect(formatHits([])).toContain('M1')
    expect(formatSymbols([])).toContain('M2')
  })
})
