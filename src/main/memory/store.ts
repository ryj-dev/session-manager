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

/** Write a note to disk. Accepts full raw markdown (with frontmatter). */
export function writeNote(filename: string, rawBody: string): void {
  getIO().writeNote(filename, rawBody)
}

/** Delete a note file. */
export function deleteNoteFile(filename: string): void {
  getIO().deleteNote(filename)
}
