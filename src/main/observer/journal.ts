/**
 * The curator's observations journal — its private memory across runs.
 *
 * V1's curator was amnesiac: every run judged its inputs from scratch, so a
 * hypothesis it rejected on Monday was re-derived and re-rejected on Tuesday.
 * The journal fixes that: freeform markdown the curator reads at the start of
 * each run and REWRITES at the end (hypotheses, confidence accrued, why past
 * ideas were rejected, what to watch for next).
 *
 * It is deliberately NOT a memory note: it never appears in search-memories,
 * the memory graph, or prompt-time memory injection — it lives as a single
 * file in userData, not in the memories directory. The user can read it in
 * the insights inbox's Journal tab; the only writers are the in-flight
 * curator run (token-gated HTTP, same boundary as observer-suggest) and the
 * curator alone.
 *
 * Whole-file replace rather than append: a reflective journal needs
 * compaction (drop dead hypotheses, merge confirmations), and append-only
 * markdown just accretes. The size cap forces the curator to curate.
 *
 * A leaf module (node:fs only) so the cap/replace semantics are unit-testable;
 * the path is injected by observer/index.ts at boot.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Hard cap — a journal the curator cannot keep under this is not a journal,
 *  it is a landfill. The write is rejected with a message the curator sees. */
export const JOURNAL_MAX_CHARS = 65_536

let journalPath: string | null = null

export function initJournal(filePath: string): void {
  journalPath = filePath
}

/** Test seam. */
export function resetJournalForTest(): void {
  journalPath = null
}

export interface JournalInfo {
  exists: boolean
  content: string
  updatedAt: number | null
  chars: number
}

export function readJournal(): JournalInfo {
  if (!journalPath || !existsSync(journalPath)) {
    return { exists: false, content: '', updatedAt: null, chars: 0 }
  }
  try {
    const content = readFileSync(journalPath, 'utf-8')
    const updatedAt = statSync(journalPath).mtimeMs
    return { exists: true, content, updatedAt, chars: content.length }
  } catch (err) {
    console.error('[observer] journal read failed:', err)
    return { exists: false, content: '', updatedAt: null, chars: 0 }
  }
}

/** Replace the journal wholesale. Returns an error string (for the curator to
 *  correct itself) rather than throwing. */
export function writeJournal(content: unknown): { ok: true } | { ok: false; error: string } {
  if (!journalPath) return { ok: false, error: 'journal is not initialised' }
  if (typeof content !== 'string') return { ok: false, error: 'content must be a string' }
  if (content.length > JOURNAL_MAX_CHARS) {
    return {
      ok: false,
      error: `journal is capped at ${JOURNAL_MAX_CHARS} characters (got ${content.length}) — compact it: drop dead hypotheses, merge confirmed ones`,
    }
  }
  try {
    mkdirSync(dirname(journalPath), { recursive: true })
    writeFileSync(journalPath, content, 'utf-8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
