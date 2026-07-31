/**
 * Observer entry point — wiring, not logic.
 *
 * Starts the store, registers the two staleness jobs, and exposes the small
 * surface the IPC layer and the hook server call into. Everything substantive
 * lives in db / capture / mining / curator / apply.
 *
 * Two jobs, both debt-based and idle-gated (see jobs.ts):
 *   - `mining`  — every ~2h of app-open time. Cheap, in-process, no LLM.
 *   - `curator` — every ~24h of app-open time. Spawns one headless Haiku run.
 */

import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  closeObserverDb,
  countEvents,
  countPendingSuggestions,
  getSuggestion,
  initObserverDb,
  insertSuggestion,
  isObserverDbReady,
  listPatterns,
  listSuggestions,
  resolveSuggestion,
  type SuggestionKind,
  type SuggestionRow,
} from './db'
import { hasMiningBacklog, lastMiningRunAt, runMiningPass } from './mining'
import { jobStatuses, registerJob, startJobRunner, stopJobRunner, triggerJobNow, type JobStatus } from './jobs'
import { activeCuratorSessionId, markPatternSuggested, runCurator, setCuratorAttachListeners } from './curator'
import { applySuggestion, defaultProjectPathFrom, feedbackToPattern } from './apply'
import { loadSettings } from '../settings-store'
import type { PtySession } from '../pty-manager'

export { setCuratorAttachListeners }

const MINING_EVERY_HOURS = 2
const CURATOR_EVERY_HOURS = 24

/** Quiet period required before a job may fire. Mining is cheap and invisible
 *  so it needs only a short gap; the curator spawns a real session, so it waits
 *  for a longer, more convincing lull. */
const MINING_QUIET_MS = 60_000
const CURATOR_QUIET_MS = 5 * 60_000

/** Notified whenever the inbox changes, so the renderer badge stays live. */
type ChangeListener = () => void
const listeners = new Set<ChangeListener>()
export function onObserverChanged(cb: ChangeListener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
function notify(): void {
  for (const cb of listeners) {
    try { cb() } catch (err) { console.error('[observer] listener failed:', err) }
  }
}

export function startObserver(): void {
  try {
    initObserverDb(join(app.getPath('userData'), 'observer.db'))
  } catch (err) {
    // A failed store must not take the app down — observation is optional.
    console.error('[observer] failed to initialise; observation disabled:', err)
    return
  }

  registerJob({
    id: 'mining',
    everyHours: MINING_EVERY_HOURS,
    quietMs: MINING_QUIET_MS,
    run: () => {
      // Drain a backlog across a few passes rather than waiting a full
      // interval per BATCH_LIMIT chunk (matters after a long busy stretch).
      for (let i = 0; i < 5; i++) {
        const result = runMiningPass()
        if (result.processed === 0 || !hasMiningBacklog()) break
      }
    },
  })

  registerJob({
    id: 'curator',
    everyHours: CURATOR_EVERY_HOURS,
    quietMs: CURATOR_QUIET_MS,
    run: () => {
      const projectPath = loadSettings().baseProjectsDir || app.getPath('home')
      const result = runCurator({ projectPath })
      if (result.status === 'skipped') console.log('[observer] curator skipped —', result.reason)
    },
  })

  startJobRunner()
}

export function stopObserver(): void {
  stopJobRunner()
  closeObserverDb()
}

// ── Suggestion ingest (called from the hook server's /observer/suggest) ─────

/** Validated ingest of one curator proposal. Returns the stored id, or an
 *  error string when the payload is unusable — the curator sees the error and
 *  can correct itself rather than silently producing nothing. */
export function ingestSuggestion(input: {
  patternId?: string | null
  title?: string
  rationale?: string
  kind?: string
  proposal?: unknown
}): { ok: true; id: string } | { ok: false; error: string } {
  if (!isObserverDbReady()) return { ok: false, error: 'observer store is not available' }

  const VALID: SuggestionKind[] = ['scheduled-task', 'todo', 'skill', 'memory-link', 'todo-cleanup']
  const kind = input.kind as SuggestionKind
  if (!VALID.includes(kind)) {
    return { ok: false, error: `kind must be one of: ${VALID.join(', ')}` }
  }
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) return { ok: false, error: 'title is required' }
  const proposal = input.proposal && typeof input.proposal === 'object'
    ? (input.proposal as Record<string, unknown>)
    : {}

  const id = randomUUID()
  insertSuggestion({
    id,
    patternId: input.patternId?.trim() || null,
    title: title.slice(0, 200),
    rationale: (typeof input.rationale === 'string' ? input.rationale : '').slice(0, 2000),
    kind,
    proposal,
  })
  if (input.patternId) markPatternSuggested(input.patternId)
  notify()
  return { ok: true, id }
}

// ── Inbox actions ───────────────────────────────────────────────────────────

export interface ObserverInbox {
  suggestions: SuggestionRow[]
  pendingCount: number
  /** Panel status line: what the observer is doing and when it next runs. */
  statusLine: string
  jobs: JobStatus[]
  activeSessionId: string | null
  eventCount: number
  patternCount: number
}

function fmtHours(ms: number): string {
  const h = ms / 3_600_000
  if (h >= 1) return `~${Math.round(h)}h`
  return `~${Math.max(1, Math.round(ms / 60_000))}m`
}

export function getInbox(): ObserverInbox {
  if (!isObserverDbReady()) {
    return {
      suggestions: [], pendingCount: 0, jobs: [], activeSessionId: null,
      eventCount: 0, patternCount: 0,
      statusLine: 'Observer is disabled — its store could not be opened.',
    }
  }
  const jobs = jobStatuses()
  const curator = jobs.find((j) => j.id === 'curator')
  const active = activeCuratorSessionId()
  const eventCount = countEvents()
  const patternCount = listPatterns({ limit: 1000 }).length

  const statusLine = active
    ? `Curator is running now — judging patterns and reviewing your notes.`
    : curator
      ? [
          `Watching ${eventCount.toLocaleString()} recorded actions · ${patternCount} candidate pattern${patternCount === 1 ? '' : 's'}.`,
          curator.lastRunAt
            ? `Last curator run ${new Date(curator.lastRunAt).toLocaleString()}.`
            : 'The curator has not run yet.',
          curator.remainingMs > 0
            ? `Next after ${fmtHours(curator.remainingMs)} more app-open time.`
            : curator.blockedBy === 'busy' || curator.blockedBy === 'quiet'
              ? 'Due now — waiting for a quiet moment.'
              : 'Due now.',
          lastMiningRunAt() ? `Mining last ran ${new Date(lastMiningRunAt()).toLocaleTimeString()}.` : '',
        ].filter(Boolean).join(' ')
      : 'Observer starting up.'

  return {
    suggestions: listSuggestions({ limit: 50 }),
    pendingCount: countPendingSuggestions(),
    statusLine,
    jobs,
    activeSessionId: active,
    eventCount,
    patternCount,
  }
}

/** Accept a suggestion: execute the proposal, then record the outcome. A
 *  failed application leaves the suggestion PENDING so the user can retry or
 *  dismiss it, rather than silently swallowing their click. */
export function acceptSuggestion(id: string): { ok: boolean; message: string } {
  const suggestion = getSuggestion(id)
  if (!suggestion) return { ok: false, message: 'Suggestion not found' }
  if (suggestion.status !== 'pending') return { ok: false, message: `Already ${suggestion.status}` }

  const settings = loadSettings()
  const result = applySuggestion(suggestion, {
    defaultProjectPath: defaultProjectPathFrom(settings.baseProjectsDir, null),
    memoriesDir: join(app.getPath('userData'), 'memories'),
  })
  if (result.ok) resolveSuggestion(id, 'accepted', result.message)
  else resolveSuggestion(id, 'pending', result.message)
  notify()
  return result
}

export function dismissSuggestion(id: string, forever: boolean): { ok: boolean; message: string } {
  const suggestion = getSuggestion(id)
  if (!suggestion) return { ok: false, message: 'Suggestion not found' }
  const status = forever ? 'never' : 'dismissed'
  resolveSuggestion(id, status, null)
  feedbackToPattern(suggestion.patternId, status)
  notify()
  return { ok: true, message: forever ? 'Muted — this will not be suggested again' : 'Dismissed' }
}

/** Manual "run now" from the overview panel (bypasses debt + the idle gate). */
export function runObserverJobNow(jobId: string): boolean {
  const ran = triggerJobNow(jobId)
  if (ran) setTimeout(notify, 1500)
  return ran
}

/** Re-export for the app's attach-listeners wiring. */
export type { PtySession }
