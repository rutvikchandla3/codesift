import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/bin.ts'],
  format: ['esm'],
  splitting: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  banner: {
    js: '#!/usr/bin/env node'
  }
})
