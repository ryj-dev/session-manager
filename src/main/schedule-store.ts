import { app } from 'electron'
import { join, dirname } from 'path'
import { readFileSync, mkdirSync, watch, type FSWatcher } from 'fs'
import { randomUUID } from 'crypto'
import { atomicWriteSync } from './atomic-write'

// Source of truth for the Scheduled Tasks panel.
//
// Lives in the main process so that BOTH the renderer (via IPC) and the
// hook-server/scheduler can read and mutate it. The renderer keeps a mirror,
// refreshed on the 'schedules:changed' broadcast emitted by the IPC handlers
// (the broadcast + the spawn path live in ipc.ts / hook-server — NOT here).
//
// This file is pure persistence: no IPC, no broadcasts, no session spawning.

export type ScheduleRecurrence =
  | { kind: 'none' }
  | { kind: 'interval'; minutes: number } // 60 = hourly
  | { kind: 'daily'; hour: number; minute: number }

export type ScheduleRunStatus = 'working' | 'done' | 'error'

export interface ScheduleRun {
  id: string
  /** App/PTY session id (APP_SESSION_ID). */
  sessionId: string
  /** Claude conversation id for `claude --resume`; null until known. */
  claudeSessionId: string | null
  /** ISO 8601 timestamp. */
  startedAt: string
  /** ISO 8601; absent while the run is in-flight. */
  finishedAt?: string
  status: ScheduleRunStatus
}

export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  projectPath: string
  /** Optional --allowedTools restriction; undefined = unrestricted. */
  allowedTools?: string[]
  /** Default true → run spawned with --permission-mode auto. */
  autoApprove: boolean
  /** Fire once at app launch. */
  onLaunch: boolean
  recurrence: ScheduleRecurrence
  enabled: boolean
  /** ISO 8601. */
  createdAt: string
  /** ISO 8601; last time any run started. */
  lastRunAt?: string
  /** Run history, capped to the most-recent RUN_HISTORY_LIMIT in recordRunStarted. */
  runs: ScheduleRun[]
}

interface ScheduleData {
  schedules: ScheduledTask[]
}

const RUN_HISTORY_LIMIT = 25

// Fast-read cache. It is ONLY trusted for reads (getSchedules/getSchedule) and is
// invalidated whenever schedules.json changes on disk (watcher below). All MUTATORS
// deliberately ignore it and read the CURRENT on-disk state instead — see
// updateSchedules — so a stale in-memory snapshot can never clobber a schedule that
// another writer (the scheduler tick, an IPC handler, the completion handler) added.
let cache: ScheduledTask[] | null = null
let watcher: FSWatcher | null = null

function storePath(): string {
  const dir = join(app.getPath('userData'), 'state')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'schedules.json')
}

/** Parse the current on-disk schedule list. Never throws (missing/corrupt → []). */
function readSchedulesFromDisk(): ScheduledTask[] {
  try {
    const parsed: ScheduleData = JSON.parse(readFileSync(storePath(), 'utf-8'))
    return parsed.schedules || []
  } catch {
    return []
  }
}

/** Watch schedules.json so any write (out-of-process, or from a prior app
 *  instance) drops our cache — the next read re-reads disk truth rather than
 *  serving (and later persisting) a stale snapshot. Best-effort. */
function ensureWatcher(): void {
  if (watcher) return
  try {
    watcher = watch(dirname(storePath()), { recursive: false }, (_event, filename) => {
      if (!filename || filename === 'schedules.json') cache = null
    })
    watcher.unref?.()
  } catch { /* watch is optional — mutators still read fresh from disk */ }
}

export function loadSchedules(): ScheduledTask[] {
  ensureWatcher()
  if (cache) return cache
  cache = readSchedulesFromDisk()
  return cache
}

function persist(schedules: ScheduledTask[]): ScheduledTask[] {
  cache = schedules
  atomicWriteSync(storePath(), JSON.stringify({ schedules }, null, 2))
  return schedules
}

/** Atomic read-modify-write keyed off the CURRENT on-disk state. This is the
 *  single write path for every mutator: it re-reads disk (never the cache) so a
 *  concurrent or stale writer can't silently drop another schedule on persist. */
function updateSchedules(fn: (schedules: ScheduledTask[]) => ScheduledTask[]): ScheduledTask[] {
  ensureWatcher()
  return persist(fn(readSchedulesFromDisk()))
}

// ── Reads ────────────────────────────────────────────────────────────────────

export function getSchedules(): ScheduledTask[] {
  return loadSchedules()
}

export function getSchedule(id: string): ScheduledTask | undefined {
  return loadSchedules().find((s) => s.id === id)
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

/** Create a schedule. Generates `id` + `createdAt`, starts with an empty run
 *  history. Returns the created task (the IPC handler can call getSchedules()
 *  for the broadcast). */
export function createSchedule(
  data: Omit<ScheduledTask, 'id' | 'createdAt' | 'runs' | 'lastRunAt'>,
): ScheduledTask {
  const task: ScheduledTask = {
    ...data,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    runs: [],
  }
  updateSchedules((all) => [...all, task])
  return task
}

/** Partial update. Server-managed fields (id/createdAt/runs) are not patchable. */
export function updateSchedule(
  id: string,
  patch: Partial<Omit<ScheduledTask, 'id' | 'createdAt' | 'runs'>>,
): ScheduledTask[] {
  return updateSchedules((all) => all.map((s) => (s.id === id ? { ...s, ...patch } : s)))
}

export function deleteSchedule(id: string): ScheduledTask[] {
  return updateSchedules((all) => all.filter((s) => s.id !== id))
}

export function setScheduleEnabled(id: string, enabled: boolean): ScheduledTask[] {
  return updateSchedules((all) => all.map((s) => (s.id === id ? { ...s, enabled } : s)))
}

// ── Run recording ────────────────────────────────────────────────────────────

/** Append a started run, stamp `lastRunAt`, and prune to the most-recent
 *  RUN_HISTORY_LIMIT runs (runs are appended chronologically, so slice the tail). */
export function recordRunStarted(taskId: string, run: ScheduleRun): ScheduledTask[] {
  return updateSchedules((all) =>
    all.map((s) => {
      if (s.id !== taskId) return s
      const runs = [...s.runs, run].slice(-RUN_HISTORY_LIMIT)
      return { ...s, runs, lastRunAt: run.startedAt }
    }),
  )
}

/** Update one run's status + finishedAt in place (no pruning). When
 *  claudeSessionId is provided it is refreshed too (e.g. the Stop hook persists
 *  the possibly /resume-updated id so the run stays resumable). */
export function recordRunFinished(
  taskId: string,
  runId: string,
  status: ScheduleRunStatus,
  finishedAt: string,
  claudeSessionId?: string | null,
): ScheduledTask[] {
  return updateSchedules((all) =>
    all.map((s) => {
      if (s.id !== taskId) return s
      return {
        ...s,
        runs: s.runs.map((r) =>
          r.id === runId
            ? {
                ...r,
                status,
                finishedAt,
                ...(claudeSessionId !== undefined ? { claudeSessionId } : {}),
              }
            : r,
        ),
      }
    }),
  )
}

// ── Cross-task lookups (for spawn/teardown + restore paths) ─────────────────────

/** Find the run (and its enclosing schedule id) for a given app/PTY session id.
 *  Used by hook-server's Stop branch to map a finished PTY back to its run so it
 *  can call recordRunFinished. Cache-backed read. */
export function getScheduleRunBySessionId(
  sessionId: string,
): { scheduleId: string; run: ScheduleRun } | undefined {
  for (const s of loadSchedules()) {
    const run = s.runs.find((r) => r.sessionId === sessionId)
    if (run) return { scheduleId: s.id, run }
  }
  return undefined
}

/** All non-null Claude conversation ids referenced by any scheduled run. Used to
 *  exclude scheduled sessions from the generic saved-sessions restore prompt. */
export function getScheduleClaudeSessionIds(): Set<string> {
  const ids = new Set<string>()
  for (const s of loadSchedules()) {
    for (const r of s.runs) if (r.claudeSessionId) ids.add(r.claudeSessionId)
  }
  return ids
}
