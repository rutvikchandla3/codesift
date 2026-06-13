import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'

import ignore from 'ignore'

import { detectLanguage, isBinaryPath } from './languages.js'

const MAX_FILE_SIZE_BYTES = 1024 * 1024
const DEFAULT_IGNORES = [
  '.cache',
  '.codesift',
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules'
]

const SKIPPED_BASENAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'yarn.lock'
])

export interface ScannedFile {
  absolutePath: string
  relativePath: string
  language: string
  content: string
  hash: string
  size: number
  mtime: number
}

export interface ScanResult {
  files: ScannedFile[]
  skippedFiles: number
  skippedSymlinks: number
}

export async function scanRepository(root: string): Promise<ScanResult> {
  const matcher = ignore()
  matcher.add(DEFAULT_IGNORES)

  for (const fileName of ['.gitignore', '.codesiftignore']) {
    try {
      matcher.add(await readFile(join(root, fileName), 'utf8'))
    } catch {
      // ignore missing optional files
    }
  }

  const files: ScannedFile[] = []
  let skippedFiles = 0
  let skippedSymlinks = 0
  const repoRoot = resolve(root)
  const repoRealRoot = await realpath(root).catch(() => repoRoot)

  async function processFile(absolutePath: string, relativePath: string): Promise<void> {
    if (isBinaryPath(relativePath) || shouldSkipPath(relativePath)) {
      skippedFiles += 1
      return
    }

    const fileStat = await stat(absolutePath)
    if (!fileStat.isFile()) {
      skippedFiles += 1
      return
    }

    if (fileStat.size > MAX_FILE_SIZE_BYTES) {
      skippedFiles += 1
      return
    }

    const buffer = await readFile(absolutePath)
    if (buffer.includes(0)) {
      skippedFiles += 1
      return
    }

    const language = detectLanguage(relativePath)
    if (!language) {
      skippedFiles += 1
      return
    }

    files.push({
      absolutePath,
      relativePath,
      language,
      content: buffer.toString('utf8'),
      hash: createHash('sha256').update(buffer).digest('hex'),
      size: fileStat.size,
      mtime: fileStat.mtimeMs
    })
  }

  async function walk(currentDirectory: string, activeRealPaths: Set<string>): Promise<void> {
    const entries = await readdir(currentDirectory, { withFileTypes: true })

    for (const entry of entries) {
      const absolutePath = join(currentDirectory, entry.name)
      const relativePath = relative(root, absolutePath).split('\\').join('/')

      if (entry.isSymbolicLink()) {
        const targetPath = await realpath(absolutePath).catch(() => null)
        if (!targetPath || !isPathInsideRoot(repoRealRoot, targetPath)) {
          skippedSymlinks += 1
          continue
        }

        const targetStat = await stat(absolutePath).catch(() => null)
        if (!targetStat) {
          skippedSymlinks += 1
          continue
        }

        if (targetStat.isDirectory()) {
          const ignorePath = `${relativePath}/`
          if (relativePath && matcher.ignores(ignorePath)) {
            continue
          }

          if (activeRealPaths.has(targetPath)) {
            skippedSymlinks += 1
            continue
          }

          const nextActiveRealPaths = new Set(activeRealPaths)
          nextActiveRealPaths.add(targetPath)
          await walk(absolutePath, nextActiveRealPaths)
          continue
        }

        if (targetStat.isFile()) {
          if (relativePath && matcher.ignores(relativePath)) {
            continue
          }

          await processFile(absolutePath, relativePath)
          continue
        }

        skippedSymlinks += 1
        continue
      }

      const ignorePath = entry.isDirectory() ? `${relativePath}/` : relativePath
      if (relativePath && matcher.ignores(ignorePath)) {
        continue
      }

      if (entry.isDirectory()) {
        const nextRealPath = await realpath(absolutePath).catch(() => absolutePath)
        const nextActiveRealPaths = new Set(activeRealPaths)
        nextActiveRealPaths.add(nextRealPath)
        await walk(absolutePath, nextActiveRealPaths)
        continue
      }

      if (!entry.isFile()) {
        skippedFiles += 1
        continue
      }

      await processFile(absolutePath, relativePath)
    }
  }

  await walk(root, new Set([repoRealRoot]))

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return { files, skippedFiles, skippedSymlinks }
}

function shouldSkipPath(filePath: string): boolean {
  const fileName = basename(filePath)

  if (SKIPPED_BASENAMES.has(fileName)) {
    return true
  }

  return filePath.endsWith('.map') || filePath.includes('.min.')
}

function isPathInsideRoot(root: string, target: string): boolean {
  const normalizedRoot = normalizePath(root)
  const normalizedTarget = normalizePath(target)
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`)
}

function normalizePath(value: string): string {
  return resolve(value).replace(/\\/g, '/').replace(/\/$/, '')
}
