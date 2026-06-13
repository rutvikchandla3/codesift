import ts from 'typescript'

import {
  isConfigLike,
  isGoLike,
  isJavaLike,
  isMarkdownLike,
  isPythonLike,
  isRubyLike,
  isRustLike,
  isTypeScriptLike
} from './languages.js'
import type { ScannedFile } from './scan.js'
import type { SymbolKind } from './types.js'

export interface ChunkRecord {
  file: string
  language: string
  startLine: number
  endLine: number
  content: string
  snippet: string
  embeddingText: string
  generated: boolean
  symbol?: string
  kind?: SymbolKind
  parent?: string
  signature?: string
}

interface LineContainer {
  name: string
  kind: SymbolKind
  startLine: number
  endLine: number
  parent?: string
}

const FALLBACK_WINDOW_LINES = 60
const FALLBACK_OVERLAP_LINES = 15
const MAX_STRUCTURAL_CHUNK_LINES = 120
const MAX_STRUCTURAL_CHUNK_TOKENS = 1_200
const SPLIT_WINDOW_LINES = 90
const SPLIT_OVERLAP_LINES = 12

export function buildChunks(file: ScannedFile): ChunkRecord[] {
  let chunks: ChunkRecord[] = []

  if (isTypeScriptLike(file.language)) {
    chunks = buildTypeScriptChunks(file)
  } else if (isPythonLike(file.language)) {
    chunks = buildPythonChunks(file)
  } else if (isGoLike(file.language)) {
    chunks = buildGoChunks(file)
  } else if (isJavaLike(file.language)) {
    chunks = buildJavaChunks(file)
  } else if (isRubyLike(file.language)) {
    chunks = buildRubyChunks(file)
  } else if (isRustLike(file.language)) {
    chunks = buildRustChunks(file)
  } else if (isMarkdownLike(file.language)) {
    chunks = buildMarkdownChunks(file)
  } else if (isConfigLike(file.language)) {
    chunks = buildConfigChunks(file)
  }

  return hardenChunks(chunks.length > 0 ? chunks : buildFallbackChunks(file))
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

    pushLineChunk(chunks, file, lines, definition.lineNumber, endLine, {
      symbol: definition.name,
      kind,
      ...(parentClass?.name ? { parent: parentClass.name } : {}),
      signature: firstMeaningfulLine(sliceLines(lines, definition.lineNumber, endLine))
    })
  }

  return chunks
}

function buildGoChunks(file: ScannedFile): ChunkRecord[] {
  const lines = splitLines(file.content)
  const codeLines = maskCStyleSyntax(lines)
  const chunks: ChunkRecord[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const trimmed = codeLines[index]?.trim() ?? ''
    if (!trimmed) {
      continue
    }

    const funcMatch = trimmed.match(/^func\s+(?:\(([^)]*)\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]+\]\s*)?\(/)
    if (funcMatch) {
      const receiver = funcMatch[1]
      const name = funcMatch[2]!
      const parent = receiver ? parseGoReceiverParent(receiver) : undefined
      pushLineChunk(chunks, file, lines, lineNumber, findCStyleDeclarationEnd(lines, lineNumber), {
        symbol: name,
        kind: parent ? 'method' : 'function',
        ...(parent ? { parent } : {}),
        signature: trimmed
      })
      continue
    }

    const typeBlockMatch = trimmed.match(/^type\s*\(/)
    if (typeBlockMatch) {
      const endLine = findBalancedDelimiterEnd(lines, lineNumber, '(', ')')
      for (let blockLine = lineNumber + 1; blockLine < endLine; blockLine += 1) {
        const entry = codeLines[blockLine - 1]?.trim() ?? ''
        const typeEntry = parseGoTypeDeclaration(entry)
        if (!typeEntry) {
          continue
        }

        pushLineChunk(chunks, file, lines, blockLine, Math.min(findCStyleDeclarationEnd(lines, blockLine), endLine), {
          symbol: typeEntry.name,
          kind: typeEntry.kind,
          signature: entry
        })
      }
      index = Math.max(index, endLine - 1)
      continue
    }

    const typeEntry = trimmed.startsWith('type ') ? parseGoTypeDeclaration(trimmed.replace(/^type\s+/, '')) : null
    if (typeEntry) {
      pushLineChunk(chunks, file, lines, lineNumber, findGoSimpleBlockEnd(lines, lineNumber), {
        symbol: typeEntry.name,
        kind: typeEntry.kind,
        signature: trimmed
      })
      continue
    }

    const valueBlockMatch = trimmed.match(/^(const|var)\s*\(/)
    if (valueBlockMatch) {
      const declarationKind = valueBlockMatch[1] === 'const' ? 'constant' : 'variable'
      const endLine = findBalancedDelimiterEnd(lines, lineNumber, '(', ')')
      for (let blockLine = lineNumber + 1; blockLine < endLine; blockLine += 1) {
        const entry = codeLines[blockLine - 1]?.trim() ?? ''
        const name = parseGoValueDeclarationName(entry)
        if (!name) {
          continue
        }

        pushLineChunk(chunks, file, lines, blockLine, Math.min(findGoSimpleBlockEnd(lines, blockLine), endLine), {
          symbol: name,
          kind: declarationKind,
          signature: entry
        })
      }
      index = Math.max(index, endLine - 1)
      continue
    }

    const valueMatch = trimmed.match(/^(const|var)\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
    if (valueMatch) {
      pushLineChunk(chunks, file, lines, lineNumber, findGoSimpleBlockEnd(lines, lineNumber), {
        symbol: valueMatch[2]!,
        kind: valueMatch[1] === 'const' ? 'constant' : 'variable',
        signature: trimmed
      })
    }
  }

  return dedupeChunkRecords(chunks)
}

function buildJavaChunks(file: ScannedFile): ChunkRecord[] {
  const lines = splitLines(file.content)
  const codeLines = maskCStyleSyntax(lines)
  const chunks: ChunkRecord[] = []
  const containers = collectJavaContainers(lines)
  const methods: LineContainer[] = []

  for (const container of containers) {
    pushLineChunk(chunks, file, lines, container.startLine, container.endLine, {
      symbol: container.name,
      kind: container.kind,
      ...(container.parent ? { parent: container.parent } : {}),
      signature: firstMeaningfulLine(sliceLines(lines, container.startLine, container.endLine))
    })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const trimmed = codeLines[index]?.trim() ?? ''
    const methodName = parseJavaMethodName(trimmed)
    if (!methodName) {
      continue
    }

    const parent = innermostContainer(containers, lineNumber)
    if (!parent) {
      continue
    }

    const endLine = findCStyleDeclarationEnd(lines, lineNumber)
    methods.push({ name: methodName, kind: 'method', startLine: lineNumber, endLine, parent: parent.name })
    pushLineChunk(chunks, file, lines, lineNumber, endLine, {
      symbol: methodName,
      kind: 'method',
      parent: parent.name,
      signature: trimmed
    })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const trimmed = codeLines[index]?.trim() ?? ''
    if (!trimmed || trimmed.includes('(')) {
      continue
    }

    const parent = innermostContainer(containers, lineNumber)
    if (!parent || (parent.kind !== 'enum' && !trimmed.includes(';')) || methods.some((method) => method.startLine < lineNumber && lineNumber <= method.endLine)) {
      continue
    }

    for (const field of parseJavaFieldDeclarations(trimmed, parent.kind)) {
      pushLineChunk(chunks, file, lines, lineNumber, lineNumber, {
        symbol: field.name,
        kind: field.kind,
        parent: parent.name,
        signature: trimmed
      })
    }
  }

  return dedupeChunkRecords(chunks)
}

function buildRubyChunks(file: ScannedFile): ChunkRecord[] {
  const lines = splitLines(file.content)
  const chunks: ChunkRecord[] = []
  const containers = collectRubyContainers(lines)
  const methods: LineContainer[] = []

  for (const container of containers) {
    pushLineChunk(chunks, file, lines, container.startLine, container.endLine, {
      symbol: container.name.split('::').at(-1) ?? container.name,
      kind: container.kind,
      ...(container.parent ? { parent: container.parent } : {}),
      signature: firstMeaningfulLine(sliceLines(lines, container.startLine, container.endLine))
    })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const trimmed = stripRubyComment(lines[index] ?? '').trim()
    const defMatch = trimmed.match(/^def\s+(?:(?:self|[A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_!?=]*)\b/)
    if (!defMatch) {
      continue
    }

    const parent = innermostContainer(containers, lineNumber)
    const endLine = findRubyBlockEnd(lines, lineNumber)
    methods.push({ name: defMatch[1]!, kind: parent ? 'method' : 'function', startLine: lineNumber, endLine, ...(parent ? { parent: parent.name } : {}) })
    pushLineChunk(chunks, file, lines, lineNumber, endLine, {
      symbol: defMatch[1]!,
      kind: parent ? 'method' : 'function',
      ...(parent ? { parent: parent.name.split('::').at(-1) ?? parent.name } : {}),
      signature: trimmed
    })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const trimmed = stripRubyComment(lines[index] ?? '').trim()
    if (!trimmed || methods.some((method) => method.startLine < lineNumber && lineNumber <= method.endLine)) {
      continue
    }

    const parent = innermostContainer(containers, lineNumber)
    const constantMatch = trimmed.match(/^([A-Z][A-Za-z0-9_]*)\s*=/)
    if (constantMatch) {
      pushLineChunk(chunks, file, lines, lineNumber, findRubyAssignmentEnd(lines, lineNumber), {
        symbol: constantMatch[1]!,
        kind: 'constant',
        ...(parent ? { parent: parent.name.split('::').at(-1) ?? parent.name } : {}),
        signature: trimmed
      })
      continue
    }

    const variableMatch = trimmed.match(/^(@@?[A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*|[a-z_][A-Za-z0-9_]*)\s*=/)
    if (variableMatch) {
      pushLineChunk(chunks, file, lines, lineNumber, findRubyAssignmentEnd(lines, lineNumber), {
        symbol: variableMatch[1]!,
        kind: 'variable',
        ...(parent ? { parent: parent.name.split('::').at(-1) ?? parent.name } : {}),
        signature: trimmed
      })
    }
  }

  return dedupeChunkRecords(chunks)
}

function buildRustChunks(file: ScannedFile): ChunkRecord[] {
  const lines = splitLines(file.content)
  const codeLines = maskCStyleSyntax(lines)
  const chunks: ChunkRecord[] = []
  const containers = collectRustContainers(lines)

  for (const container of containers.filter((container) => container.kind !== 'namespace')) {
    pushLineChunk(chunks, file, lines, container.startLine, container.endLine, {
      symbol: container.name,
      kind: container.kind,
      ...(container.parent ? { parent: container.parent } : {}),
      signature: firstMeaningfulLine(sliceLines(lines, container.startLine, container.endLine))
    })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const trimmed = codeLines[index]?.trim() ?? ''
    if (!trimmed) {
      continue
    }

    const fnMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+(?:"[^"]+"\s+)?)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]+>\s*)?\(/)
    if (fnMatch) {
      const parent = innermostContainer(containers, lineNumber, ['namespace', 'interface', 'module'])
      const isMethod = parent?.kind === 'namespace' || parent?.kind === 'interface'
      pushLineChunk(chunks, file, lines, lineNumber, findCStyleDeclarationEnd(lines, lineNumber), {
        symbol: fnMatch[1]!,
        kind: isMethod ? 'method' : 'function',
        ...(parent ? { parent: parent.name } : {}),
        signature: trimmed
      })
      continue
    }

    const constantMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(const|static)\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/)
    if (constantMatch) {
      const parent = innermostContainer(containers, lineNumber, ['module'])
      pushLineChunk(chunks, file, lines, lineNumber, findCStyleDeclarationEnd(lines, lineNumber), {
        symbol: constantMatch[2]!,
        kind: constantMatch[1] === 'const' ? 'constant' : 'variable',
        ...(parent ? { parent: parent.name } : {}),
        signature: trimmed
      })
    }
  }

  return dedupeChunkRecords(chunks)
}

function buildMarkdownChunks(file: ScannedFile): ChunkRecord[] {
  const lines = splitLines(file.content)
  const headings = lines
    .map((line, index) => {
      const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
      return match ? { lineNumber: index + 1, title: cleanMarkdownHeading(match[2]!) } : null
    })
    .filter((heading): heading is NonNullable<typeof heading> => heading !== null)

  if (headings.length === 0) {
    return []
  }

  const chunks: ChunkRecord[] = []

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!
    const nextHeading = headings[index + 1]
    const endLine = nextHeading ? nextHeading.lineNumber - 1 : lines.length
    pushLineChunk(chunks, file, lines, heading.lineNumber, endLine, {
      symbol: heading.title,
      kind: 'module',
      signature: lines[heading.lineNumber - 1]?.trim() ?? heading.title
    })
  }

  return chunks
}

function buildConfigChunks(file: ScannedFile): ChunkRecord[] {
  if (file.language === 'json') {
    return buildJsonConfigChunks(file)
  }

  if (file.language === 'yaml') {
    return buildYamlConfigChunks(file)
  }

  if (file.language === 'toml') {
    return buildTomlConfigChunks(file)
  }

  return []
}

function buildJsonConfigChunks(file: ScannedFile): ChunkRecord[] {
  const lines = splitLines(file.content)
  const sections: Array<{ lineNumber: number; name: string }> = []
  let depth = 0

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (depth === 1) {
      const match = line.match(/^\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*:/)
      if (match) {
        sections.push({ lineNumber: index + 1, name: unescapeJsonString(match[1]!) })
      }
    }
    depth += countDelimiter(line, '{') - countDelimiter(line, '}')
  }

  return buildConfigSectionChunks(file, lines, sections)
}

function buildYamlConfigChunks(file: ScannedFile): ChunkRecord[] {
  const lines = splitLines(file.content)
  const sections = lines
    .map((line, index) => {
      const match = line.match(/^([A-Za-z0-9_.-]+):(?:\s|$)/)
      return match ? { lineNumber: index + 1, name: match[1]! } : null
    })
    .filter((section): section is NonNullable<typeof section> => section !== null)

  return buildConfigSectionChunks(file, lines, sections)
}

function buildTomlConfigChunks(file: ScannedFile): ChunkRecord[] {
  const lines = splitLines(file.content)
  const sections = lines
    .map((line, index) => {
      const trimmed = line.trim()
      const headingMatch = trimmed.match(/^\[\[?\s*([^\]]+?)\s*\]?\]$/)
      if (headingMatch) {
        return { lineNumber: index + 1, name: headingMatch[1]! }
      }

      const keyMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=/)
      return keyMatch ? { lineNumber: index + 1, name: keyMatch[1]! } : null
    })
    .filter((section): section is NonNullable<typeof section> => section !== null)

  return buildConfigSectionChunks(file, lines, sections)
}

function buildConfigSectionChunks(
  file: ScannedFile,
  lines: string[],
  sections: Array<{ lineNumber: number; name: string }>
): ChunkRecord[] {
  if (sections.length === 0) {
    return []
  }

  const chunks: ChunkRecord[] = []
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]!
    const nextSection = sections[index + 1]
    const endLine = nextSection ? nextSection.lineNumber - 1 : lines.length
    pushLineChunk(chunks, file, lines, section.lineNumber, endLine, {
      symbol: section.name,
      kind: 'variable',
      signature: firstMeaningfulLine(sliceLines(lines, section.lineNumber, endLine))
    })
  }

  return chunks
}

function buildFallbackChunks(file: ScannedFile): ChunkRecord[] {
  const lines = splitLines(file.content)
  const chunks: ChunkRecord[] = []
  const step = FALLBACK_WINDOW_LINES - FALLBACK_OVERLAP_LINES

  for (let startIndex = 0; startIndex < lines.length; startIndex += step) {
    const startLine = startIndex + 1
    const endLine = Math.min(lines.length, startIndex + FALLBACK_WINDOW_LINES)
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
      generated: file.generated,
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
  pushLineChunk(chunks, file, lines, start, end, metadata)
}

function pushLineChunk(
  chunks: ChunkRecord[],
  file: ScannedFile,
  lines: string[],
  declarationStartLine: number,
  declarationEndLine: number,
  metadata: {
    symbol?: string
    kind?: SymbolKind
    parent?: string
    signature?: string
  }
): void {
  const startLine = extendStartForContext(lines, declarationStartLine)
  const endLine = Math.max(startLine, Math.min(lines.length, declarationEndLine))
  const content = sliceLines(lines, startLine, endLine)
  const signature = metadata.signature ?? firstMeaningfulLine(content)
  const breadcrumb = [file.relativePath, metadata.parent, metadata.symbol].filter(Boolean).join(' > ')
  const embeddingText = [breadcrumb, signature, content].filter(Boolean).join('\n')

  const chunk: ChunkRecord = {
    file: file.relativePath,
    language: file.language,
    startLine,
    endLine,
    content,
    snippet: buildSnippet(content),
    embeddingText,
    generated: file.generated
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

  if (signature) {
    chunk.signature = signature
  }

  chunks.push(chunk)
}

function hardenChunks(chunks: ChunkRecord[]): ChunkRecord[] {
  return chunks.flatMap((chunk) => splitOversizedChunk(chunk))
}

function splitOversizedChunk(chunk: ChunkRecord): ChunkRecord[] {
  const lines = splitLines(chunk.content)
  if (lines.length <= MAX_STRUCTURAL_CHUNK_LINES && estimateTokenCount(chunk.embeddingText) <= MAX_STRUCTURAL_CHUNK_TOKENS) {
    return [chunk]
  }

  const splitChunks: ChunkRecord[] = []
  for (let startIndex = 0; startIndex < lines.length; startIndex += SPLIT_WINDOW_LINES - SPLIT_OVERLAP_LINES) {
    const endIndex = Math.min(lines.length, startIndex + SPLIT_WINDOW_LINES)
    const content = lines.slice(startIndex, endIndex).join('\n')
    const startLine = chunk.startLine + startIndex
    const endLine = chunk.startLine + endIndex - 1
    splitChunks.push(rebuildChunkWithContent(chunk, content, startLine, endLine))

    if (endIndex >= lines.length) {
      break
    }
  }

  return splitChunks
}

function rebuildChunkWithContent(chunk: ChunkRecord, content: string, startLine: number, endLine: number): ChunkRecord {
  const breadcrumb = [chunk.file, chunk.parent, chunk.symbol].filter(Boolean).join(' > ')
  const embeddingText = [breadcrumb, chunk.signature, content].filter(Boolean).join('\n')
  const rebuilt: ChunkRecord = {
    file: chunk.file,
    language: chunk.language,
    startLine,
    endLine,
    content,
    snippet: buildSnippet(content),
    embeddingText,
    generated: chunk.generated
  }

  if (chunk.symbol) {
    rebuilt.symbol = chunk.symbol
  }
  if (chunk.kind) {
    rebuilt.kind = chunk.kind
  }
  if (chunk.parent) {
    rebuilt.parent = chunk.parent
  }
  if (chunk.signature) {
    rebuilt.signature = chunk.signature
  }

  return rebuilt
}

function dedupeChunkRecords(chunks: ChunkRecord[]): ChunkRecord[] {
  const seen = new Set<string>()
  const deduped: ChunkRecord[] = []

  for (const chunk of chunks) {
    const key = [chunk.file, chunk.startLine, chunk.endLine].join('\0')
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    deduped.push(chunk)
  }

  return deduped
}

function parseGoTypeDeclaration(entry: string): { name: string; kind: SymbolKind } | null {
  const structuralMatch = entry.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(?:=\s*)?(struct|interface)\b/)
  if (structuralMatch) {
    return {
      name: structuralMatch[1]!,
      kind: structuralMatch[2] === 'interface' ? 'interface' : 'class'
    }
  }

  const aliasMatch = entry.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(?:=\s*)?[A-Za-z_][A-Za-z0-9_./\[\]*]*/)
  return aliasMatch ? { name: aliasMatch[1]!, kind: 'type' } : null
}

function parseGoValueDeclarationName(entry: string): string | null {
  if (!entry || entry.startsWith(')')) {
    return null
  }

  return entry.match(/^([A-Za-z_][A-Za-z0-9_]*)\b/)?.[1] ?? null
}

function parseJavaFieldDeclarations(trimmed: string, parentKind: SymbolKind): Array<{ name: string; kind: SymbolKind }> {
  if (/^(?:package|import)\b/.test(trimmed) || /\b(?:return|throw|new)\b/.test(trimmed)) {
    return []
  }

  if (parentKind === 'enum') {
    const enumConstants = trimmed
      .replace(/;.*/, '')
      .split(',')
      .map((part) => part.trim().match(/^([A-Z][A-Z0-9_]*)\b/)?.[1])
      .filter((name): name is string => Boolean(name))
    if (enumConstants.length > 0) {
      return enumConstants.map((name) => ({ name, kind: 'constant' as const }))
    }
  }

  if (!trimmed.endsWith(';') || /^[{};]/.test(trimmed)) {
    return []
  }

  const withoutInitializerNoise = trimmed.replace(/;.*/, '')
  const declarationParts = splitTopLevelComma(withoutInitializerNoise)
  if (declarationParts.length === 0) {
    return []
  }

  const isConstant = /\bstatic\s+final\b/.test(trimmed) || /\bfinal\s+static\b/.test(trimmed)
  const fields: Array<{ name: string; kind: SymbolKind }> = []

  for (const [index, part] of declarationParts.entries()) {
    const beforeInitializer = part.split('=')[0]?.trim() ?? ''
    const nameMatch = beforeInitializer.match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\[\s*\])?$/)
    const name = nameMatch?.[1]
    if (!name || JAVA_CONTROL_KEYWORDS.has(name)) {
      continue
    }

    if (index === 0) {
      const tokens = beforeInitializer.split(/\s+/).filter(Boolean)
      if (tokens.length < 2) {
        continue
      }
    }

    fields.push({ name, kind: isConstant ? 'constant' : 'variable' })
  }

  return fields
}

function splitTopLevelComma(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''

  for (const char of value) {
    if (char === '<' || char === '[' || char === '(') {
      depth += 1
    } else if (char === '>' || char === ']' || char === ')') {
      depth = Math.max(0, depth - 1)
    }

    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  if (current.trim()) {
    parts.push(current.trim())
  }

  return parts
}

function findRubyAssignmentEnd(lines: string[], startLine: number): number {
  const trimmed = stripRubyComment(lines[startLine - 1] ?? '').trim()
  if (/[\[{(]\s*$/.test(trimmed)) {
    return findRubyBlockEnd(lines, startLine)
  }

  return startLine
}

function collectJavaContainers(lines: string[]): LineContainer[] {
  const containers: LineContainer[] = []
  const codeLines = maskCStyleSyntax(lines)

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const trimmed = codeLines[index]?.trim() ?? ''
    const match = trimmed.match(/^(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed)\s+)*(class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/)
    if (!match) {
      continue
    }

    const kind = javaContainerKind(match[1]!)
    const endLine = findCStyleDeclarationEnd(lines, lineNumber)
    const parent = innermostContainer(containers, lineNumber)
    const container: LineContainer = {
      name: match[2]!,
      kind,
      startLine: lineNumber,
      endLine
    }
    if (parent) {
      container.parent = parent.name
    }
    containers.push(container)
  }

  return containers
}

function collectRubyContainers(lines: string[]): LineContainer[] {
  const containers: LineContainer[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const trimmed = lines[index]?.trim() ?? ''
    const match = trimmed.match(/^(class|module)\s+([A-Za-z_][A-Za-z0-9_:]*)\b/)
    if (!match) {
      continue
    }

    const parent = innermostContainer(containers, lineNumber)
    const container: LineContainer = {
      name: match[2]!,
      kind: match[1] === 'module' ? 'module' : 'class',
      startLine: lineNumber,
      endLine: findRubyBlockEnd(lines, lineNumber)
    }
    if (parent) {
      container.parent = parent.name.split('::').at(-1) ?? parent.name
    }
    containers.push(container)
  }

  return containers
}

function collectRustContainers(lines: string[]): LineContainer[] {
  const containers: LineContainer[] = []
  const codeLines = maskCStyleSyntax(lines)

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const trimmed = codeLines[index]?.trim() ?? ''
    if (!trimmed) {
      continue
    }

    const implParent = parseRustImplParent(trimmed)
    if (implParent) {
      containers.push({
        name: implParent,
        kind: 'namespace',
        startLine: lineNumber,
        endLine: findCStyleDeclarationEnd(lines, lineNumber)
      })
      continue
    }

    const typeMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|mod|type)\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
    if (!typeMatch) {
      continue
    }

    const kind = rustContainerKind(typeMatch[1]!)
    const parent = innermostContainer(containers, lineNumber, ['module'])
    const container: LineContainer = {
      name: typeMatch[2]!,
      kind,
      startLine: lineNumber,
      endLine: findCStyleDeclarationEnd(lines, lineNumber)
    }
    if (parent) {
      container.parent = parent.name
    }
    containers.push(container)
  }

  return containers
}

function innermostContainer(containers: LineContainer[], lineNumber: number, kinds?: SymbolKind[]): LineContainer | undefined {
  return containers
    .filter(
      (container) =>
        container.startLine < lineNumber &&
        lineNumber <= container.endLine &&
        (!kinds || kinds.includes(container.kind))
    )
    .sort((left, right) => {
      const leftSpan = left.endLine - left.startLine
      const rightSpan = right.endLine - right.startLine
      return leftSpan - rightSpan
    })[0]
}

function parseJavaMethodName(trimmed: string): string | null {
  if (!trimmed || isCommentOnly(trimmed) || trimmed.startsWith('@') || !trimmed.includes('(')) {
    return null
  }

  const beforeParen = trimmed.slice(0, trimmed.indexOf('(')).trim()
  if (!beforeParen || /[=]/.test(beforeParen) || /\b(?:class|interface|enum|record|new|return|throw)\b/.test(beforeParen)) {
    return null
  }

  const name = beforeParen.split(/\s+/).at(-1)?.replace(/^<[^>]+>\s*/, '')
  if (!name || JAVA_CONTROL_KEYWORDS.has(name)) {
    return null
  }

  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : null
}

const JAVA_CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'try', 'synchronized', 'do'])

function javaContainerKind(keyword: string): SymbolKind {
  if (keyword === 'interface') {
    return 'interface'
  }

  if (keyword === 'enum') {
    return 'enum'
  }

  return 'class'
}

function rustContainerKind(keyword: string): SymbolKind {
  if (keyword === 'trait') {
    return 'interface'
  }

  if (keyword === 'enum') {
    return 'enum'
  }

  if (keyword === 'mod') {
    return 'module'
  }

  if (keyword === 'type') {
    return 'type'
  }

  return 'class'
}

function parseGoReceiverParent(receiver: string): string | undefined {
  const withoutParens = receiver.replace(/[()]/g, ' ').trim()
  const withoutName = withoutParens.replace(/^[_A-Za-z][_A-Za-z0-9]*\s+/, '').trim()
  const typePart = withoutName
    .replace(/^\*+/, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/^&+/, '')
    .trim()
  const lastSegment = typePart.split('.').at(-1) ?? typePart
  return lastSegment.match(/[A-Za-z_][A-Za-z0-9_]*/)?.[0]
}

function parseRustImplParent(trimmed: string): string | undefined {
  const implMatch = trimmed.match(/^(?:unsafe\s+)?impl(?:<[^>{}]+>)?\s+(.+?)(?:\s+where\b|\s*\{|$)/)
  if (!implMatch) {
    return undefined
  }

  const target = implMatch[1]!.includes(' for ')
    ? implMatch[1]!.split(/\s+for\s+/).at(-1)!
    : implMatch[1]!
  return target.replace(/[<&].*$/, '').split('::').at(-1)?.match(/[A-Za-z_][A-Za-z0-9_]*/)?.[0]
}

function findGoSimpleBlockEnd(lines: string[], startLine: number): number {
  const line = stripLineComment(lines[startLine - 1] ?? '')
  return line.includes('(') && !line.includes('{')
    ? findBalancedDelimiterEnd(lines, startLine, '(', ')')
    : findCStyleDeclarationEnd(lines, startLine)
}

function findCStyleDeclarationEnd(lines: string[], startLine: number): number {
  const codeLines = maskCStyleSyntax(lines)
  let depth = 0
  let sawBrace = false

  for (let index = startLine - 1; index < codeLines.length; index += 1) {
    const line = codeLines[index] ?? ''
    for (const char of line) {
      if (char === '{') {
        depth += 1
        sawBrace = true
      } else if (char === '}') {
        depth -= 1
      }
    }

    if (sawBrace && depth <= 0) {
      return index + 1
    }

    if (!sawBrace && line.includes(';')) {
      return index + 1
    }
  }

  return startLine
}

function findBalancedDelimiterEnd(lines: string[], startLine: number, open: string, close: string): number {
  const codeLines = maskCStyleSyntax(lines)
  let depth = 0
  let sawOpen = false

  for (let index = startLine - 1; index < codeLines.length; index += 1) {
    const line = codeLines[index] ?? ''
    for (const char of line) {
      if (char === open) {
        depth += 1
        sawOpen = true
      } else if (char === close) {
        depth -= 1
      }
    }

    if (sawOpen && depth <= 0) {
      return index + 1
    }
  }

  return startLine
}

function findRubyBlockEnd(lines: string[], startLine: number): number {
  let depth = 0
  let sawOpen = false

  for (let index = startLine - 1; index < lines.length; index += 1) {
    const line = stripRubyComment(lines[index] ?? '')
    const openCount = countRubyOpeners(line)
    const closeCount = countRubyClosers(line)
    depth += openCount
    if (openCount > 0) {
      sawOpen = true
    }
    depth -= closeCount

    if (sawOpen && depth <= 0) {
      return index + 1
    }
  }

  return startLine
}

function countRubyOpeners(line: string): number {
  const trimmed = line.trim()
  if (!trimmed) {
    return 0
  }

  let count = 0
  if (/^(class|module|def|if|unless|case|begin|while|until|for)\b/.test(trimmed)) {
    count += 1
  }
  if (/\bdo\b(?:\s*\|[^|]*\|)?\s*$/.test(trimmed)) {
    count += 1
  }
  return count
}

function countRubyClosers(line: string): number {
  return /^end\b/.test(line.trim()) ? 1 : 0
}

function maskCStyleSyntax(lines: string[]): string[] {
  const maskedLines: string[] = []
  let inBlockComment = false
  let stringQuote: '"' | "'" | '`' | null = null
  let escaped = false

  for (const line of lines) {
    let masked = ''

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]!
      const next = line[index + 1]

      if (inBlockComment) {
        if (char === '*' && next === '/') {
          masked += '  '
          index += 1
          inBlockComment = false
        } else {
          masked += ' '
        }
        continue
      }

      if (stringQuote) {
        if (escaped) {
          escaped = false
          masked += ' '
          continue
        }

        if (char === '\\' && stringQuote !== '`') {
          escaped = true
          masked += ' '
          continue
        }

        if (char === stringQuote) {
          stringQuote = null
        }

        masked += ' '
        continue
      }

      if (char === '/' && next === '/') {
        masked += ' '.repeat(line.length - index)
        break
      }

      if (char === '/' && next === '*') {
        masked += '  '
        index += 1
        inBlockComment = true
        continue
      }

      if (char === '"' || char === "'" || char === '`') {
        stringQuote = char
        masked += ' '
        continue
      }

      masked += char
    }

    maskedLines.push(masked)
    if (stringQuote !== '`') {
      stringQuote = null
      escaped = false
    }
  }

  return maskedLines
}

function stripLineComment(line: string): string {
  return line.replace(/\/\/.*$/, '')
}

function stripRubyComment(line: string): string {
  return line.replace(/#.*$/, '')
}

function isCommentOnly(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('#')
}

function countDelimiter(line: string, delimiter: string): number {
  return [...line].filter((char) => char === delimiter).length
}

function unescapeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string
  } catch {
    return value
  }
}

function cleanMarkdownHeading(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+#*\s*$/, '')
    .trim()
}

function splitLines(content: string): string[] {
  return content.split(/\r?\n/)
}

function sliceLines(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join('\n')
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

function estimateTokenCount(value: string): number {
  if (!value.trim()) {
    return 0
  }

  return Math.max(1, Math.ceil(value.length / 4))
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
