/**
 * Memory note storage — Electron-aware wrapper around core and note-io.
 * Provides the same API as before, backed by the shared pure logic.
 */

import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { createNoteIO } from './note-io'

// Re-export everything from core so existing imports from './store' keep working
export {
  type MemoryNote,
  type ValidationResult,
  type NoteInput,
  type NoteType,
  type SectionName,
  extractWikilinks,
  buildRawBody,
  parseRawNote,
  formatDate,
} from './core'

let memoriesDir: string | null = null

export function getMemoriesDir(): string {
  if (!memoriesDir) {
    memoriesDir = path.join(app.getPath('userData'), 'memories')
    fs.mkdirSync(memoriesDir, { recursive: true })
  }
  return memoriesDir
}

// Lazy-init IO instance bound to the electron userData memories directory
let io: ReturnType<typeof createNoteIO> | null = null
function getIO(): ReturnType<typeof createNoteIO> {
  if (!io) io = createNoteIO(getMemoriesDir())
  return io
}

/** List all .md filenames in the memories directory. */
export function getAllNoteFilenames(): string[] {
  return getIO().listNotes()
}

/** Read a single note by filename. Returns null if not found. */
export function readNote(filename: string) {
  return getIO().readNote(filename)
}

// Track filenames we've written ourselves so the fs.watch listener can ignore
// the echo events triggered by our own writes. External edits (MCP child
// process, hand-edits) don't pass through here, so they still flow through
// the watcher normally.
const recentlyWritten = new Map<string, number>()
const RECENT_WRITE_TTL_MS = 500

export function markRecentlyWritten(filename: string): void {
  recentlyWritten.set(filename, Date.now() + RECENT_WRITE_TTL_MS)
}

export function wasRecentlyWritten(filename: string): boolean {
  const expiry = recentlyWritten.get(filename)
  if (!expiry) return false
  if (Date.now() > expiry) {
    recentlyWritten.delete(filename)
    return false
  }
  return true
}

/** Write a note to disk. Accepts full raw markdown (with frontmatter). */
export function writeNote(filename: string, rawBody: string): void {
  getIO().writeNote(filename, rawBody)
  markRecentlyWritten(filename)
}

/** Delete a note file. */
export function deleteNoteFile(filename: string): void {
  getIO().deleteNote(filename)
  markRecentlyWritten(filename)
}
