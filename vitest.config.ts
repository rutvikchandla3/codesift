import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@codesift/core': resolve(rootDir, 'packages/core/src/index.ts'),
      '@codesift/mcp': resolve(rootDir, 'packages/mcp/src/index.ts'),
      '@codesift/eval': resolve(rootDir, 'packages/eval/src/index.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts']
  }
})
