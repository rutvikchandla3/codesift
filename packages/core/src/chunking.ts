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
  const chunks: ChunkRecord[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const trimmed = stripLineComment(lines[index] ?? '').trim()
    if (!trimmed || isCommentOnly(trimmed)) {
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

    const typeMatch = trimmed.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)\b/)
    if (typeMatch) {
      pushLineChunk(chunks, file, lines, lineNumber, findCStyleDeclarationEnd(lines, lineNumber), {
        symbol: typeMatch[1]!,
        kind: typeMatch[2] === 'interface' ? 'interface' : 'class',
        signature: trimmed
      })
      continue
    }

    const aliasMatch = trimmed.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
    if (aliasMatch) {
      pushLineChunk(chunks, file, lines, lineNumber, findGoSimpleBlockEnd(lines, lineNumber), {
        symbol: aliasMatch[1]!,
        kind: 'type',
        signature: trimmed
      })
      continue
    }

    const valueMatch = trimmed.match(/^(const|var)\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
    if (valueMatch) {
      pushLineChunk(chunks, file, lines, lineNumber, findGoSimpleBlockEnd(lines, lineNumber), {
        symbol: valueMatch[2]!,
        kind: valueMatch[1] === 'const' ? 'constant' : 'variable',
        signature: trimmed
      })
      continue
    }

    const blockMatch = trimmed.match(/^(const|var)\s*\(/)
    if (blockMatch) {
      pushLineChunk(chunks, file, lines, lineNumber, findBalancedDelimiterEnd(lines, lineNumber, '(', ')'), {
        symbol: blockMatch[1]!,
        kind: blockMatch[1] === 'const' ? 'constant' : 'variable',
        signature: trimmed
      })
    }
  }

  return chunks
}

function buildJavaChunks(file: ScannedFile): ChunkRecord[] {
  const lines = splitLines(file.content)
  const chunks: ChunkRecord[] = []
  const containers = collectJavaContainers(lines)

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
    const trimmed = lines[index]?.trim() ?? ''
    const methodName = parseJavaMethodName(trimmed)
    if (!methodName) {
      continue
    }

    const parent = innermostContainer(containers, lineNumber)
    if (!parent) {
      continue
    }

    pushLineChunk(chunks, file, lines, lineNumber, findCStyleDeclarationEnd(lines, lineNumber), {
      symbol: methodName,
      kind: 'method',
      parent: parent.name,
      signature: trimmed
    })
  }

  return chunks
}

function buildRubyChunks(file: ScannedFile): ChunkRecord[] {
  const lines = splitLines(file.content)
  const chunks: ChunkRecord[] = []
  const containers = collectRubyContainers(lines)

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
    const trimmed = lines[index]?.trim() ?? ''
    const defMatch = trimmed.match(/^def\s+(?:(?:self|[A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_!?=]*)\b/)
    if (!defMatch) {
      continue
    }

    const parent = innermostContainer(containers, lineNumber)
    pushLineChunk(chunks, file, lines, lineNumber, findRubyBlockEnd(lines, lineNumber), {
      symbol: defMatch[1]!,
      kind: parent ? 'method' : 'function',
      ...(parent ? { parent: parent.name.split('::').at(-1) ?? parent.name } : {}),
      signature: trimmed
    })
  }

  return chunks
}

function buildRustChunks(file: ScannedFile): ChunkRecord[] {
  const lines = splitLines(file.content)
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
    const trimmed = stripLineComment(lines[index] ?? '').trim()
    if (!trimmed || isCommentOnly(trimmed)) {
      continue
    }

    const fnMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+(?:"[^"]+"\s+)?)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]+>\s*)?\(/)
    if (fnMatch) {
      const parent = innermostContainer(containers, lineNumber, ['namespace', 'interface'])
      pushLineChunk(chunks, file, lines, lineNumber, findCStyleDeclarationEnd(lines, lineNumber), {
        symbol: fnMatch[1]!,
        kind: parent ? 'method' : 'function',
        ...(parent ? { parent: parent.name } : {}),
        signature: trimmed
      })
      continue
    }

    const constantMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(const|static)\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
    if (constantMatch) {
      pushLineChunk(chunks, file, lines, lineNumber, findCStyleDeclarationEnd(lines, lineNumber), {
        symbol: constantMatch[2]!,
        kind: constantMatch[1] === 'const' ? 'constant' : 'variable',
        signature: trimmed
      })
    }
  }

  return chunks
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

function collectJavaContainers(lines: string[]): LineContainer[] {
  const containers: LineContainer[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const trimmed = lines[index]?.trim() ?? ''
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

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const trimmed = stripLineComment(lines[index] ?? '').trim()
    if (!trimmed || isCommentOnly(trimmed)) {
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
    containers.push({
      name: typeMatch[2]!,
      kind,
      startLine: lineNumber,
      endLine: findCStyleDeclarationEnd(lines, lineNumber)
    })
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
  const cleaned = receiver
    .replace(/[()[\]*&]/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .trim()
  return cleaned.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0]
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
  let depth = 0
  let sawBrace = false

  for (let index = startLine - 1; index < lines.length; index += 1) {
    const line = stripLineComment(lines[index] ?? '')
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
  let depth = 0
  let sawOpen = false

  for (let index = startLine - 1; index < lines.length; index += 1) {
    const line = stripLineComment(lines[index] ?? '')
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
