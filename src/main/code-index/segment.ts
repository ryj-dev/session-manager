/**
 * Source segmentation: tree-sitter parse → symbol records + chunk records.
 *
 * Chunks are symbol-boundary-aware: one chunk per top-level definition
 * (functions, classes, arrow consts, interfaces, …), each prefixed with a
 * synthesised `repo · path · Qualified.name` header so the embedding carries
 * location. Code between definitions becomes plain windowed chunks. Files in
 * unknown languages (or when the WASM runtime fails to load) fall back to
 * fixed-window chunks — coverage degrades, it never disappears.
 *
 * Grammars are lazy-loaded WASMs from resources/tree-sitter/; the runtime
 * (web-tree-sitter) initialises once per process on first use.
 */

import path from 'node:path'
import fs from 'node:fs'

export interface SymbolRecord {
  kind: string
  name: string
  signature: string
  startLine: number
  endLine: number
  parentName: string | null
}

export interface ChunkRecord {
  header: string
  text: string
  startLine: number
  endLine: number
  /** Index into the symbols array, or null for gap/fallback chunks. */
  symbolIdx: number | null
}

export interface SegmentResult {
  symbols: SymbolRecord[]
  chunks: ChunkRecord[]
}

// Same budget as memory-note chunking (headroom under bge's 512 tokens).
const MAX_CHUNK_CHARS = 1600
const MAX_SIGNATURE_CHARS = 200

// ─── Grammar / runtime lifecycle ────────────────────────────────────────────

const PARSED_LANGS = new Set(['typescript', 'tsx', 'javascript', 'python'])

let grammarDir: string | null = null
let runtimeFailed = false
let parserPromise: Promise<any> | null = null
const languages = new Map<string, any>()
const queries = new Map<string, any>()

export function configureSegmenter(dir: string): void {
  grammarDir = dir
}

/** False only after a load attempt has failed (degraded to fallback chunks). */
export function isSegmenterAvailable(): boolean {
  return !runtimeFailed
}

async function getParser(): Promise<any | null> {
  if (runtimeFailed || !grammarDir) return null
  if (!parserPromise) {
    parserPromise = (async () => {
      const { Parser } = await import('web-tree-sitter')
      await Parser.init()
      return new Parser()
    })().catch((err) => {
      console.error('[code-index] tree-sitter runtime failed — using fallback chunks:', err)
      runtimeFailed = true
      parserPromise = null
      return null
    })
  }
  return parserPromise
}

async function getLanguage(lang: string): Promise<any | null> {
  if (languages.has(lang)) return languages.get(lang)
  if (runtimeFailed || !grammarDir) return null
  const wasmPath = path.join(grammarDir, `tree-sitter-${lang}.wasm`)
  try {
    if (!fs.existsSync(wasmPath)) throw new Error(`grammar not found: ${wasmPath}`)
    const { Language } = await import('web-tree-sitter')
    const language = await Language.load(wasmPath)
    languages.set(lang, language)
    return language
  } catch (err) {
    console.warn(`[code-index] grammar load failed for ${lang} — fallback chunks:`, err)
    languages.set(lang, null)
    return null
  }
}

// ─── Symbol queries ─────────────────────────────────────────────────────────

const TS_QUERY = `
(function_declaration name: (identifier) @name) @def
(generator_function_declaration name: (identifier) @name) @def
(class_declaration name: (type_identifier) @name) @def
(abstract_class_declaration name: (type_identifier) @name) @def
(method_definition name: (property_identifier) @name) @def
(interface_declaration name: (type_identifier) @name) @def
(type_alias_declaration name: (type_identifier) @name) @def
(enum_declaration name: (identifier) @name) @def
(lexical_declaration (variable_declarator
  name: (identifier) @name
  value: [(arrow_function) (function_expression)])) @def
`

const JS_QUERY = `
(function_declaration name: (identifier) @name) @def
(generator_function_declaration name: (identifier) @name) @def
(class_declaration name: (identifier) @name) @def
(method_definition name: (property_identifier) @name) @def
(lexical_declaration (variable_declarator
  name: (identifier) @name
  value: [(arrow_function) (function_expression)])) @def
`

const PY_QUERY = `
(function_definition name: (identifier) @name) @def
(class_definition name: (identifier) @name) @def
`

const QUERY_BY_LANG: Record<string, string> = {
  typescript: TS_QUERY,
  tsx: TS_QUERY,
  javascript: JS_QUERY,
  python: PY_QUERY
}

const KIND_BY_NODE_TYPE: Record<string, string> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  function_definition: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  class_definition: 'class',
  method_definition: 'method',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  lexical_declaration: 'function' // arrow/function-expression const
}

async function getQuery(lang: string): Promise<any | null> {
  if (queries.has(lang)) return queries.get(lang)
  const language = await getLanguage(lang)
  if (!language) {
    queries.set(lang, null)
    return null
  }
  try {
    const { Query } = await import('web-tree-sitter')
    const query = new Query(language, QUERY_BY_LANG[lang])
    queries.set(lang, query)
    return query
  } catch (err) {
    console.warn(`[code-index] query compile failed for ${lang}:`, err)
    queries.set(lang, null)
    return null
  }
}

// ─── Segmentation ───────────────────────────────────────────────────────────

interface RawDef {
  node: any
  name: string
  startIndex: number
  endIndex: number
}

export async function segmentFile(
  repoName: string,
  relPath: string,
  lang: string | null,
  content: string
): Promise<SegmentResult> {
  const baseHeader = `${repoName} · ${relPath}`
  if (!lang || !PARSED_LANGS.has(lang)) {
    return { symbols: [], chunks: windowChunks(baseHeader, content, 1) }
  }

  const parser = await getParser()
  const language = await getLanguage(lang)
  const query = await getQuery(lang)
  if (!parser || !language || !query) {
    return { symbols: [], chunks: windowChunks(baseHeader, content, 1) }
  }

  let tree: any = null
  try {
    parser.setLanguage(language)
    tree = parser.parse(content)
    if (!tree) throw new Error('parse returned null')

    // Collect definition nodes with their names from query matches.
    const defs: RawDef[] = []
    for (const match of query.matches(tree.rootNode)) {
      let node: any = null
      let name: string | null = null
      for (const cap of match.captures) {
        if (cap.name === 'def') node = cap.node
        else if (cap.name === 'name') name = cap.node.text
      }
      if (node && name) {
        defs.push({ node, name, startIndex: node.startIndex, endIndex: node.endIndex })
      }
    }
    // Parents before children at the same start.
    defs.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)

    // Parent = nearest strictly-containing def (stack over the sorted list).
    const symbols: SymbolRecord[] = []
    const stack: Array<{ def: RawDef; symbolIdx: number }> = []
    const topLevel: Array<{ def: RawDef; symbolIdx: number }> = []
    for (const def of defs) {
      while (stack.length > 0 && stack[stack.length - 1].def.endIndex <= def.startIndex) {
        stack.pop()
      }
      const parent = stack[stack.length - 1] ?? null
      const firstLine = def.node.text.split('\n', 1)[0].slice(0, MAX_SIGNATURE_CHARS)
      const record: SymbolRecord = {
        kind: KIND_BY_NODE_TYPE[def.node.type] ?? 'symbol',
        name: def.name,
        signature: firstLine,
        startLine: def.node.startPosition.row + 1,
        endLine: def.node.endPosition.row + 1,
        parentName: parent ? symbols[parent.symbolIdx].name : null
      }
      const symbolIdx = symbols.length
      symbols.push(record)
      if (!parent) topLevel.push({ def, symbolIdx })
      stack.push({ def, symbolIdx })
    }

    // Chunks: one per top-level def (methods live inside their class chunk —
    // they're still individually findable via the symbols table and FTS),
    // plus windowed gap chunks for file-level code between defs.
    const chunks: ChunkRecord[] = []
    let cursor = 0 // byte offset into content
    const pushGap = (from: number, to: number): void => {
      const gapText = content.slice(from, to)
      if (!gapText.trim()) return
      const startLine = lineOfIndex(content, from)
      chunks.push(...windowChunks(baseHeader, gapText, startLine))
    }
    for (const { def, symbolIdx } of topLevel) {
      pushGap(cursor, def.startIndex)
      const sym = symbols[symbolIdx]
      const qualified = sym.parentName ? `${sym.parentName}.${sym.name}` : sym.name
      const header = `${baseHeader} · ${qualified}`
      const body = content.slice(def.startIndex, def.endIndex)
      chunks.push(...windowChunks(header, body, sym.startLine, symbolIdx))
      cursor = Math.max(cursor, def.endIndex)
    }
    pushGap(cursor, content.length)

    return { symbols, chunks }
  } catch (err) {
    console.warn(`[code-index] segment failed for ${relPath} — fallback chunks:`, err)
    return { symbols: [], chunks: windowChunks(baseHeader, content, 1) }
  } finally {
    try {
      tree?.delete()
    } catch {
      /* best-effort */
    }
  }
}

/** 1-based line number of a byte offset. */
function lineOfIndex(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++
  }
  return line
}

/**
 * Split text into ≤MAX_CHUNK_CHARS windows on line boundaries, prefixing
 * each window's text with the header so the embedding carries location.
 */
export function windowChunks(
  header: string,
  text: string,
  startLine: number,
  symbolIdx: number | null = null
): ChunkRecord[] {
  const chunks: ChunkRecord[] = []
  const lines = text.split('\n')
  let buf: string[] = []
  let bufChars = 0
  let bufStartLine = startLine
  let line = startLine

  const flush = (endLine: number): void => {
    const body = buf.join('\n').trim()
    if (body) {
      chunks.push({
        header,
        text: `${header}\n${body}`,
        startLine: bufStartLine,
        endLine,
        symbolIdx
      })
    }
    buf = []
    bufChars = 0
  }

  for (const l of lines) {
    // A single pathological line gets hard-sliced rather than emitted whole.
    if (l.length > MAX_CHUNK_CHARS) {
      flush(line - 1)
      bufStartLine = line
      for (let i = 0; i < l.length; i += MAX_CHUNK_CHARS) {
        chunks.push({
          header,
          text: `${header}\n${l.slice(i, i + MAX_CHUNK_CHARS)}`,
          startLine: line,
          endLine: line,
          symbolIdx
        })
      }
      line++
      bufStartLine = line
      continue
    }
    if (bufChars + l.length + 1 > MAX_CHUNK_CHARS && buf.length > 0) {
      flush(line - 1)
      bufStartLine = line
    }
    buf.push(l)
    bufChars += l.length + 1
    line++
  }
  flush(line - 1)
  return chunks
}
