import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/bench.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  noExternal: ['@codesift/core'],
  external: ['better-sqlite3', 'sqlite-vec', 'ignore', 'minimatch', 'typescript']
})
