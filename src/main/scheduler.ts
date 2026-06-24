import * as scheduleStore from './schedule-store'
import { runScheduledTask } from './hook-server'
import { getSession } from './pty-manager'

// Drives scheduled tasks: a one-shot launch sweep (onLaunch schedules) shortly
// after start, plus a recurring ticker that fires interval/daily schedules when
// due. Firing itself is delegated to hook-server's runScheduledTask — this file
// only decides WHEN to fire and guards against double-firing an in-flight run.
//
// No cycle: hook-server does NOT import scheduler, so importing runScheduledTask
// here is safe.

// Fire onLaunch schedules a few seconds after start, once the window/hook-server
// are settled. One-shot.
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

function isDue(schedule: scheduleStore.ScheduledTask, now: number): boolean {
  const rec = schedule.recurrence
  const lastRunMs = schedule.lastRunAt ? Date.parse(schedule.lastRunAt) : undefined
  switch (rec.kind) {
    case 'interval': {
      const base = lastRunMs ?? schedulerStartedAt
      return now - base >= rec.minutes * 60_000
    }
    case 'daily': {
      const todayHHMM = todayAtMs(new Date(now), rec.hour, rec.minute)
      // Due once we are past today's slot AND we haven't already run since it
      // (no lastRun, or the last run was before today's slot). Natural catch-up:
      // if the app was off at the slot and starts later the same day, this fires.
      return now >= todayHHMM && (lastRunMs === undefined || lastRunMs < todayHHMM)
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
    try {
      fireSchedule(schedule, schedule.recurrence.kind)
    } catch (err) {
      console.error('[scheduler] Failed to fire schedule', schedule.id, err)
    }
  }
}

function launchSweep(): void {
  launchTimer = null
  for (const schedule of scheduleStore.getSchedules()) {
    if (!schedule.enabled || !schedule.onLaunch) continue
    try {
      fireSchedule(schedule, 'onLaunch')
    } catch (err) {
      console.error('[scheduler] Failed to fire schedule', schedule.id, err)
    }
  }
}

/** Start the launch sweep (one-shot) + the recurring due-check ticker. Idempotent. */
export function startScheduler(): void {
  if (tickTimer) return
  schedulerStartedAt = Date.now()
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
