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

const TICK_MS = 60_000

/**
 * The "is the app quiet" gate, injected rather than imported.
 *
 * The real implementation lives in session-registry, which reaches pty-manager
 * and therefore electron. Injecting it keeps this module a leaf that can be
 * unit-tested — debt accrual, the 2× cap and its persistence across a restart
 * are exactly the kind of arithmetic that is worth pinning and impossible to
 * exercise through the app.
 */
export interface IdleGate {
  allSessionsIdle: () => boolean
  msSinceLastActivity: () => number
}

/** Default: nothing is known to be running. Overwritten by startObserver at
 *  boot; the permissive default only ever applies before wiring, where there
 *  are no jobs registered to fire anyway. */
let gate: IdleGate = {
  allSessionsIdle: () => true,
  msSinceLastActivity: () => Number.POSITIVE_INFINITY,
}

export function setIdleGate(next: IdleGate): void {
  gate = next
}

/** Debt never exceeds this multiple of a job's interval. */
const MAX_DEBT_MULTIPLIER = 2

export interface StalenessJob {
  id: string
  /** Roughly how many hours of app-open time between runs. */
  everyHours: number
  /** How long the app must have been quiet before this job may fire. */
  quietMs: number
  /**
   * The work.
   *
   * Return `false` to say the run was a NO-OP — it decided there was nothing
   * to do and did not spawn anything. Debt is then left alone, so the job
   * stays eligible instead of waiting out another full interval for a run that
   * never happened. Anything else (including `undefined`) means the work ran
   * and the debt is cleared.
   *
   * Errors are caught and logged, and clear the debt: a permanently failing
   * job must not spin on every tick.
   */
  run: () => Promise<boolean | void> | boolean | void
}

interface JobState {
  job: StalenessJob
  running: boolean
}

const jobs = new Map<string, JobState>()
let tickTimer: ReturnType<typeof setInterval> | null = null
let lastTickAt = 0

/** Test seam: forget every registered job and stop the timer. */
export function resetJobsForTest(): void {
  jobs.clear()
  stopJobRunner()
  lastTickAt = 0
}

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

/**
 * Add the elapsed app-open time since the previous call to every job's debt.
 *
 * `now` is a parameter so the accrual arithmetic — including the sleep clamp
 * and the 2× cap — can be driven deterministically in tests.
 */
export function accrue(now: number = Date.now()): void {
  if (!isObserverDbReady()) return
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

/**
 * Start a job's run and settle its debt on the result.
 *
 * Debt is cleared AFTER the work reports back, not before it starts: a run
 * that skips (`false`) leaves the debt intact so the job stays eligible.
 * Zeroing up-front meant "Run curator now" on a run that skipped — no
 * promotable patterns, or a full pending queue — silently pushed the next
 * automatic run out by a whole 24h interval of app-open time, for nothing.
 *
 * `state.running` still guards re-entry for the whole duration, so leaving the
 * debt in place cannot cause a second concurrent run.
 */
function startRun(state: JobState): void {
  const { job } = state
  state.running = true
  setMetaNumber(lastRunKey(job.id), Date.now())
  void Promise.resolve()
    .then(() => job.run())
    .then((result) => {
      if (result === false) return    // no-op: keep the debt, stay eligible
      setMetaNumber(debtKey(job.id), 0)
    })
    .catch((err) => {
      // Clear on failure: a permanently failing job must not spin every tick.
      console.error(`[observer] job "${job.id}" failed:`, err)
      setMetaNumber(debtKey(job.id), 0)
    })
    .finally(() => { state.running = false })
}

function tick(): void {
  accrue()
  if (!isObserverDbReady()) return

  const quiet = gate.allSessionsIdle()
  for (const state of jobs.values()) {
    const { job } = state
    if (state.running) continue
    if (getMetaNumber(debtKey(job.id)) < job.everyHours * 3_600_000) continue
    // Idle gate. Both conditions matter: `allSessionsIdle` catches "the user is
    // mid-turn right now", `msSinceLastActivity` catches "they just finished
    // and are about to type again".
    if (!quiet || gate.msSinceLastActivity() < job.quietMs) continue

    startRun(state)
  }
}

/** Fire a job immediately, ignoring debt and the idle gate (manual "run now").
 *  A run that skips still leaves the debt alone — see startRun. */
export function triggerJobNow(id: string): boolean {
  const state = jobs.get(id)
  if (!state || state.running) return false
  startRun(state)
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
  const quiet = gate.allSessionsIdle()
  return [...jobs.values()].map(({ job, running }) => {
    const intervalMs = job.everyHours * 3_600_000
    const debtMs = getMetaNumber(debtKey(job.id))
    const lastRunAt = getMetaNumber(lastRunKey(job.id), 0) || null
    const blockedBy: JobStatus['blockedBy'] =
      running ? null
        : debtMs < intervalMs ? 'debt'
          : !quiet ? 'busy'
            : gate.msSinceLastActivity() < job.quietMs ? 'quiet'
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
