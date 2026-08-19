/**
 * Pure logic for session archiving — the archivability gates, the process-tree
 * classification, and the queued-message store for archived sessions.
 *
 * Deliberately free of electron/node-pty imports so every gate is unit-testable
 * (session-archiver.ts owns the integration: sweep timer, ps invocation, PTY
 * teardown/resume, broadcasts).
 *
 * Gate order (cheapest first — the caller runs 1/2/4 here, then the ps scan):
 *   1. Hook status must be 'idle' (mid-turn / permission-wait never archives).
 *   2. Quiet for the threshold: no PTY input, no 'working' hook events, and
 *      near-zero PTY output (byte-per-sweep noise floor absorbs title/statusline
 *      redraw chatter; real output — a dev server, a background task's logs —
 *      resets the clock).
 *   3. Process-tree scan (classifyDescendants below).
 *   4. No pending background work (turn-ending wakeup tools seen in PostToolUse,
 *      cleared on the next user prompt).
 * A pinned or currently-visible session never archives. When a signal is
 * ambiguous, block — a false "active" only delays archiving.
 */

// ── Gate state ───────────────────────────────────────────────────────────────

export type ArchiveHookStatus = 'unknown' | 'working' | 'idle' | 'permission'

export interface SessionActivity {
  /** Last moment the session was observably active (input / working hook /
   *  above-noise output). The quiet clock counts from here. */
  lastActiveAt: number
  hookStatus: ArchiveHookStatus
  /** PTY output bytes accumulated since the last sweep consumed them. */
  bytesSinceSweep: number
  /** A turn-ending wakeup tool ran — the runtime will re-invoke this session
   *  with no visible process or PTY traffic. Cleared on the next user prompt. */
  pendingBackgroundWork: boolean
}

export interface ArchiveGateConfig {
  /** Required quiet time before a session is archivable. */
  thresholdMs: number
  /** Output bytes per sweep tolerated while idle (cursor/title/statusline noise). */
  noiseBytesPerSweep: number
}

export const DEFAULT_NOISE_BYTES_PER_SWEEP = 2048

export function createActivity(now: number): SessionActivity {
  return { lastActiveAt: now, hookStatus: 'unknown', bytesSinceSweep: 0, pendingBackgroundWork: false }
}

export function noteInput(a: SessionActivity, now: number): void {
  a.lastActiveAt = now
}

export function noteOutput(a: SessionActivity, bytes: number): void {
  a.bytesSinceSweep += bytes
}

export function noteHookStatus(a: SessionActivity, status: ArchiveHookStatus, now: number): void {
  a.hookStatus = status
  // 'working' marks real activity; 'idle'/'permission' are states, not activity
  // — the quiet clock keeps counting from the last working moment.
  if (status === 'working') a.lastActiveAt = now
}

export function noteUserPrompt(a: SessionActivity, now: number): void {
  a.pendingBackgroundWork = false
  a.lastActiveAt = now
}

/**
 * Turn-ending wakeup tools: the turn ends (Stop fires, session reads idle) but
 * the harness re-invokes the session later — no descendant process, no PTY
 * traffic, nothing the other gates can see. Flag on PostToolUse; cleared on the
 * next user prompt.
 *
 * Agent/Task default to background (run_in_background !== false blocks);
 * Bash only blocks when explicitly backgrounded (foreground Bash is covered by
 * the working status + the process scan).
 */
export const WAKEUP_TOOLS: ReadonlySet<string> = new Set([
  'ScheduleWakeup', 'Monitor', 'RemoteTrigger', 'Workflow', 'TaskCreate',
])

export function isWakeupToolUse(toolName: string | undefined, toolInput: unknown): boolean {
  if (!toolName) return false
  if (WAKEUP_TOOLS.has(toolName)) return true
  const bg = (toolInput as { run_in_background?: unknown } | null | undefined)?.run_in_background
  if (toolName === 'Agent' || toolName === 'Task') return bg !== false
  if (toolName === 'Bash') return bg === true
  return false
}

export function notePostToolUse(a: SessionActivity, toolName: string | undefined, toolInput: unknown): void {
  if (isWakeupToolUse(toolName, toolInput)) a.pendingBackgroundWork = true
}

/** Consume the output counter for one sweep window: above-noise output counts
 *  as activity and resets the quiet clock. Call once per sweep, before
 *  evaluateGates. */
export function sweepActivity(a: SessionActivity, config: ArchiveGateConfig, now: number): void {
  if (a.bytesSinceSweep > config.noiseBytesPerSweep) a.lastActiveAt = now
  a.bytesSinceSweep = 0
}

export type GateVerdict = { archivable: true } | { archivable: false; reason: string }

/** Gates 1, 2 and 4. Gate 3 (process scan) is asynchronous and runs in the
 *  archiver only for sessions that pass these. */
export function evaluateGates(a: SessionActivity, config: ArchiveGateConfig, now: number): GateVerdict {
  if (a.hookStatus !== 'idle') return { archivable: false, reason: `hook status is ${a.hookStatus}` }
  if (a.pendingBackgroundWork) return { archivable: false, reason: 'pending background work (wakeup tool)' }
  const quietMs = now - a.lastActiveAt
  if (quietMs < config.thresholdMs) return { archivable: false, reason: `only quiet for ${quietMs}ms` }
  return { archivable: true }
}

// ── Gate 3: process-tree classification ──────────────────────────────────────

export interface ProcInfo {
  pid: number
  ppid: number
  command: string
}

/** Parse `ps -axo pid=,ppid=,command=` output. Malformed lines are dropped. */
export function parsePsOutput(text: string): ProcInfo[] {
  const procs: ProcInfo[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] })
  }
  return procs
}

const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh'])

/** Marker every Claude Code Bash-tool wrapper (foreground and run_in_background)
 *  carries in its argv. More precise than "is a shell": MCP servers spawn
 *  transient `sh -c git …` internally, which must NOT block archiving. */
export const SHELL_SNAPSHOT_MARKER = '.claude/shell-snapshots/'

function isShellCommand(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const base = first.split('/').pop() ?? ''
  return SHELL_NAMES.has(base)
}

/**
 * Classify the PTY's descendants: return the argv of every process that BLOCKS
 * archiving. Rule (design-approved):
 *  - A direct child whose argv contains `messages/<sid>/inbox.txt` is the
 *    app's message-bus monitor (zsh wrapper + its `tail -f`) — allowlisted,
 *    whole subtree skipped.
 *  - A direct child carrying the shell-snapshots marker, or that is a plain
 *    shell, is Claude's Bash-tool wrapper (run_in_background task, dev server,
 *    user long-runner) — it and its whole subtree block.
 *  - Any other direct child (stdio MCP servers, chrome-native-host, …) is
 *    session plumbing that lives exactly as long as the claude process itself:
 *    ignored, subtree included (MCP-internal shells must not block).
 */
export function findBlockingDescendants(
  procs: ProcInfo[],
  rootPid: number,
  appSessionId: string,
): string[] {
  const children = new Map<number, ProcInfo[]>()
  for (const p of procs) {
    const list = children.get(p.ppid)
    if (list) list.push(p)
    else children.set(p.ppid, [p])
  }

  const inboxMarker = `messages/${appSessionId}/inbox.txt`
  const blockers: string[] = []

  const collectSubtree = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      blockers.push(child.command)
      collectSubtree(child.pid)
    }
  }

  for (const child of children.get(rootPid) ?? []) {
    if (child.command.includes(inboxMarker)) continue // message-bus monitor
    if (child.command.includes(SHELL_SNAPSHOT_MARKER) || isShellCommand(child.command)) {
      blockers.push(child.command)
      collectSubtree(child.pid)
    }
    // Non-shell direct children (MCP servers etc.) and their subtrees: ignored.
  }
  return blockers
}

// ── Messages queued for archived / waking sessions ───────────────────────────

export interface QueuedArchivedMessage {
  fromSessionId: string | null
  message: string
  queuedAt: number
}

/** Server-side queue for messages sent to an archived (or still-waking) session.
 *  Queued here rather than pre-written to the inbox because the inbox is wiped
 *  on PTY exit and a fresh `tail -f` starts at EOF anyway — lines appended
 *  before the resumed monitor is running would be silently lost. */
export class ArchivedMessageQueue {
  private queues = new Map<string, QueuedArchivedMessage[]>()

  enqueue(sessionId: string, message: string, fromSessionId: string | null, now: number): void {
    const list = this.queues.get(sessionId) ?? []
    list.push({ fromSessionId, message, queuedAt: now })
    this.queues.set(sessionId, list)
  }

  /** Return all queued messages in arrival order and clear the queue. */
  drain(sessionId: string): QueuedArchivedMessage[] {
    const list = this.queues.get(sessionId) ?? []
    this.queues.delete(sessionId)
    return list
  }

  size(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0
  }

  forget(sessionId: string): void {
    this.queues.delete(sessionId)
  }
}
