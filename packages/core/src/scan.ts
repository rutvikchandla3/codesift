import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

import ignore from 'ignore'

import { detectLanguage, isBinaryPath } from './languages.js'

const MAX_FILE_SIZE_BYTES = 1024 * 1024
const DEFAULT_IGNORES = [
  '.codesift',
  '.git',
  'coverage',
  'dist',
  'node_modules'
]

export interface ScannedFile {
  absolutePath: string
  relativePath: string
  language: string
  content: string
  hash: string
  size: number
}

export interface ScanResult {
  files: ScannedFile[]
  skippedFiles: number
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

  async function walk(currentDirectory: string): Promise<void> {
    const entries = await readdir(currentDirectory, { withFileTypes: true })

    for (const entry of entries) {
      const absolutePath = join(currentDirectory, entry.name)
      const relativePath = relative(root, absolutePath).split('\\').join('/')
      const ignorePath = entry.isDirectory() ? `${relativePath}/` : relativePath

      if (relativePath && matcher.ignores(ignorePath)) {
        continue
      }

      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }

      if (!entry.isFile() || isBinaryPath(relativePath)) {
        skippedFiles += 1
        continue
      }

      const fileStat = await stat(absolutePath)
      if (fileStat.size > MAX_FILE_SIZE_BYTES) {
        skippedFiles += 1
        continue
      }

      const buffer = await readFile(absolutePath)
      if (buffer.includes(0)) {
        skippedFiles += 1
        continue
      }

      const language = detectLanguage(relativePath)
      if (!language) {
        skippedFiles += 1
        continue
      }

      files.push({
        absolutePath,
        relativePath,
        language,
        content: buffer.toString('utf8'),
        hash: createHash('sha256').update(buffer).digest('hex'),
        size: fileStat.size
      })
    }
  }

  await walk(root)

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return { files, skippedFiles }
}
