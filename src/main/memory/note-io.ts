/**
 * File I/O and compound note operations parameterized by directory.
 * No electron imports — safe for both main process and MCP server.
 */

import fs from 'fs'
import path from 'path'
import {
  parseRawNote,
  filenameToWikilink,
  addToRelatedSection,
  removeFromRelatedSection,
  type MemoryNote
} from './core'

export interface NoteIO {
  readNote: (filename: string) => MemoryNote | null
  writeNote: (filename: string, rawBody: string) => void
  deleteNote: (filename: string) => void
  listNotes: () => string[]
  resolveWikilink: (link: string) => string | null
  syncBacklinks: (filename: string, oldWikilinks: string[], newWikilinks: string[]) => void
  getInboundLinks: (filename: string) => string[]
  cleanupRefsBeforeDelete: (filename: string) => void
}

/**
 * Create a NoteIO instance bound to a specific memories directory.
 * All file operations are scoped to this directory.
 */
export function createNoteIO(memoriesDir: string): NoteIO {
  fs.mkdirSync(memoriesDir, { recursive: true })

  function readNote(filename: string): MemoryNote | null {
    const fullPath = path.join(memoriesDir, filename)
    if (!fs.existsSync(fullPath)) return null
    const raw = fs.readFileSync(fullPath, 'utf-8')
    return parseRawNote(filename, raw)
  }

  function writeNote(filename: string, rawBody: string): void {
    fs.writeFileSync(path.join(memoriesDir, filename), rawBody, 'utf-8')
  }

  function deleteNote(filename: string): void {
    try {
      const fullPath = path.join(memoriesDir, filename)
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath)
    } catch { /* may fail on Windows if file is locked */ }
  }

  function listNotes(): string[] {
    if (!fs.existsSync(memoriesDir)) return []
    return fs.readdirSync(memoriesDir).filter((f) => f.endsWith('.md'))
  }

  function resolveWikilink(link: string): string | null {
    const direct = link.endsWith('.md') ? link : `${link}.md`
    const fullPath = path.join(memoriesDir, direct)
    if (fs.existsSync(fullPath)) return direct

    const lower = direct.toLowerCase()
    for (const f of listNotes()) {
      if (f.toLowerCase() === lower) return f
    }
    return null
  }

  function syncBacklinks(filename: string, oldWikilinks: string[], newWikilinks: string[]): void {
    const oldSet = new Set(oldWikilinks)
    const newSet = new Set(newWikilinks)
    const added = newWikilinks.filter((l) => !oldSet.has(l))
    const removed = oldWikilinks.filter((l) => !newSet.has(l))
    const sourceWikilink = filenameToWikilink(filename)

    for (const link of added) {
      const target = resolveWikilink(link)
      if (!target || target === filename) continue
      const note = readNote(target)
      if (!note) continue
      const updated = addToRelatedSection(note.rawBody, sourceWikilink)
      if (updated !== note.rawBody) writeNote(target, updated)
    }

    for (const link of removed) {
      const target = resolveWikilink(link)
      if (!target || target === filename) continue
      const note = readNote(target)
      if (!note) continue
      const updated = removeFromRelatedSection(note.rawBody, sourceWikilink)
      if (updated !== note.rawBody) writeNote(target, updated)
    }
  }

  function getInboundLinks(filename: string): string[] {
    const inbound: string[] = []
    for (const fn of listNotes()) {
      if (fn === filename) continue
      const note = readNote(fn)
      if (!note) continue
      for (const link of note.wikilinks) {
        const resolved = resolveWikilink(link)
        if (resolved === filename) { inbound.push(fn); break }
      }
    }
    return inbound
  }

  function cleanupRefsBeforeDelete(filename: string): void {
    const note = readNote(filename)
    if (!note) return
    const sourceWikilink = filenameToWikilink(filename)

    for (const refFn of getInboundLinks(filename)) {
      const refNote = readNote(refFn)
      if (!refNote) continue
      const updated = removeFromRelatedSection(refNote.rawBody, sourceWikilink)
      if (updated !== refNote.rawBody) writeNote(refFn, updated)
    }

    for (const link of note.wikilinks) {
      const target = resolveWikilink(link)
      if (!target || target === filename) continue
      const targetNote = readNote(target)
      if (!targetNote) continue
      const updated = removeFromRelatedSection(targetNote.rawBody, sourceWikilink)
      if (updated !== targetNote.rawBody) writeNote(target, updated)
    }
  }

  return { readNote, writeNote, deleteNote, listNotes, resolveWikilink, syncBacklinks, getInboundLinks, cleanupRefsBeforeDelete }
}
