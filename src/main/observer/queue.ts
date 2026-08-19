/**
 * Digest-queue capture points — the ONLY thing the observer records anymore.
 *
 * V1 captured tool uses, prompts, UI actions and session lifecycle into an
 * event log; all of that is gone. V2 notes exactly two facts, both structural:
 * "this session has a transcript at this path" (from the hook payloads Claude
 * Code already sends) and "this session ended". The transcript content itself
 * is only ever read later, by the digest drain, and only while the observer
 * toggle is on.
 *
 * A separate module from observer/index.ts so session-registry can import it
 * without a cycle (index.ts imports session-registry for the idle gate).
 * Imports: db (pure) + settings-store only.
 */

import { isObserverDbReady, markQueueReady, upsertQueueOpen } from './db'
import { loadSettings } from '../settings-store'

/** The opt-in gate — while OFF, nothing is queued at all (design decision:
 *  don't quietly accumulate digestable sessions while disabled). */
export function observerEnabled(): boolean {
  return loadSettings().observerEnabled === true
}

/** A live session reported its transcript path (every hook event carries it).
 *  Cheap upsert; the caller already filtered to observed session kinds. */
export function noteSessionTranscript(opts: {
  sessionId: string
  claudeSessionId: string
  projectPath: string | null
  transcriptPath: string
}): void {
  if (!isObserverDbReady() || !observerEnabled()) return
  try {
    upsertQueueOpen(opts)
  } catch (err) {
    console.error('[observer] queue upsert failed:', err)
  }
}

/** A session ended (any path — ⌘⇧W close, kill, PTY exit, archive teardown).
 *  A no-op for sessions the queue never saw. */
export function noteSessionEnded(sessionId: string): void {
  if (!isObserverDbReady() || !observerEnabled()) return
  try {
    markQueueReady(sessionId)
  } catch (err) {
    console.error('[observer] queue mark-ready failed:', err)
  }
}
