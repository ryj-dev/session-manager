/**
 * In-memory note index, search, wikilink resolution, and change notification.
 * Adapted from tc-sql-atlas index.ts for flat-directory Electron storage.
 */

import { BrowserWindow } from 'electron'
import {
  getAllNoteFilenames,
  readNote,
  type MemoryNote
} from './store'
import { searchSemantic, rrf, isEmbeddingsAvailable } from './embeddings'

export interface IndexedNote {
  filename: string
  title: string
  type: string
  tags: string[]
  date: string
  wikilinks: string[]
  text: string // full raw text for search
}

export interface GraphNode {
  id: string // filename
  label: string // title
  type: string
  tags: string[]
}

export interface GraphEdge {
  source: string // filename
  target: string // filename
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// ─── In-memory index state ──────────────────────────────────────────────────

let index: Map<string, IndexedNote> | null = null
let version = 0
let batchDepth = 0
let pendingFilenames = new Set<string>()
let notifyTimer: ReturnType<typeof setTimeout> | null = null

const NOTIFY_DEBOUNCE_MS = 300

export function getIndex(): Map<string, IndexedNote> {
  if (!index) index = buildIndex()
  return index
}

export function getIndexVersion(): number {
  return version
}

// ─── Batching ───────────────────────────────────────────────────────────────

export function beginBatch(): void {
  batchDepth++
  if (notifyTimer) {
    clearTimeout(notifyTimer)
    notifyTimer = null
  }
}

export function endBatch(): void {
  batchDepth = Math.max(0, batchDepth - 1)
  if (batchDepth === 0) flushNotifications()
}

// ─── Invalidation ───────────────────────────────────────────────────────────

export function invalidate(filename?: string): void {
  version++

  if (filename && index) {
    // Rebuild just this entry
    const note = readNote(filename)
    if (note) {
      index.set(filename, toIndexed(note))
    } else {
      index.delete(filename)
    }
    pendingFilenames.add(filename)
  } else {
    index = null
    pendingFilenames = new Set<string>()
  }

  if (batchDepth > 0) return

  if (notifyTimer) clearTimeout(notifyTimer)
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    flushNotifications()
  }, NOTIFY_DEBOUNCE_MS)
}

function flushNotifications(): void {
  if (notifyTimer) {
    clearTimeout(notifyTimer)
    notifyTimer = null
  }
  if (pendingFilenames.size === 0) return

  const changed = [...pendingFilenames]
  pendingFilenames = new Set()

  // Notify all renderer windows
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('memory:changed', changed)
    }
  }
}

// ─── Search ─────────────────────────────────────────────────────────────────

export function searchNotes(
  query: string,
  searchType: 'content' | 'filename' | 'both' = 'both',
  tagFilter?: string,
  typeFilter?: string
): IndexedNote[] {
  const idx = getIndex()
  const q = query.toLowerCase()

  return [...idx.values()].filter((note) => {
    if (tagFilter && !note.tags.includes(tagFilter)) return false
    if (typeFilter && note.type !== typeFilter) return false
    if (!q) return true

    const matchesFilename = note.filename.toLowerCase().includes(q)
    const matchesContent = note.text.toLowerCase().includes(q)

    if (searchType === 'filename') return matchesFilename
    if (searchType === 'content') return matchesContent
    return matchesFilename || matchesContent
  })
}

/**
 * Hybrid keyword + semantic search, fused via reciprocal rank fusion.
 * Falls back to keyword-only if the embeddings index is unavailable
 * or the query is empty.
 */
export async function searchNotesHybrid(
  query: string,
  opts: {
    searchType?: 'content' | 'filename' | 'both'
    tagFilter?: string
    typeFilter?: string
    limit?: number
  } = {}
): Promise<IndexedNote[]> {
  const limit = opts.limit ?? 20
  const keyword = searchNotes(
    query,
    opts.searchType ?? 'both',
    opts.tagFilter,
    opts.typeFilter
  )

  if (!query.trim() || !isEmbeddingsAvailable()) {
    return keyword.slice(0, limit)
  }

  const idx = getIndex()
  const semanticHits = await searchSemantic(query, 50)
  // Collapse multi-chunk hits down to per-file (best chunk wins position).
  const seenFiles = new Set<string>()
  const semanticByFile: IndexedNote[] = []
  for (const hit of semanticHits) {
    if (seenFiles.has(hit.filename)) continue
    const note = idx.get(hit.filename)
    if (!note) continue
    if (opts.tagFilter && !note.tags.includes(opts.tagFilter)) continue
    if (opts.typeFilter && note.type !== opts.typeFilter) continue
    seenFiles.add(hit.filename)
    semanticByFile.push(note)
  }

  const fused = rrf<IndexedNote>(
    [
      { items: keyword, weight: 1 },
      { items: semanticByFile, weight: 1 }
    ],
    (n) => n.filename
  )
  return fused.slice(0, limit).map((f) => f.item)
}

// ─── Graph data ─────────────────────────────────────────────────────────────

export function getGraphData(): GraphData {
  const idx = getIndex()

  const nodes: GraphNode[] = [...idx.values()].map((n) => ({
    id: n.filename,
    label: n.filename.replace(/\.md$/, ''),
    type: n.type,
    tags: n.tags
  }))

  const nodeIds = new Set(idx.keys())
  const seen = new Set<string>()
  const edges: GraphEdge[] = []

  for (const note of idx.values()) {
    for (const link of note.wikilinks) {
      const target = resolveWikilink(link, idx)
      if (!target || !nodeIds.has(target)) continue
      if (target === note.filename) continue

      // Deduplicate bidirectional pairs
      const key = [note.filename, target].sort().join('\0')
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ source: note.filename, target })
    }
  }

  return { nodes, edges }
}

// ─── Wikilink resolution ────────────────────────────────────────────────────

/**
 * Resolve a wikilink to a filename.
 * Flat directory — much simpler than atlas's nested resolution.
 *   1. Direct match: "other-note" → "other-note.md"
 *   2. Case-insensitive match
 */
export function resolveWikilink(
  link: string,
  idx?: Map<string, IndexedNote>
): string | null {
  const index = idx ?? getIndex()

  // Direct match (add .md if needed)
  const direct = link.endsWith('.md') ? link : `${link}.md`
  if (index.has(direct)) return direct

  // Case-insensitive fallback
  const lower = direct.toLowerCase()
  for (const key of index.keys()) {
    if (key.toLowerCase() === lower) return key
  }

  return null
}

// ─── Index building ─────────────────────────────────────────────────────────

function buildIndex(): Map<string, IndexedNote> {
  const map = new Map<string, IndexedNote>()
  for (const filename of getAllNoteFilenames()) {
    const note = readNote(filename)
    if (note) map.set(filename, toIndexed(note))
  }
  return map
}

function toIndexed(note: MemoryNote): IndexedNote {
  return {
    filename: note.filename,
    title: note.title,
    type: note.type,
    tags: note.tags,
    date: note.date,
    wikilinks: note.wikilinks,
    text: note.rawBody
  }
}
