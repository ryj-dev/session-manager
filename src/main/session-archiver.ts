/**
 * Session archiving — tear down an inactive session's PTY (freeing a live
 * `claude` process + a renderer WebGL context) while keeping its graph node,
 * last snapshot and claudeSessionId. Clicking the node — or a message arriving
 * for it — silently resumes the conversation via `claude --resume` under the
 * SAME app session id, so the node, inbox path, hook channels and parent/child
 * message routes all survive. Scheduled-task teardown-but-resumable is the
 * in-codebase precedent.
 *
 * Gate logic lives in archive-core.ts (pure, unit-tested); this module owns the
 * sweep timer, the ps(1) scan, PTY teardown/resume, the waking flush, and the
 * renderer broadcasts ('session:archived' / 'session:waking' / 'session:woke').
 *
 * Import discipline: pty-manager + session-registry + settings-store only.
 * hook-server imports THIS module (never the reverse) and injects its message
 * deliverer via configureArchiver; ipc.ts injects the PTY listener attacher.
 */

import { BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import {
  spawnSession,
  getSession,
  getAllSessions,
  killSession,
} from './pty-manager'
import { loadSettings } from './settings-store'
import * as registry from './session-registry'
import {
  ArchivedMessageQueue,
  createActivity,
  evaluateGates,
  findBlockingDescendants,
  noteHookStatus,
  noteInput,
  noteOutput,
  notePostToolUse,
  noteUserPrompt,
  parsePsOutput,
  sweepActivity,
  DEFAULT_NOISE_BYTES_PER_SWEEP,
  type SessionActivity,
} from './archive-core'

export interface ArchivedSessionRecord {
  id: string
  claudeSessionId: string
  projectPath: string
  terminalTitle: string | null
  archivedAt: number
}

const ARCHIVE_SWEEP_MS = 30_000
/** Minimum allowed inactivity threshold (guards against a mistyped setting). */
const MIN_THRESHOLD_MINUTES = 5
/** Flush queued messages this long after resume even if no readiness signal
 *  arrived (hooks disabled, prompt text changed). The plugin's inbox monitor
 *  starts with the session, well inside this window. */
const WAKE_FLUSH_FALLBACK_MS = 15_000
/** Claude Code's "? for shortcuts" status bar — the prompt is on-screen. */
const PROMPT_READY_MARKER = 'forshortcuts'

/** Session kinds eligible for archiving — graph sessions only. Pipeline,
 *  scheduled, observer and preview sessions have their own lifecycles. */
const ARCHIVABLE_KINDS = new Set(['user', 'agent'])

const activity = new Map<string, SessionActivity>()
const archived = new Map<string, ArchivedSessionRecord>()
const waking = new Map<string, { resumedAt: number; fallbackTimer: ReturnType<typeof setTimeout>; outputTail: string }>()
const queue = new ArchivedMessageQueue()
const pinnedSessions = new Set<string>()
/** Sessions currently on screen (focused view / active split) — never archived
 *  out from under the user. Pushed by the renderer via archive:setVisible. */
let visibleSessions = new Set<string>()

let sweepTimer: ReturnType<typeof setInterval> | null = null
let sweepInFlight = false

// ── Injected dependencies (avoid import cycles) ──────────────────────────────

type AttachListenersFn = (id: string, session: ReturnType<typeof spawnSession>) => void
let attachListenersFn: AttachListenersFn | null = null

export function setArchiverAttachListeners(fn: AttachListenersFn): void {
  attachListenersFn = fn
}

type DeliverFn = (
  targetSessionId: string,
  message: string,
  fromSessionId: string | null,
) => { ok: true } | { ok: false; error: string; status: number }
let deliverFn: DeliverFn | null = null

/** Called by hook-server at startup: the queue flush delivers through the same
 *  inbox-append path as every other inter-session message. */
export function configureArchiver(opts: { deliver: DeliverFn }): void {
  deliverFn = opts.deliver
}

function broadcast(channel: string, payload: unknown): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// ── Activity notes (pushed from ipc.ts / hook-server.ts) ─────────────────────

function activityFor(id: string): SessionActivity {
  let a = activity.get(id)
  if (!a) {
    a = createActivity(Date.now())
    activity.set(id, a)
  }
  return a
}

/** User keystrokes / queued writes into the PTY. */
export function noteSessionInput(id: string): void {
  if (getSession(id)) noteInput(activityFor(id), Date.now())
}

/** PTY output. Also scans waking sessions for the prompt-ready marker so the
 *  queued-message flush can fire as soon as the resumed TUI is interactive. */
export function noteSessionOutput(id: string, data: string): void {
  const w = waking.get(id)
  if (w) {
    const clean = (w.outputTail + data).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\s+/g, '')
    if (clean.includes(PROMPT_READY_MARKER)) {
      flushWakingSession(id)
    } else {
      w.outputTail = clean.slice(-64) // survive marker split across chunks
    }
  }
  if (getSession(id)) noteOutput(activityFor(id), data.length)
}

export function noteSessionHookStatus(id: string, status: 'working' | 'idle' | 'permission'): void {
  noteHookStatus(activityFor(id), status, Date.now())
}

export function noteSessionPostToolUse(id: string, toolName: string | undefined, toolInput: unknown): void {
  notePostToolUse(activityFor(id), toolName, toolInput)
}

export function noteSessionUserPrompt(id: string): void {
  noteUserPrompt(activityFor(id), Date.now())
}

/** Any hook traffic from this session — for a waking session this proves the
 *  resumed process (and its plugin monitors) is up, so flush the queue. */
export function noteSessionHookEvent(id: string): void {
  if (waking.has(id)) flushWakingSession(id)
}

// ── State queries ────────────────────────────────────────────────────────────

export function isArchived(id: string): boolean {
  return archived.has(id)
}

export function isWaking(id: string): boolean {
  return waking.has(id)
}

export function getArchivedRecord(id: string): ArchivedSessionRecord | undefined {
  return archived.get(id)
}

export function listArchivedSessions(): ArchivedSessionRecord[] {
  return [...archived.values()]
}

export function setSessionPinned(id: string, pinned: boolean): boolean {
  if (pinned) pinnedSessions.add(id)
  else pinnedSessions.delete(id)
  return pinnedSessions.has(id)
}

export function isSessionPinned(id: string): boolean {
  return pinnedSessions.has(id)
}

export function setVisibleSessions(ids: string[]): void {
  visibleSessions = new Set(ids)
}

/** Drop ALL archiver state for a session — call on real teardown (user close,
 *  pipeline/registry kill, app cleanup). Wired into hook-server's cleanupSession
 *  so every existing kill path forgets automatically. */
export function forgetSession(id: string): void {
  activity.delete(id)
  archived.delete(id)
  pinnedSessions.delete(id)
  queue.forget(id)
  const w = waking.get(id)
  if (w) {
    clearTimeout(w.fallbackTimer)
    waking.delete(id)
  }
}

// ── The sweep ────────────────────────────────────────────────────────────────

export function startArchiveSweep(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => { void runArchiveSweep() }, ARCHIVE_SWEEP_MS)
  sweepTimer.unref?.()
}

export function stopArchiveSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

function thresholdMsFromSettings(): number {
  const minutes = Math.max(MIN_THRESHOLD_MINUTES, loadSettings().archiveInactiveMinutes ?? 30)
  return minutes * 60_000
}

function isEligible(id: string): boolean {
  const s = getSession(id)
  if (!s) return false
  // Same bar as persistence: a claude session with real user activity, not an
  // ephemeral drawer preview. Pipeline/scheduled/observer sessions excluded.
  if (s.command !== 'claude' || !s.claudeSessionId || !s.hasActivity || s.ephemeral) return false
  const kind = registry.getOrigin(id)?.kind
  if (kind !== undefined && !ARCHIVABLE_KINDS.has(kind)) return false
  if (pinnedSessions.has(id) || visibleSessions.has(id)) return false
  return true
}

async function runArchiveSweep(): Promise<void> {
  if (sweepInFlight) return
  sweepInFlight = true
  try {
    const settings = loadSettings()
    const config = {
      thresholdMs: thresholdMsFromSettings(),
      noiseBytesPerSweep: DEFAULT_NOISE_BYTES_PER_SWEEP,
    }
    const now = Date.now()

    // Track + evaluate the cheap gates for every eligible live session (the
    // output counter must be consumed every sweep even when archiving is off,
    // or the first sweep after enabling would see hours of accumulated bytes).
    const candidates: string[] = []
    for (const s of getAllSessions()) {
      if (s.command !== 'claude' || waking.has(s.id)) continue
      const a = activityFor(s.id)
      sweepActivity(a, config, now)
      if (!settings.archiveInactiveSessions) continue
      if (!isEligible(s.id)) continue
      if (evaluateGates(a, config, now).archivable) candidates.push(s.id)
    }
    if (candidates.length === 0) return

    // Gate 3: one ps(1) scan for all candidates. No ps (Windows) or a failed
    // scan is ambiguous → block this sweep entirely.
    if (process.platform === 'win32') return
    const procs = parsePsOutput(await listProcesses())
    for (const id of candidates) {
      const session = getSession(id)
      const pid = session?.process.pid
      if (!session || !pid) continue
      const blockers = findBlockingDescendants(procs, pid, id)
      if (blockers.length > 0) {
        console.log(`[archiver] ${id} not archived — live descendants:`, blockers.map((b) => b.slice(0, 80)))
        continue
      }
      archiveSession(id)
    }
  } catch (err) {
    console.error('[archiver] sweep failed:', err)
  } finally {
    sweepInFlight = false
  }
}

function listProcesses(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

// ── Archive / resume ─────────────────────────────────────────────────────────

/** Tear down the PTY, keep the node. Exported for the sweep + tests/manual use. */
export function archiveSession(id: string): boolean {
  const session = getSession(id)
  if (!session?.claudeSessionId) return false
  archived.set(id, {
    id,
    claudeSessionId: session.claudeSessionId,
    projectPath: session.projectPath,
    terminalTitle: session.terminalTitle,
    archivedAt: Date.now(),
  })
  // Renderer learns FIRST so the later pty:exit (delayed 200ms in the attach
  // listener) is recognised as an archive, not a real exit.
  broadcast('session:archived', { id })
  try {
    killSession(id)
  } catch (err) {
    console.error('[archiver] kill failed for', id, err)
  }
  // Live-session bookkeeping only — hook-server's per-session maps are left
  // alone on purpose (transcript path etc. are reused when the SAME id resumes).
  registry.forget(id)
  activity.delete(id)
  console.log(`[archiver] archived session ${id} (claude ${archived.get(id)?.claudeSessionId})`)
  return true
}

export type ResumeResult =
  | { ok: true; alreadyLive?: boolean }
  | { ok: false; error: string }

/** Resume an archived session under its ORIGINAL app session id, so the graph
 *  node, terminal channels, inbox path and message routes all reconnect. */
export function resumeArchivedSession(id: string, trigger: 'user' | 'message'): ResumeResult {
  if (getSession(id)) return { ok: true, alreadyLive: true }
  const rec = archived.get(id)
  if (!rec) return { ok: false, error: `Session ${id} is not archived` }

  archived.delete(id)
  broadcast('session:waking', { id })

  const autoMode = loadSettings().autoModeForRestoredSessions
  const resumeArgs = ['--resume', rec.claudeSessionId]
  const args = autoMode ? ['--permission-mode', 'auto', ...resumeArgs] : resumeArgs
  let session: ReturnType<typeof spawnSession>
  try {
    session = spawnSession(id, rec.projectPath, 'claude', args)
  } catch (err) {
    // Put the record back so the node stays resumable-looking; the renderer is
    // told it's archived again rather than stuck on 'waking'.
    archived.set(id, rec)
    broadcast('session:archived', { id })
    console.error('[archiver] resume spawn failed for', id, err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  // The conversation had real user activity before archiving; carrying these
  // over keeps the persistence gate + writeWhenReady behaviour intact.
  session.hasActivity = true
  if (rec.terminalTitle) session.terminalTitle = rec.terminalTitle

  attachListenersFn?.(id, session)
  registry.setOrigin(id, { kind: 'user' })
  activity.set(id, createActivity(Date.now()))

  waking.set(id, {
    resumedAt: Date.now(),
    outputTail: '',
    fallbackTimer: setTimeout(() => flushWakingSession(id), WAKE_FLUSH_FALLBACK_MS),
  })
  console.log(`[archiver] resuming session ${id} (claude ${rec.claudeSessionId}, trigger: ${trigger})`)
  return { ok: true }
}

/** Queue a message for an archived/waking session; an archived target is woken.
 *  The queue drains into the normal inbox delivery path once the resumed
 *  session is ready (first hook event or prompt-ready output, else fallback). */
export function queueMessageForArchived(
  targetSessionId: string,
  message: string,
  fromSessionId: string | null,
): { ok: true } | { ok: false; error: string; status: number } {
  queue.enqueue(targetSessionId, message, fromSessionId, Date.now())
  if (archived.has(targetSessionId)) {
    const result = resumeArchivedSession(targetSessionId, 'message')
    if (!result.ok) {
      queue.forget(targetSessionId)
      return { ok: false, error: `Archived session could not be resumed: ${result.error}`, status: 500 }
    }
  }
  return { ok: true }
}

function flushWakingSession(id: string): void {
  const w = waking.get(id)
  if (!w) return
  clearTimeout(w.fallbackTimer)
  waking.delete(id)
  broadcast('session:woke', { id })
  const messages = queue.drain(id)
  if (messages.length === 0 || !deliverFn) return
  for (const m of messages) {
    const result = deliverFn(id, m.message, m.fromSessionId)
    if (!result.ok) console.error(`[archiver] queued-message flush to ${id} failed: ${result.error}`)
  }
  console.log(`[archiver] flushed ${messages.length} queued message(s) to resumed session ${id}`)
}

/** Archived sessions merged into the on-quit save (they have no live PTY, so
 *  pty-manager's getResumableSessions can't see them). */
export function getArchivedResumable(): Array<{
  id: string
  projectPath: string
  claudeSessionId: string
  terminalTitle: string | null
}> {
  return listArchivedSessions().map((r) => ({
    id: r.id,
    projectPath: r.projectPath,
    claudeSessionId: r.claudeSessionId,
    terminalTitle: r.terminalTitle,
  }))
}
