/**
 * Staleness recurrence — debt-based, idle-gated background jobs.
 *
 * The existing scheduler (src/main/scheduler.ts) thinks in wall-clock: "daily
 * at 09:00", "every 60 minutes". That is the wrong model here. This app is not
 * left running overnight, so a cron-shaped observer job would either never fire
 * or fire in a burst the moment the app opens, right when the user is trying to
 * work.
 *
 * Instead each job declares "run roughly every N hours OF APP-OPEN TIME" and
 * accrues *debt* only while the app is actually running. A job fires when all
 * three hold:
 *   1. debt ≥ its interval,
 *   2. every live session is settled (nothing working, nothing blocked on a
 *      permission prompt),
 *   3. that quiet has held for `quietMs` — so we don't jump into a two-second
 *      gap between the user's turns.
 * Debt is persisted, so closing the laptop mid-afternoon and reopening it the
 * next morning resumes with the debt already owed rather than restarting the
 * clock — but the debt does not GROW while the app is closed, which is exactly
 * the "no cron thinking" property we want.
 *
 * Debt is capped at 2× the interval so a long absence can't queue a stampede.
 */

import { getMetaNumber, setMetaNumber, isObserverDbReady } from './db'
import { allSessionsIdle, msSinceLastActivity } from '../session-registry'

const TICK_MS = 60_000

/** Debt never exceeds this multiple of a job's interval. */
const MAX_DEBT_MULTIPLIER = 2

export interface StalenessJob {
  id: string
  /** Roughly how many hours of app-open time between runs. */
  everyHours: number
  /** How long the app must have been quiet before this job may fire. */
  quietMs: number
  /** The work. Errors are caught and logged; debt is still reset so a
   *  permanently failing job can't spin every tick. */
  run: () => Promise<void> | void
}

interface JobState {
  job: StalenessJob
  running: boolean
}

const jobs = new Map<string, JobState>()
let tickTimer: ReturnType<typeof setInterval> | null = null
let lastTickAt = 0

const debtKey = (id: string): string => `job.${id}.debtMs`
const lastRunKey = (id: string): string => `job.${id}.lastRunAt`

export function registerJob(job: StalenessJob): void {
  jobs.set(job.id, { job, running: false })
}

export function startJobRunner(): void {
  if (tickTimer) return
  lastTickAt = Date.now()
  tickTimer = setInterval(tick, TICK_MS)
  tickTimer.unref?.()
  console.log('[observer] job runner started:', [...jobs.keys()].join(', ') || '(none)')
}

export function stopJobRunner(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  // Flush the final slice of debt so a quit mid-interval isn't free.
  accrue()
}

/** Add the elapsed app-open time since the previous tick to every job's debt. */
function accrue(): void {
  if (!isObserverDbReady()) return
  const now = Date.now()
  const elapsed = Math.max(0, now - lastTickAt)
  lastTickAt = now
  // A machine that slept shows a huge elapsed — that time was NOT app-open in
  // any meaningful sense, so clamp a single tick's contribution to ~2 ticks.
  const credited = Math.min(elapsed, TICK_MS * 2)
  for (const { job } of jobs.values()) {
    const cap = job.everyHours * 3_600_000 * MAX_DEBT_MULTIPLIER
    setMetaNumber(debtKey(job.id), Math.min(cap, getMetaNumber(debtKey(job.id)) + credited))
  }
}

function tick(): void {
  accrue()
  if (!isObserverDbReady()) return

  const quiet = allSessionsIdle()
  for (const state of jobs.values()) {
    const { job } = state
    if (state.running) continue
    if (getMetaNumber(debtKey(job.id)) < job.everyHours * 3_600_000) continue
    // Idle gate. Both conditions matter: `allSessionsIdle` catches "the user is
    // mid-turn right now", `msSinceLastActivity` catches "they just finished
    // and are about to type again".
    if (!quiet || msSinceLastActivity() < job.quietMs) continue

    state.running = true
    setMetaNumber(debtKey(job.id), 0)
    setMetaNumber(lastRunKey(job.id), Date.now())
    void Promise.resolve()
      .then(() => job.run())
      .catch((err) => console.error(`[observer] job "${job.id}" failed:`, err))
      .finally(() => { state.running = false })
  }
}

/** Fire a job immediately, ignoring debt and the idle gate (manual "run now"). */
export function triggerJobNow(id: string): boolean {
  const state = jobs.get(id)
  if (!state || state.running) return false
  state.running = true
  setMetaNumber(debtKey(id), 0)
  setMetaNumber(lastRunKey(id), Date.now())
  void Promise.resolve()
    .then(() => state.job.run())
    .catch((err) => console.error(`[observer] manual job "${id}" failed:`, err))
    .finally(() => { state.running = false })
  return true
}

export interface JobStatus {
  id: string
  everyHours: number
  running: boolean
  lastRunAt: number | null
  /** ms of app-open time accrued toward the next run. */
  debtMs: number
  /** ms of app-open time still owed before the job is eligible. */
  remainingMs: number
  /** Why the job is not running right now, or null when it is eligible. */
  blockedBy: 'debt' | 'busy' | 'quiet' | null
}

export function jobStatuses(): JobStatus[] {
  const quiet = allSessionsIdle()
  return [...jobs.values()].map(({ job, running }) => {
    const intervalMs = job.everyHours * 3_600_000
    const debtMs = getMetaNumber(debtKey(job.id))
    const lastRunAt = getMetaNumber(lastRunKey(job.id), 0) || null
    const blockedBy: JobStatus['blockedBy'] =
      running ? null
        : debtMs < intervalMs ? 'debt'
          : !quiet ? 'busy'
            : msSinceLastActivity() < job.quietMs ? 'quiet'
              : null
    return {
      id: job.id,
      everyHours: job.everyHours,
      running,
      lastRunAt,
      debtMs,
      remainingMs: Math.max(0, intervalMs - debtMs),
      blockedBy,
    }
  })
}
