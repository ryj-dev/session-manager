/**
 * Backlink synchronization — maintains bidirectional links in ## Related sections.
 * Adapted from tc-sql-atlas backlinks.ts.
 */

import { readNote, writeNote, extractWikilinks } from './store'
import { getIndex, invalidate, resolveWikilink, beginBatch, endBatch } from './index'

/**
 * Convert a filename to its wikilink form.
 * e.g. "architecture-decisions.md" → "architecture-decisions"
 */
export function filenameToWikilink(filename: string): string {
  return filename.replace(/\.md$/, '')
}

/**
 * Insert a wikilink into the ## Related section of a markdown body.
 * Creates the section if it doesn't exist. Won't duplicate existing links.
 */
export function addToRelatedSection(rawBody: string, wikilink: string): string {
  const entry = `- [[${wikilink}]]`
  const sectionRegex = /^## Related\s*$/m

  if (sectionRegex.test(rawBody)) {
    // Already present?
    if (rawBody.includes(`[[${wikilink}]]`)) return rawBody

    const lines = rawBody.split('\n')
    const idx = lines.findIndex((l) => /^## Related\s*$/.test(l))
    let insertAt = idx + 1
    for (let i = idx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) break
      if (lines[i].trim()) insertAt = i + 1
    }
    lines.splice(insertAt, 0, entry)
    return lines.join('\n')
  }

  // No ## Related section — append at end
  const trimmed = rawBody.trimEnd()
  return `${trimmed}\n\n## Related\n\n${entry}\n`
}

/**
 * Remove a wikilink from the ## Related section only.
 */
export function removeFromRelatedSection(rawBody: string, wikilink: string): string {
  const lines = rawBody.split('\n')
  const relatedIdx = lines.findIndex((l) => /^## Related\s*$/.test(l))
  if (relatedIdx === -1) return rawBody

  let endIdx = lines.length
  for (let i = relatedIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      endIdx = i
      break
    }
  }

  const before = lines.slice(0, relatedIdx + 1)
  const section = lines
    .slice(relatedIdx + 1, endIdx)
    .filter((line) => line.trim() !== `- [[${wikilink}]]`)
  const after = lines.slice(endIdx)

  return [...before, ...section, ...after].join('\n')
}

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
