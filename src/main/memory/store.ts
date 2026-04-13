/**
 * Memory note storage — file I/O, CRUD, wikilink extraction.
 * Adapted from tc-sql-atlas vault.ts for flat-directory storage.
 */

import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import matter from 'gray-matter'

export interface MemoryNote {
  filename: string // e.g. "architecture-decisions.md"
  title: string
  type: string
  tags: string[]
  date: string // ISO
  modified: string // ISO
  body: string // markdown without frontmatter
  rawBody: string // full file content
  wikilinks: string[] // extracted [[link]] targets
}

let memoriesDir: string | null = null

export function getMemoriesDir(): string {
  if (!memoriesDir) {
    memoriesDir = path.join(app.getPath('userData'), 'memories')
    fs.mkdirSync(memoriesDir, { recursive: true })
  }
  return memoriesDir
}

/** List all .md filenames in the memories directory. */
export function getAllNoteFilenames(): string[] {
  const dir = getMemoriesDir()
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
}

/** Read a single note by filename. Returns null if not found. */
export function readNote(filename: string): MemoryNote | null {
  const fullPath = path.join(getMemoriesDir(), filename)
  if (!fs.existsSync(fullPath)) return null

  const raw = fs.readFileSync(fullPath, 'utf-8')
  return parseRawNote(filename, raw)
}

/** Parse raw markdown string into a MemoryNote. */
export function parseRawNote(filename: string, raw: string): MemoryNote {
  const { data, content } = matter(raw)
  return {
    filename,
    title: typeof data.title === 'string' ? data.title : filename.replace(/\.md$/, ''),
    type: typeof data.type === 'string' ? data.type : '',
    tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
    date: formatDate(data.date),
    modified: formatDate(data.modified),
    body: content,
    rawBody: raw,
    wikilinks: extractWikilinks(content)
  }
}

/** Write a note to disk. Accepts full raw markdown (with frontmatter). */
export function writeNote(filename: string, rawBody: string): void {
  const fullPath = path.join(getMemoriesDir(), filename)
  fs.writeFileSync(fullPath, rawBody, 'utf-8')
}

/** Delete a note file. */
export function deleteNoteFile(filename: string): void {
  const fullPath = path.join(getMemoriesDir(), filename)
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath)
}

/** Extract all [[wikilink]] targets from content. Deduplicated. */
export function extractWikilinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]]+)\]\]/g)
  return [...new Set([...matches].map((m) => m[1]))]
}

/** Build raw markdown from frontmatter object + body. */
export function buildRawBody(
  frontmatter: Record<string, unknown>,
  body: string
): string {
  return matter.stringify(body, frontmatter)
}

/** Normalize date to ISO string. */
function formatDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().split('T')[0]
  if (typeof value === 'string') return value
  return ''
}
