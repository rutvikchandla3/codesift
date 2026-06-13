import { extname } from 'node:path'

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.cjs': 'javascript',
  '.cts': 'typescript',
  '.go': 'go',
  '.java': 'java',
  '.js': 'javascript',
  '.json': 'json',
  '.jsx': 'javascript',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.mjs': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.sh': 'shell',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.toml': 'toml',
  '.txt': 'text',
  '.yaml': 'yaml',
  '.yml': 'yaml'
}

const TEXT_FILE_NAMES = new Set(['Dockerfile', 'Makefile'])
const CODE_LANGUAGES = new Set(['go', 'java', 'javascript', 'python', 'ruby', 'rust', 'shell', 'typescript'])
const DOCUMENTATION_LANGUAGES = new Set(['json', 'markdown', 'text', 'toml', 'yaml'])
const BINARY_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.class',
  '.dll',
  '.dylib',
  '.exe',
  '.gif',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.lockb',
  '.mov',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.so',
  '.svgz',
  '.tar',
  '.tgz',
  '.wasm',
  '.webm',
  '.webp',
  '.zip'
])

export function detectLanguage(filePath: string): string | undefined {
  const extension = extname(filePath).toLowerCase()
  if (extension && LANGUAGE_BY_EXTENSION[extension]) {
    return LANGUAGE_BY_EXTENSION[extension]
  }

  const basename = filePath.split('/').at(-1)
  if (basename && TEXT_FILE_NAMES.has(basename)) {
    return 'text'
  }

  return undefined
}

export function isBinaryPath(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())
}

export function isTypeScriptLike(language: string): boolean {
  return language === 'typescript' || language === 'javascript'
}

export function isPythonLike(language: string): boolean {
  return language === 'python'
}

export function isGoLike(language: string): boolean {
  return language === 'go'
}

export function isJavaLike(language: string): boolean {
  return language === 'java'
}

export function isRubyLike(language: string): boolean {
  return language === 'ruby'
}

export function isRustLike(language: string): boolean {
  return language === 'rust'
}

export function isMarkdownLike(language: string): boolean {
  return language === 'markdown'
}

export function isConfigLike(language: string): boolean {
  return language === 'json' || language === 'yaml' || language === 'toml'
}

export function isCodeLanguage(language: string): boolean {
  return CODE_LANGUAGES.has(language)
}

export function isDocumentationLanguage(language: string): boolean {
  return DOCUMENTATION_LANGUAGES.has(language)
}
