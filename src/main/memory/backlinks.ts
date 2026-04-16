/**
 * Backlink synchronization — maintains bidirectional links in ## Related sections.
 * Pure string operations come from core.ts; compound operations use the in-memory index.
 */

import { readNote, writeNote } from './store'
import { getIndex, invalidate, resolveWikilink, beginBatch, endBatch } from './index'

// Re-export pure string ops from core for backward compatibility
export { filenameToWikilink, addToRelatedSection, removeFromRelatedSection } from './core'
import { filenameToWikilink, addToRelatedSection, removeFromRelatedSection } from './core'

/**
 * Synchronize backlinks after a note's wikilinks change.
 * Adds reverse links for new outbound links, removes reverse links for removed ones.
 */
export function syncBacklinks(
  filename: string,
  oldWikilinks: string[],
  newWikilinks: string[]
): void {
  const oldSet = new Set(oldWikilinks)
  const newSet = new Set(newWikilinks)

  const added = newWikilinks.filter((l) => !oldSet.has(l))
  const removed = oldWikilinks.filter((l) => !newSet.has(l))

  if (added.length === 0 && removed.length === 0) return

  const index = getIndex()
  const sourceWikilink = filenameToWikilink(filename)

  beginBatch()
  try {
    // Update target notes' Related sections (add/remove backlink to source)
    for (const link of added) {
      const targetFilename = resolveWikilink(link, index)
      if (!targetFilename || targetFilename === filename) continue

      const targetNote = readNote(targetFilename)
      if (!targetNote) continue

      const updated = addToRelatedSection(targetNote.rawBody, sourceWikilink)
      if (updated !== targetNote.rawBody) {
        writeNote(targetFilename, updated)
        invalidate(targetFilename)
      }
    }

    for (const link of removed) {
      const targetFilename = resolveWikilink(link, index)
      if (!targetFilename || targetFilename === filename) continue

      const targetNote = readNote(targetFilename)
      if (!targetNote) continue

      const updated = removeFromRelatedSection(targetNote.rawBody, sourceWikilink)
      if (updated !== targetNote.rawBody) {
        writeNote(targetFilename, updated)
        invalidate(targetFilename)
      }
    }

    // Update source note's Related section with outbound targets
    const sourceNote = readNote(filename)
    if (sourceNote) {
      let updatedRaw = sourceNote.rawBody

      for (const link of added) {
        const targetFilename = resolveWikilink(link, index)
        if (!targetFilename || targetFilename === filename) continue
        updatedRaw = addToRelatedSection(updatedRaw, filenameToWikilink(targetFilename))
      }

      for (const link of removed) {
        const targetFilename = resolveWikilink(link, index)
        if (!targetFilename || targetFilename === filename) continue
        // Only remove from source's Related if target doesn't also link back
        const targetNote = readNote(targetFilename)
        const targetLinksToSource = targetNote?.wikilinks.some((l) => {
          const resolved = resolveWikilink(l, index)
          return resolved === filename
        }) ?? false
        if (!targetLinksToSource) {
          updatedRaw = removeFromRelatedSection(updatedRaw, filenameToWikilink(targetFilename))
        }
      }

      if (updatedRaw !== sourceNote.rawBody) {
        writeNote(filename, updatedRaw)
        invalidate(filename)
      }
    }
  } finally {
    endBatch()
  }
}

/**
 * Get all notes that link TO this note (inbound links).
 */
export function getInboundLinks(filename: string): string[] {
  const index = getIndex()
  const inbound: string[] = []

  for (const [fn, note] of index) {
    if (fn === filename) continue
    for (const link of note.wikilinks) {
      const resolved = resolveWikilink(link, index)
      if (resolved === filename) {
        inbound.push(fn)
        break
      }
    }
  }

  return inbound
}

/**
 * Clean up all references to a note before deletion.
 * Removes the note's wikilink from all referencing notes' ## Related sections,
 * and removes reverse backlinks from notes that this note links to.
 */
export function cleanupRefsBeforeDelete(filename: string): number {
  const note = readNote(filename)
  if (!note) return 0

  const index = getIndex()
  const sourceWikilink = filenameToWikilink(filename)
  let cleaned = 0

  beginBatch()
  try {
    // Remove inbound refs (other notes linking to this note)
    const inbound = getInboundLinks(filename)
    for (const refFilename of inbound) {
      const refNote = readNote(refFilename)
      if (!refNote) continue

      const updated = removeFromRelatedSection(refNote.rawBody, sourceWikilink)
      if (updated !== refNote.rawBody) {
        writeNote(refFilename, updated)
        invalidate(refFilename)
        cleaned++
      }
    }

    // Remove outbound backlinks (this note's links → target ## Related)
    for (const link of note.wikilinks) {
      const targetFilename = resolveWikilink(link, index)
      if (!targetFilename || targetFilename === filename) continue

      const targetNote = readNote(targetFilename)
      if (!targetNote) continue

      const updated = removeFromRelatedSection(targetNote.rawBody, sourceWikilink)
      if (updated !== targetNote.rawBody) {
        writeNote(targetFilename, updated)
        invalidate(targetFilename)
        cleaned++
      }
    }
  } finally {
    endBatch()
  }

  return cleaned
}
