import * as scheduleStore from './schedule-store'
import { runScheduledTask } from './hook-server'
import { getSession } from './pty-manager'

// Drives scheduled tasks: a one-shot launch sweep (launch-triggered schedules)
// shortly after start, plus a recurring ticker that fires interval/daily
// schedules when due. Firing itself is delegated to hook-server's
// runScheduledTask — this file only decides WHEN to fire and guards against
// double-firing an in-flight run or exceeding a schedule's daily cap.
//
// No cycle: hook-server does NOT import scheduler, so importing runScheduledTask
// here is safe.

// Fire launch-triggered schedules a few seconds after start, once the
// window/hook-server are settled. One-shot.
const LAUNCH_SWEEP_DELAY_MS = 4_000
// Recurring due-check cadence. 30s is fine — minute-granularity daily + minute
// interval schedules tolerate up to a 30s firing skew.
const TICK_INTERVAL_MS = 30_000

let tickTimer: ReturnType<typeof setInterval> | null = null
let launchTimer: ReturnType<typeof setTimeout> | null = null
/** Reference point for interval schedules that have never run (lastRunAt undefined). */
let schedulerStartedAt = 0

/** A schedule has an in-flight run when one of its runs has no finishedAt AND its
 *  PTY session is still alive. (The Stop hook stamps finishedAt + tears the PTY
 *  down, so a crashed/zombie run with no finishedAt but a dead PTY is NOT treated
 *  as in-flight — it won't permanently block future fires.) */
function hasInflightRun(schedule: scheduleStore.ScheduledTask): boolean {
  return schedule.runs.some((r) => !r.finishedAt && getSession(r.sessionId) !== undefined)
}

/** Epoch ms for local midnight at the start of `now`'s day. */
function startOfDayMs(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** How many of this schedule's NON-errored runs started on `now`'s calendar day.
 *  Errored runs (e.g. a logged-out failure) are excluded so they don't consume
 *  the day's quota — the schedule stays eligible to retry once the user logs in. */
function runsStartedToday(schedule: scheduleStore.ScheduledTask, now: number): number {
  const start = startOfDayMs(now)
  return schedule.runs.filter((r) => r.status !== 'error' && Date.parse(r.startedAt) >= start).length
}

/** A `firstOfDay` launch has already happened (or any run has) today. */
function hasRunToday(schedule: scheduleStore.ScheduledTask, now: number): boolean {
  return runsStartedToday(schedule, now) > 0
}

/** True when the per-day trigger cap is set and already reached for today.
 *  Applies to automatic triggers only — Run-now deliberately bypasses it. */
function hasReachedDailyCap(schedule: scheduleStore.ScheduledTask, now: number): boolean {
  const cap = schedule.maxRunsPerDay
  return cap !== undefined && cap > 0 && runsStartedToday(schedule, now) >= cap
}

/** Fire a schedule unless it already has a live run. Returns the new session id,
 *  or null if skipped. Centralises the in-flight guard + logging. */
function fireSchedule(schedule: scheduleStore.ScheduledTask, reason: string): string | null {
  if (hasInflightRun(schedule)) {
    console.log(`[scheduler] skip "${schedule.name}" (${reason}) — run already in flight`)
    return null
  }
  console.log(`[scheduler] firing "${schedule.name}" (${reason})`)
  return runScheduledTask(schedule)
}

/** Today's HH:MM (from a daily recurrence) as epoch ms in local time. */
function todayAtMs(now: Date, hour: number, minute: number): number {
  const d = new Date(now)
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

/** Start time (epoch ms) of the most recent run that did NOT error, or undefined.
 *  Used by the daily check so a slot that failed (e.g. logged out) can retry the
 *  same day instead of being blocked by the failed run's timestamp. */
function lastNonErrorRunMs(schedule: scheduleStore.ScheduledTask): number | undefined {
  let last: number | undefined
  for (const r of schedule.runs) {
    if (r.status === 'error') continue
    const t = Date.parse(r.startedAt)
    if (!Number.isNaN(t) && (last === undefined || t > last)) last = t
  }
  return last
}

function isDue(schedule: scheduleStore.ScheduledTask, now: number): boolean {
  const rec = schedule.recurrence
  const lastRunMs = schedule.lastRunAt ? Date.parse(schedule.lastRunAt) : undefined
  switch (rec.kind) {
    case 'interval': {
      // Errored runs still push lastRunAt forward — that's the desired spacing
      // (don't hammer): a failed interval run retries on the next interval tick.
      const base = lastRunMs ?? schedulerStartedAt
      return now - base >= rec.minutes * 60_000
    }
    case 'daily': {
      const todayHHMM = todayAtMs(new Date(now), rec.hour, rec.minute)
      // Due once we are past today's slot AND we haven't successfully run since it
      // (no non-error run, or the last one was before today's slot). Errored runs
      // are ignored so a failed slot can retry the same day. Natural catch-up: if
      // the app was off at the slot and starts later the same day, this fires.
      const lastOkMs = lastNonErrorRunMs(schedule)
      return now >= todayHHMM && (lastOkMs === undefined || lastOkMs < todayHHMM)
    }
    case 'none':
      return false
  }
}

function tick(): void {
  const now = Date.now()
  for (const schedule of scheduleStore.getSchedules()) {
    if (!schedule.enabled) continue
    if (!isDue(schedule, now)) continue
    if (hasReachedDailyCap(schedule, now)) {
      console.log(`[scheduler] skip "${schedule.name}" (${schedule.recurrence.kind}) — daily cap of ${schedule.maxRunsPerDay} reached`)
      continue
    }
    try {
      fireSchedule(schedule, schedule.recurrence.kind)
    } catch (err) {
      console.error('[scheduler] Failed to fire schedule', schedule.id, err)
    }
  }
}

function launchSweep(): void {
  launchTimer = null
  const now = Date.now()
  for (const schedule of scheduleStore.getSchedules()) {
    if (!schedule.enabled || schedule.launch === 'off') continue
    // First-launch-of-the-day: skip if this schedule has already run today
    // (covers a second launch the same day, including after an app restart).
    if (schedule.launch === 'firstOfDay' && hasRunToday(schedule, now)) continue
    if (hasReachedDailyCap(schedule, now)) {
      console.log(`[scheduler] skip "${schedule.name}" (launch) — daily cap of ${schedule.maxRunsPerDay} reached`)
      continue
    }
    try {
      fireSchedule(schedule, schedule.launch === 'firstOfDay' ? 'first-launch-of-day' : 'launch')
    } catch (err) {
      console.error('[scheduler] Failed to fire schedule', schedule.id, err)
    }
  }
}

/** Clear runs left 'working' by a previous app session. On a fresh start no PTY
 *  from a prior process survives, so any run with no finishedAt and a dead PTY is
 *  an orphan — mark it errored ('interrupted') so it stops showing "working"
 *  forever AND (since errored runs don't count as "ran today") the launch sweep
 *  can re-fire its schedule. Run once, BEFORE the launch sweep. */
function reconcileOrphanedRuns(): void {
  const finishedAt = new Date().toISOString()
  for (const schedule of scheduleStore.getSchedules()) {
    for (const run of schedule.runs) {
      if (run.finishedAt || run.status !== 'working') continue
      if (getSession(run.sessionId) !== undefined) continue // genuinely live — leave it
      if (scheduleStore.markRunErrored(schedule.id, run.id, finishedAt, 'Interrupted — app restarted.')) {
        console.log(`[scheduler] reconciled orphaned run ${run.id} of "${schedule.name}"`)
      }
    }
  }
}

/** Start the launch sweep (one-shot) + the recurring due-check ticker. Idempotent. */
export function startScheduler(): void {
  if (tickTimer) return
  schedulerStartedAt = Date.now()
  reconcileOrphanedRuns()
  launchTimer = setTimeout(launchSweep, LAUNCH_SWEEP_DELAY_MS)
  launchTimer.unref?.()
  tickTimer = setInterval(tick, TICK_INTERVAL_MS)
  tickTimer.unref?.()
  console.log('[scheduler] started')
}

/** Fire a schedule immediately (Run-now button). Respects the in-flight guard so
 *  a schedule can't have two concurrent runs. Returns the new session id or null. */
export function triggerScheduleNow(id: string): string | null {
  const schedule = scheduleStore.getSchedule(id)
  if (!schedule) {
    console.warn(`[scheduler] triggerScheduleNow: no schedule ${id}`)
    return null
  }
  return fireSchedule(schedule, 'run-now')
}

export function stopScheduler(): void {
  if (launchTimer) {
    clearTimeout(launchTimer)
    launchTimer = null
  }
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  console.log('[scheduler] stopped')
}
