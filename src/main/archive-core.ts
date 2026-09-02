/**
 * Pure logic for session archiving — the archivability gates, the process-tree
 * classification, and the queued-message store for archived sessions.
 *
 * Deliberately free of electron/node-pty imports so every gate is unit-testable
 * (session-archiver.ts owns the integration: sweep timer, ps invocation, PTY
 * teardown/resume, broadcasts).
 *
 * Gate order (cheapest first — the caller runs 1/2/4 here, then the ps scan):
 *   1. Not mid-turn: Claude Code's own per-process status (busy/waiting block),
 *      falling back to our hook status when that file is unreadable.
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
 * the harness re-invokes the session later on a timer — no descendant process,
 * no PTY traffic, and nothing on disk that any other gate can see. Flagged on
 * PostToolUse; cleared on the next user prompt.
 *
 * This list is deliberately SHORT, because a sticky flag with no expiry makes a
 * session unarchivable until the user types into it again. Only tools whose
 * pending work is genuinely unobservable belong here. Measured exclusions:
 *  - Agent/Task: a background subagent runs in-process and Claude Code reports
 *    the session as 'busy' for the whole run (measured: idle main loop + running
 *    teammate held 'busy' for 155s, dropping to 'shell' the moment it finished),
 *    so gate 1 already covers it. These fire on most working turns — flagging
 *    them made every exploration turn poison the session permanently.
 *  - Bash with run_in_background: gate 3's process scan sees the shell.
 *  - TaskCreate: the todo-list tool ({subject, description} →
 *    ~/.claude/tasks/<session>/N.json). It never re-invokes anything.
 * Workflow stays until its in-process agents are measured the way Agent's were.
 */
export const WAKEUP_TOOLS: ReadonlySet<string> = new Set([
  'ScheduleWakeup', 'Monitor', 'RemoteTrigger', 'Workflow',
])

export function isWakeupToolUse(toolName: string | undefined): boolean {
  return !!toolName && WAKEUP_TOOLS.has(toolName)
}

export function notePostToolUse(a: SessionActivity, toolName: string | undefined): void {
  if (isWakeupToolUse(toolName)) a.pendingBackgroundWork = true
}

/** Consume the output counter for one sweep window: above-noise output counts
 *  as activity and resets the quiet clock. Call once per sweep, before
 *  evaluateGates. */
export function sweepActivity(a: SessionActivity, config: ArchiveGateConfig, now: number): void {
  if (a.bytesSinceSweep > config.noiseBytesPerSweep) a.lastActiveAt = now
  a.bytesSinceSweep = 0
}

// ── Claude Code's own session state (~/.claude/sessions/<pid>.json) ──────────

/** The status vocabulary Claude Code writes into its per-process state file
 *  (verified against 2.1.220: the validator accepts exactly these four). */
export type ClaudeProcessStatus = 'busy' | 'shell' | 'idle' | 'waiting'

const CLAUDE_PROCESS_STATUSES = new Set(['busy', 'shell', 'idle', 'waiting'])

/**
 * Parse `~/.claude/sessions/<pid>.json` — Claude Code's own liveness record for
 * a running process. Preferred over our hook-derived status because it is
 * maintained by the CLI itself, so it is correct even for a session whose hooks
 * we never saw (restored after an app restart, adopted, etc.).
 *
 * The file is keyed by PID, which the OS recycles, so a caller that knows which
 * conversation it expects passes `expectedClaudeSessionId` and gets null on
 * mismatch rather than another session's status.
 *
 * Returns null whenever the file can't be trusted — callers fall back to the
 * hook status.
 */
export function parseClaudeSessionState(
  json: string,
  expectedClaudeSessionId: string | null,
): ClaudeProcessStatus | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const rec = parsed as Record<string, unknown>
  if (expectedClaudeSessionId && rec.sessionId !== expectedClaudeSessionId) return null
  const status = rec.status
  if (typeof status !== 'string' || !CLAUDE_PROCESS_STATUSES.has(status)) return null
  return status as ClaudeProcessStatus
}

export type GateVerdict = { archivable: true } | { archivable: false; reason: string }

/**
 * Gates 1, 2 and 4. Gate 3 (process scan) is asynchronous and runs in the
 * archiver only for sessions that pass these.
 *
 * `processStatus` is Claude Code's own status for the session when we could read
 * it (see parseClaudeSessionState); null means fall back to the hook status.
 */
export function evaluateGates(
  a: SessionActivity,
  config: ArchiveGateConfig,
  now: number,
  processStatus: ClaudeProcessStatus | null = null,
): GateVerdict {
  // Gate 1. The CLI's own status wins when we have it: it is current even if a
  // hook was missed, and it is the ONLY signal available for a session restored
  // after an app restart, whose hookStatus is stuck at 'unknown' forever.
  //
  // 'shell' passes deliberately. It does not mean "a Bash tool is running" (a
  // session stays 'busy' for the whole of a foreground Bash call); it means a
  // background shell is attached — and the bundled message-bus monitor is a
  // background shell that lives as long as the session, so EVERY app-spawned
  // session reports 'shell' permanently. Treating it as work would block
  // archiving on every session forever. Gate 3's ps scan is what actually tells
  // our monitor apart from a real Bash workload.
  if (processStatus === 'busy' || processStatus === 'waiting') {
    return { archivable: false, reason: `claude process is ${processStatus}` }
  }
  if (processStatus === null && a.hookStatus !== 'idle') {
    return { archivable: false, reason: `hook status is ${a.hookStatus}` }
  }
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
 *  Queued here rather than pre-written to the inbox because the inbox is
 *  truncated when the resumed PTY spawns (pty-manager) — a line appended while
 *  the session is archived would be wiped before its monitor ever saw it. */
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
