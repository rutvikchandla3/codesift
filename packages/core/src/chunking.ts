import ts from 'typescript'

import { isPythonLike, isTypeScriptLike } from './languages.js'
import type { SymbolKind } from './types.js'
import type { ScannedFile } from './scan.js'

export interface ChunkRecord {
  file: string
  language: string
  startLine: number
  endLine: number
  content: string
  snippet: string
  embeddingText: string
  symbol?: string
  kind?: SymbolKind
  parent?: string
  signature?: string
}

export function buildChunks(file: ScannedFile): ChunkRecord[] {
  if (isTypeScriptLike(file.language)) {
    const chunks = buildTypeScriptChunks(file)
    if (chunks.length > 0) {
      return chunks
    }
  }

  if (isPythonLike(file.language)) {
    const chunks = buildPythonChunks(file)
    if (chunks.length > 0) {
      return chunks
    }
  }

  return buildFallbackChunks(file)
}

function buildTypeScriptChunks(file: ScannedFile): ChunkRecord[] {
  const lines = splitLines(file.content)
  const sourceFile = ts.createSourceFile(
    file.relativePath,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFromPath(file.relativePath)
  )

  const chunks: ChunkRecord[] = []

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      pushChunk(chunks, file, lines, sourceFile, statement, {
        symbol: statement.name.text,
        kind: 'function',
        signature: firstMeaningfulLine(statement.getText(sourceFile))
      })
      continue
    }

    if (ts.isClassDeclaration(statement)) {
      const className = statement.name?.text ?? 'default'
      pushChunk(chunks, file, lines, sourceFile, statement, {
        symbol: className,
        kind: 'class',
        signature: firstMeaningfulLine(statement.getText(sourceFile))
      })

      for (const member of statement.members) {
        if (
          ts.isMethodDeclaration(member) ||
          ts.isConstructorDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member)
        ) {
          const methodName = ts.isConstructorDeclaration(member)
            ? 'constructor'
            : member.name
              ? member.name.getText(sourceFile)
              : 'anonymous'

          pushChunk(chunks, file, lines, sourceFile, member, {
            symbol: methodName,
            kind: 'method',
            parent: className,
            signature: firstMeaningfulLine(member.getText(sourceFile))
          })
        }
      }
      continue
    }

    if (ts.isInterfaceDeclaration(statement)) {
      pushChunk(chunks, file, lines, sourceFile, statement, {
        symbol: statement.name.text,
        kind: 'interface',
        signature: firstMeaningfulLine(statement.getText(sourceFile))
      })
      continue
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      pushChunk(chunks, file, lines, sourceFile, statement, {
        symbol: statement.name.text,
        kind: 'type',
        signature: firstMeaningfulLine(statement.getText(sourceFile))
      })
      continue
    }

    if (ts.isEnumDeclaration(statement)) {
      pushChunk(chunks, file, lines, sourceFile, statement, {
        symbol: statement.name.text,
        kind: 'enum',
        signature: firstMeaningfulLine(statement.getText(sourceFile))
      })
      continue
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer
        if (!initializer || !declaration.name || !ts.isIdentifier(declaration.name)) {
          continue
        }

        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
          pushChunk(chunks, file, lines, sourceFile, statement, {
            symbol: declaration.name.text,
            kind: 'function',
            signature: firstMeaningfulLine(statement.getText(sourceFile))
          })
        }
      }
    }
  }

  return chunks
}

function buildPythonChunks(file: ScannedFile): ChunkRecord[] {
  const lines = splitLines(file.content)
  const definitions = lines
    .map((line, index) => {
      const match = line.match(/^(\s*)(class|def)\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
      if (!match) {
        return null
      }

      const [, indentText = '', keyword = '', name = ''] = match
      const indent = measureIndent(indentText)
      return {
        lineNumber: index + 1,
        indent,
        kind: keyword,
        name
      }
    })
    .filter((definition): definition is NonNullable<typeof definition> => definition !== null)

  if (definitions.length === 0) {
    return []
  }

  const chunks: ChunkRecord[] = []

  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index]!
    let endLine = lines.length

    for (let nextIndex = index + 1; nextIndex < definitions.length; nextIndex += 1) {
      const candidate = definitions[nextIndex]!
      if (candidate.indent <= definition.indent) {
        endLine = candidate.lineNumber - 1
        break
      }
    }

    const parentClass = [...definitions]
      .slice(0, index)
      .reverse()
      .find(
        (candidate) =>
          candidate.kind === 'class' &&
          candidate.indent < definition.indent &&
          candidate.lineNumber < definition.lineNumber
      )

    const kind =
      definition.kind === 'class' ? 'class' : parentClass ? 'method' : ('function' as const)

    const startLine = extendStartForContext(lines, definition.lineNumber)
    const content = sliceLines(lines, startLine, endLine)
    const snippet = buildSnippet(content)
    const signature = firstMeaningfulLine(content)
    const breadcrumb = [file.relativePath, parentClass?.name, definition.name].filter(Boolean).join(' > ')
    const embeddingText = [breadcrumb, signature, content].filter(Boolean).join('\n')

    const chunk: ChunkRecord = {
      file: file.relativePath,
      language: file.language,
      startLine,
      endLine,
      content,
      snippet,
      embeddingText,
      kind
    }

    if (definition.name) {
      chunk.symbol = definition.name
    }

    if (signature) {
      chunk.signature = signature
    }

    if (parentClass?.name) {
      chunk.parent = parentClass.name
    }

    chunks.push(chunk)
  }

  return chunks
}

function buildFallbackChunks(file: ScannedFile): ChunkRecord[] {
  const lines = splitLines(file.content)
  const chunks: ChunkRecord[] = []
  const windowSize = 60
  const overlap = 15
  const step = windowSize - overlap

  for (let startIndex = 0; startIndex < lines.length; startIndex += step) {
    const startLine = startIndex + 1
    const endLine = Math.min(lines.length, startIndex + windowSize)
    const content = sliceLines(lines, startLine, endLine)
    const snippet = buildSnippet(content)
    const title = `${file.relativePath}:${startLine}-${endLine}`

    chunks.push({
      file: file.relativePath,
      language: file.language,
      startLine,
      endLine,
      content,
      snippet,
      embeddingText: [title, content].join('\n'),
      kind: 'file'
    })

    if (endLine >= lines.length) {
      break
    }
  }

  return chunks
}

function pushChunk(
  chunks: ChunkRecord[],
  file: ScannedFile,
  lines: string[],
  sourceFile: ts.SourceFile,
  node: ts.Node,
  metadata: {
    symbol?: string
    kind?: SymbolKind
    parent?: string
    signature?: string
  }
): void {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  const endPosition = Math.max(node.getStart(sourceFile), node.getEnd() - 1)
  const end = sourceFile.getLineAndCharacterOfPosition(endPosition).line + 1
  const startLine = extendStartForContext(lines, start)
  const content = sliceLines(lines, startLine, end)
  const snippet = buildSnippet(content)
  const breadcrumb = [file.relativePath, metadata.parent, metadata.symbol].filter(Boolean).join(' > ')
  const embeddingText = [breadcrumb, metadata.signature, content].filter(Boolean).join('\n')

  const chunk: ChunkRecord = {
    file: file.relativePath,
    language: file.language,
    startLine,
    endLine: end,
    content,
    snippet,
    embeddingText
  }

  if (metadata.symbol) {
    chunk.symbol = metadata.symbol
  }

  if (metadata.kind) {
    chunk.kind = metadata.kind
  }

  if (metadata.parent) {
    chunk.parent = metadata.parent
  }

  if (metadata.signature) {
    chunk.signature = metadata.signature
  }

  chunks.push(chunk)
}

function splitLines(content: string): string[] {
  return content.split(/\r?\n/)
}

function sliceLines(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join('\n').trim()
}

function buildSnippet(content: string): string {
  return splitLines(content)
    .slice(0, 8)
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
}

function firstMeaningfulLine(content: string): string {
  for (const line of splitLines(content)) {
    const trimmed = line.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }

  return ''
}

function extendStartForContext(lines: string[], startLine: number): number {
  let lineNumber = startLine

  while (lineNumber > 1) {
    const previousLine = lines[lineNumber - 2]?.trim() ?? ''
    if (
      previousLine.startsWith('//') ||
      previousLine.startsWith('/*') ||
      previousLine.startsWith('*') ||
      previousLine.startsWith('*/') ||
      previousLine.startsWith('#') ||
      previousLine.startsWith('@')
    ) {
      lineNumber -= 1
      continue
    }

    break
  }

  return lineNumber
}

function measureIndent(value: string): number {
  return value.replace(/\t/g, '    ').length
}

function scriptKindFromPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.ts')) {
    return ts.ScriptKind.TS
  }

  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX
  }

  if (filePath.endsWith('.jsx')) {
    return ts.ScriptKind.JSX
  }

  return ts.ScriptKind.JS
}
