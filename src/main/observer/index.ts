/**
 * Observer entry point — wiring, not logic.
 *
 * Starts the store, registers the three staleness jobs, and exposes the small
 * surface the IPC layer and the hook server call into. Everything substantive
 * lives in db / digests / journal / curator / apply.
 *
 * Three jobs, all debt-based and idle-gated (see jobs.ts):
 *   - `digests`      — every ~15min of app-open time. Drains the durable
 *                      digest queue: one Haiku `claude -p` child per ended
 *                      session, no PTY, no graph presence.
 *   - `curator`      — every ~24h. Spawns one headless Sonnet run that reads
 *                      the new digests + its own journal and reflects.
 *   - `housekeeping` — every ~72h. Spawns one headless Haiku run for memory
 *                      wikilinks, stale todos, and note hygiene.
 *
 * THE TOGGLE. The whole observer is opt-in behind `settings.observerEnabled`
 * (default OFF — v2 reads session transcript content, which v1 never did).
 * While disabled: no queue rows are written, no digests are generated, and no
 * runs are scheduled. The store still opens so the inbox renders and past
 * suggestions stay actionable.
 */

import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  closeObserverDb,
  countDigests,
  countPendingSuggestions,
  countQueueByState,
  getSuggestion,
  initObserverDb,
  insertSuggestion,
  isObserverDbReady,
  listSuggestions,
  resolveSuggestion,
  SUGGESTION_KINDS,
  type SuggestionKind,
  type SuggestionRow,
} from './db'
import { observerEnabled } from './queue'
import { catchUpDigestQueue, drainDigestQueue, hasDigestBacklog, setSessionQuietGate } from './digests'
import { initJournal, readJournal } from './journal'
import {
  jobStatuses, registerJob, setIdleGate, startJobRunner, stopJobRunner, triggerJobNow,
  type JobStatus,
} from './jobs'
import { allSessionsIdle, getStatus, msSinceLastActivity } from '../session-registry'
import {
  activeCuratorSessionId,
  endCuratorRun,
  isCuratorSession,
  runCurator,
  runHousekeeping,
  setCuratorAttachListeners,
} from './curator'
import { authorizeSuggestRequest } from './curator-token'
import { applySuggestion, defaultProjectPathFrom } from './apply'
import { loadSettings } from '../settings-store'
import type { PtySession } from '../pty-manager'

export { setCuratorAttachListeners }
// The run boundary, consumed by the hook server: token validation for the
// /observer/* endpoints, and the Stop-hook teardown hand-off.
export { authorizeSuggestRequest, endCuratorRun, isCuratorSession }
export { readJournal, writeJournal } from './journal'
// Queue capture points (separate module so session-registry can import them
// without a cycle).
export { noteSessionTranscript, noteSessionEnded } from './queue'

const DIGESTS_EVERY_HOURS = 0.25
const CURATOR_EVERY_HOURS = 24
const HOUSEKEEPING_EVERY_HOURS = 72

/** Quiet period required before a job may fire. Digest drains are invisible
 *  (child process, no UI) so they need only a short gap; the curator and
 *  housekeeper spawn real sessions, so they wait for a convincing lull. */
const DIGESTS_QUIET_MS = 60_000
const RUN_QUIET_MS = 5 * 60_000

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
  initJournal(join(app.getPath('userData'), 'observer-journal.md'))

  // jobs.ts is kept free of the pty-manager/electron import chain so its debt
  // arithmetic is unit-testable; the real idle gate is injected here. Same for
  // the incremental-digest quiet check.
  setIdleGate({ allSessionsIdle, msSinceLastActivity })
  setSessionQuietGate((id) => getStatus(id) !== 'working')

  // Catch-up: sessions that were live when the app last quit never hit a
  // teardown path, so their queue rows are still 'open'. Flip them now.
  // Unconditional — rows only ever exist from a period when the observer was
  // enabled, and flipping their state generates nothing; the drain itself
  // stays behind the toggle.
  catchUpDigestQueue()

  registerJob({
    id: 'digests',
    everyHours: DIGESTS_EVERY_HOURS,
    quietMs: DIGESTS_QUIET_MS,
    run: async () => {
      if (!observerEnabled()) return false // keep the debt; fires when enabled
      const result = await drainDigestQueue()
      if (result.digested > 0) notify()
      // Always a real run, never a skip — even an empty pass prunes finished
      // queue rows. Reporting a no-op would hold the debt above the interval
      // and re-fire the drain every single tick.
      if (hasDigestBacklog()) {
        // More 'ready' rows than one batch: come back next interval rather
        // than looping here — each drain already serialises its model calls.
        console.log('[observer] digest backlog remains after drain')
      }
      return true
    },
  })

  registerJob({
    id: 'curator',
    everyHours: CURATOR_EVERY_HOURS,
    quietMs: RUN_QUIET_MS,
    run: () => {
      if (!observerEnabled()) return false
      const projectPath = loadSettings().baseProjectsDir || app.getPath('home')
      const result = runCurator({ projectPath })
      if (result.status === 'skipped') {
        console.log('[observer] curator skipped —', result.reason)
        // A skip spawned nothing; zeroing the debt would push the next
        // automatic run out by a full 24h of app-open time for no work.
        return false
      }
      return true
    },
  })

  registerJob({
    id: 'housekeeping',
    everyHours: HOUSEKEEPING_EVERY_HOURS,
    quietMs: RUN_QUIET_MS,
    run: () => {
      if (!observerEnabled()) return false
      const projectPath = loadSettings().baseProjectsDir || app.getPath('home')
      const result = runHousekeeping({ projectPath })
      if (result.status === 'skipped') {
        console.log('[observer] housekeeping skipped —', result.reason)
        return false
      }
      return true
    },
  })

  startJobRunner()
}

export function stopObserver(): void {
  stopJobRunner()
  closeObserverDb()
}

// ── Suggestion ingest (called from the hook server's /observer/suggest) ─────

/** Validated ingest of one observer-run proposal. Returns the stored id, or an
 *  error string when the payload is unusable — the run sees the error and can
 *  correct itself rather than silently producing nothing. */
export function ingestSuggestion(input: {
  title?: string
  rationale?: string
  kind?: string
  proposal?: unknown
}): { ok: true; id: string } | { ok: false; error: string } {
  if (!isObserverDbReady()) return { ok: false, error: 'observer store is not available' }

  const kind = input.kind as SuggestionKind
  if (!SUGGESTION_KINDS.includes(kind)) {
    return { ok: false, error: `kind must be one of: ${SUGGESTION_KINDS.join(', ')}` }
  }
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) return { ok: false, error: 'title is required' }
  const proposal = input.proposal && typeof input.proposal === 'object'
    ? (input.proposal as Record<string, unknown>)
    : {}

  const id = randomUUID()
  insertSuggestion({
    id,
    title: title.slice(0, 200),
    rationale: (typeof input.rationale === 'string' ? input.rationale : '').slice(0, 2000),
    kind,
    proposal,
  })
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
  enabled: boolean
  digestCount: number
  queuedCount: number
  journalUpdatedAt: number | null
}

function fmtHours(ms: number): string {
  const h = ms / 3_600_000
  if (h >= 1) return `~${Math.round(h)}h`
  return `~${Math.max(1, Math.round(ms / 60_000))}m`
}

export function getInbox(): ObserverInbox {
  const enabled = observerEnabled()
  if (!isObserverDbReady()) {
    return {
      suggestions: [], pendingCount: 0, jobs: [], activeSessionId: null,
      enabled, digestCount: 0, queuedCount: 0, journalUpdatedAt: null,
      statusLine: 'Observer is disabled — its store could not be opened.',
    }
  }
  const jobs = jobStatuses()
  const curator = jobs.find((j) => j.id === 'curator')
  const active = activeCuratorSessionId()
  const digestCount = countDigests()
  const queuedCount = countQueueByState('ready')
  const journal = readJournal()

  const statusLine = !enabled
    ? 'Observer is off. Enable it in Settings to digest finished sessions and get curator suggestions.'
    : active
      ? 'An observer run is in flight — reflecting on your recent sessions.'
      : curator
        ? [
            `${digestCount.toLocaleString()} session digest${digestCount === 1 ? '' : 's'}${queuedCount > 0 ? ` · ${queuedCount} awaiting digest` : ''}.`,
            curator.lastRunAt
              ? `Last curator run ${new Date(curator.lastRunAt).toLocaleString()}.`
              : 'The curator has not run yet.',
            curator.remainingMs > 0
              ? `Next after ${fmtHours(curator.remainingMs)} more app-open time.`
              : curator.blockedBy === 'busy' || curator.blockedBy === 'quiet'
                ? 'Due now — waiting for a quiet moment.'
                : 'Due now.',
          ].filter(Boolean).join(' ')
        : 'Observer starting up.'

  return {
    suggestions: listSuggestions({ limit: 50 }),
    pendingCount: countPendingSuggestions(),
    statusLine,
    jobs,
    activeSessionId: active,
    enabled,
    digestCount,
    queuedCount,
    journalUpdatedAt: journal.updatedAt,
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
  // 'never' rows are injected into every future curator prompt as
  // do-not-re-propose context (db.recentlyResolvedTitles) — that, plus the
  // curator's journal, replaces v1's pattern muting.
  resolveSuggestion(id, status, null)
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
