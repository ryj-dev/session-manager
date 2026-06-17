import { app } from 'electron'
import { join, dirname } from 'path'
import { readFileSync, mkdirSync, watch, type FSWatcher } from 'fs'
import { atomicWriteSync } from './atomic-write'

// Source of truth for the agentic pipeline (Cmd+L) board state.
//
// Lives in the main process so that BOTH the renderer (via IPC) and the
// orchestrator/worker Claude sessions (via the MCP server → hook-server bridge)
// can read and mutate it. The renderer keeps a mirror, refreshed on the
// 'pipeline:changed' broadcast emitted by the IPC handlers in ipc.ts.

export type PipelineStage = 'plan' | 'implement' | 'review' | 'done'
export type AutonomyLevel = 'manual' | 'gated' | 'auto'
export type PipelineRole = 'orchestrator' | 'plan' | 'implement' | 'review'
export type PipelineSessionStatus = 'working' | 'idle' | 'permission' | 'done' | 'queued'
export type PipelineTone = 'pass' | 'fail' | 'warn' | 'active' | 'neutral'
export type PipelineKind = 'info' | 'plan-ready' | 'fanout' | 'review-verdict' | 'blocked' | 'done' | 'error'

/** One entry in a session's curated milestone feed. Legacy on-disk entries may
 *  be bare strings; loadPipeline() migrates those to `{ text }`. */
export interface FeedEntry {
  text: string
  kind?: PipelineKind
  tone?: PipelineTone
  ts?: number
}

/** A node in a task's session tree — orchestrator, a stage run, or a fan-out
 *  child. Populated by real orchestration; undefined until sessions exist. */
export interface PipelineSession {
  /** App session id (the PTY/app id). Stable within a run; matches APP_SESSION_ID. */
  id: string
  label: string
  role: PipelineRole
  status: PipelineSessionStatus
  badge?: string
  tone?: PipelineTone
  /** Curated milestone feed (persisted). The raw transcript lives on disk via Claude Code. */
  log: FeedEntry[]
  children?: PipelineSession[]
  fanoutKind?: string
  /** Stable Claude conversation id for best-effort live resume (`claude --resume`). */
  claudeSessionId?: string | null
  /** Working directory the session ran in (for resume). */
  cwd?: string
  /** For worktree fan-out workers: the branch they built on. */
  worktreeBranch?: string
  /** Filesystem path of the worker's isolated worktree (for merge/cleanup). */
  worktreePath?: string
  /** Set once the worktree has been merged + removed → node is read-only (Option B). */
  worktreeRemoved?: boolean
}

export interface PipelineTask {
  /** Equals the backing todo id. */
  id: string
  title: string
  tags: string[]
  /** Full todo body (the user's detailed intent) — passed to the orchestrator. */
  body?: string
  stage: PipelineStage
  autonomy: AutonomyLevel
  reviewRound?: number
  gate?: { label: string; detail: string } | null
  orchestrator?: PipelineSession
  createdAt: number
  /** When the task entered Done (ms). Drives the completed-recency filter. */
  completedAt?: number
  /** Project directory the orchestrator + stage sessions run in. */
  projectPath?: string
  /** Per-task isolation: the integration repo root (the MAIN repo). */
  repoRoot?: string
  /** Per-task isolation: the task's own worktree path (where the orchestrator
   *  + all its stage sessions run, so concurrent tasks don't collide). */
  worktreePath?: string
  /** Per-task isolation: the task's branch (merged → integration at Done). */
  worktreeBranch?: string
  /** Integration state of the per-task branch into the integration branch.
   *  'merged' = cleanly integrated (the only honest path into Done);
   *  'conflict' = the merge failed, the worktree is KEPT and the card is held
   *  out of Done; 'pending' = a worktree exists but hasn't been integrated yet.
   *  Undefined for non-isolated tasks (no branch to merge). */
  integrationStatus?: 'pending' | 'merged' | 'conflict'
  /** Files that conflicted on the last failed integration (for the card badge). */
  conflictFiles?: string[]
}

const STAGE_ORDER: PipelineStage[] = ['plan', 'implement', 'review', 'done']

interface PipelineData {
  tasks: PipelineTask[]
}

// Fast-read cache. It is ONLY trusted for reads (getPipelineTasks/getPipelineTask)
// and is invalidated whenever pipeline.json changes on disk (watcher below). All
// MUTATORS deliberately ignore it and read the CURRENT on-disk state instead —
// see updateTasks — so a stale in-memory snapshot can never clobber a task that
// another writer (a concurrent task path, or a prior app instance) added.
let cache: PipelineTask[] | null = null
let watcher: FSWatcher | null = null

function storePath(): string {
  const dir = join(app.getPath('userData'), 'state')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'pipeline.json')
}

/** Coerce legacy string log entries → FeedEntry across a session subtree. */
function migrateFeed(node?: PipelineSession): void {
  if (!node) return
  if (Array.isArray(node.log)) {
    node.log = node.log.map((e) => (typeof e === 'string' ? { text: e } : e)) as FeedEntry[]
  }
  node.children?.forEach(migrateFeed)
}

/** Parse the current on-disk task list, migrating legacy entries. Never throws. */
function readTasksFromDisk(): PipelineTask[] {
  try {
    const parsed: PipelineData = JSON.parse(readFileSync(storePath(), 'utf-8'))
    const tasks = parsed.tasks || []
    tasks.forEach((t) => migrateFeed(t.orchestrator))
    return tasks
  } catch {
    return []
  }
}

/** Watch pipeline.json so any write (out-of-process, or from a prior app
 *  instance) drops our cache — the next read re-reads disk truth rather than
 *  serving (and later persisting) a stale snapshot. Best-effort. */
function ensureWatcher(): void {
  if (watcher) return
  try {
    watcher = watch(dirname(storePath()), { recursive: false }, (_event, filename) => {
      if (!filename || filename === 'pipeline.json') cache = null
    })
    watcher.unref?.()
  } catch { /* watch is optional — mutators still read fresh from disk */ }
}

export function loadPipeline(): PipelineTask[] {
  ensureWatcher()
  if (cache) return cache
  cache = readTasksFromDisk()
  return cache
}

function persist(tasks: PipelineTask[]): PipelineTask[] {
  cache = tasks
  atomicWriteSync(storePath(), JSON.stringify({ tasks }, null, 2))
  return tasks
}

/** Atomic read-modify-write keyed off the CURRENT on-disk state. This is the
 *  single write path for every mutator: it re-reads disk (never the cache) so a
 *  concurrent or stale writer can't silently drop another task on persist. */
function updateTasks(fn: (tasks: PipelineTask[]) => PipelineTask[]): PipelineTask[] {
  ensureWatcher()
  return persist(fn(readTasksFromDisk()))
}

export function getPipelineTasks(): PipelineTask[] {
  return loadPipeline()
}

export function getPipelineTask(id: string): PipelineTask | null {
  return loadPipeline().find((t) => t.id === id) ?? null
}

/** Fresh disk-truth existence check (bypasses the cache). Used to detect a task
 *  that has been dropped from the board so callers can signal it instead of
 *  silently no-opping. */
export function hasPipelineTask(id: string): boolean {
  return readTasksFromDisk().some((t) => t.id === id)
}

/** Move a todo into the pipeline at the Plan stage. No-op if already present. */
export function startPipelineTask(
  todo: { id: string; title: string; tags: string[]; body?: string },
  defaultAutonomy: AutonomyLevel,
  projectPath?: string,
): PipelineTask[] {
  return updateTasks((tasks) =>
    tasks.some((t) => t.id === todo.id)
      ? tasks
      : [
          ...tasks,
          {
            id: todo.id,
            title: todo.title,
            tags: todo.tags,
            body: todo.body,
            stage: 'plan',
            autonomy: defaultAutonomy,
            createdAt: Date.now(),
            projectPath,
          },
        ],
  )
}

/** Record the per-task worktree (set once when the orchestrator is spawned). */
export function setTaskWorktree(
  id: string,
  info: { repoRoot: string; worktreePath: string; worktreeBranch: string },
): PipelineTask[] {
  return updateTasks((tasks) => tasks.map((t) => (t.id === id ? { ...t, ...info } : t)))
}

export function setPipelineStage(id: string, stage: PipelineStage): PipelineTask[] {
  return updateTasks((tasks) =>
    tasks.map((t) =>
      t.id === id ? { ...t, stage, completedAt: stage === 'done' ? Date.now() : undefined } : t,
    ),
  )
}

/** Record the result of attempting to integrate the per-task branch. Clearing
 *  to 'merged' or 'pending' also drops any stale conflict file list. */
export function setIntegrationStatus(
  id: string,
  status: 'pending' | 'merged' | 'conflict',
  conflictFiles?: string[],
): PipelineTask[] {
  return updateTasks((tasks) =>
    tasks.map((t) =>
      t.id === id
        ? { ...t, integrationStatus: status, conflictFiles: status === 'conflict' ? conflictFiles : undefined }
        : t,
    ),
  )
}

export function setPipelineAutonomy(id: string, level: AutonomyLevel): PipelineTask[] {
  return updateTasks((tasks) => tasks.map((t) => (t.id === id ? { ...t, autonomy: level } : t)))
}

/** Resolve a pending gate: approve advances to the next stage; reject clears it. */
export function resolvePipelineGate(id: string, approve: boolean): PipelineTask[] {
  return updateTasks((tasks) =>
    tasks.map((t) => {
      if (t.id !== id) return t
      if (!approve) return { ...t, gate: null }
      const idx = STAGE_ORDER.indexOf(t.stage)
      const next = STAGE_ORDER[Math.min(idx + 1, STAGE_ORDER.length - 1)]
      return { ...t, gate: null, stage: next, completedAt: next === 'done' ? Date.now() : undefined }
    }),
  )
}

export function removePipelineTask(id: string): PipelineTask[] {
  return updateTasks((tasks) => tasks.filter((t) => t.id !== id))
}

export function clearPipeline(): void {
  persist([])
}

/** All Claude conversation ids referenced by any pipeline task tree. Used to
 *  exclude pipeline sessions from the generic saved-sessions restore prompt. */
export function getPipelineClaudeSessionIds(): Set<string> {
  const ids = new Set<string>()
  const walk = (n?: PipelineSession): void => {
    if (!n) return
    if (n.claudeSessionId) ids.add(n.claudeSessionId)
    n.children?.forEach(walk)
  }
  loadPipeline().forEach((t) => walk(t.orchestrator))
  return ids
}

/** All app session (node) ids in one task's tree — for teardown. */
export function getPipelineSessionIds(taskId: string): string[] {
  const ids: string[] = []
  const walk = (n?: PipelineSession): void => {
    if (!n) return
    ids.push(n.id)
    n.children?.forEach(walk)
  }
  walk(getPipelineTask(taskId)?.orchestrator)
  return ids
}

/** Live worktree-backed nodes in a task's tree (have a worktreePath and haven't
 *  been merged/removed yet). Used to clean up crashed/abandoned workers when a
 *  task is completed or removed. */
export function getWorktreeNodes(taskId: string): PipelineSession[] {
  const out: PipelineSession[] = []
  const walk = (n?: PipelineSession): void => {
    if (!n) return
    if (n.worktreePath && !n.worktreeRemoved) out.push(n)
    n.children?.forEach(walk)
  }
  walk(getPipelineTask(taskId)?.orchestrator)
  return out
}

// ── Orchestration mutators (driven by sessions via the hook-server bridge) ──

/** Recursive lookup of a node by app session id within a task's tree. */
function findNode(root: PipelineSession | undefined, id: string): PipelineSession | undefined {
  if (!root) return undefined
  if (root.id === id) return root
  for (const c of root.children ?? []) {
    const found = findNode(c, id)
    if (found) return found
  }
  return undefined
}

/** Apply an in-place mutation to one task (cloned for immutability), then persist.
 *  Reads disk-fresh (via updateTasks) so it never clobbers a concurrently-added
 *  task. Returns whether the target task existed — callers surface "unknown task"
 *  rather than silently no-opping (which previously masked a dropped task). */
function mutateTask(taskId: string, fn: (task: PipelineTask) => void): { tasks: PipelineTask[]; found: boolean } {
  let found = false
  const tasks = updateTasks((current) =>
    current.map((t) => {
      if (t.id !== taskId) return t
      found = true
      const clone: PipelineTask = JSON.parse(JSON.stringify(t))
      fn(clone)
      return clone
    }),
  )
  return { tasks, found }
}

export interface SessionUpsert {
  id: string
  role: PipelineRole
  label: string
  status?: PipelineSessionStatus
  badge?: string
  tone?: PipelineTone
  fanoutKind?: string
  claudeSessionId?: string | null
  cwd?: string
  worktreeBranch?: string
  worktreePath?: string
}

/** Insert or update a node in a task's session tree. The first node registered
 *  (typically the orchestrator) becomes the root; others attach under
 *  `parentSessionId` (falling back to the root). */
export function upsertPipelineSession(taskId: string, node: SessionUpsert, parentSessionId?: string): PipelineTask[] {
  return mutateTask(taskId, (task) => {
    const existing = findNode(task.orchestrator, node.id)
    if (existing) {
      Object.assign(existing, node)
      return
    }
    const created: PipelineSession = { log: [], status: 'working', ...node }
    if (!task.orchestrator) {
      task.orchestrator = created
      return
    }
    const parent = parentSessionId ? findNode(task.orchestrator, parentSessionId) : undefined
    const target = parent ?? task.orchestrator
    target.children = [...(target.children ?? []), created]
  }).tasks
}

export interface MilestonePatch {
  text?: string
  kind?: PipelineKind
  status?: PipelineSessionStatus
  badge?: string
  tone?: PipelineTone
  fanoutKind?: string
  role?: PipelineRole
  label?: string
  parentSessionId?: string
}

/** Append a milestone to a session's feed and/or update its status fields.
 *  Upserts a minimal node if the session hasn't been registered yet. Returns
 *  `found: false` when the task no longer exists on the board (a dropped task) —
 *  callers MUST surface this instead of reporting a successful no-op, which is
 *  what previously masked a task silently vanishing mid-run. */
export function emitMilestone(taskId: string, sessionId: string, patch: MilestonePatch): { tasks: PipelineTask[]; found: boolean } {
  return mutateTask(taskId, (task) => {
    let node = findNode(task.orchestrator, sessionId)
    if (!node) {
      node = { id: sessionId, role: patch.role ?? 'plan', label: patch.label ?? sessionId, status: patch.status ?? 'working', log: [] }
      if (!task.orchestrator) {
        task.orchestrator = node
      } else {
        const parent = patch.parentSessionId ? findNode(task.orchestrator, patch.parentSessionId) : undefined
        const target = parent ?? task.orchestrator
        target.children = [...(target.children ?? []), node]
      }
    }
    if (patch.text) node.log.push({ text: patch.text, kind: patch.kind, tone: patch.tone, ts: Date.now() })
    if (patch.status) node.status = patch.status
    if (patch.badge !== undefined) node.badge = patch.badge
    if (patch.tone) node.tone = patch.tone
    if (patch.fanoutKind) node.fanoutKind = patch.fanoutKind
    if (patch.label) node.label = patch.label
  })
}

/** Request approval at a gate. Under `auto` autonomy, auto-advances to the next
 *  stage and reports it. Otherwise sets a pending gate for the user to resolve. */
export function requestApproval(taskId: string, gate: string, detail: string): {
  decision: 'auto-approved' | 'pending' | 'unknown-task'
  stage?: PipelineStage
} {
  const task = getPipelineTask(taskId)
  if (!task) return { decision: 'unknown-task' }
  if (task.autonomy === 'auto') {
    const idx = STAGE_ORDER.indexOf(task.stage)
    const next = STAGE_ORDER[Math.min(idx + 1, STAGE_ORDER.length - 1)]
    setPipelineStage(taskId, next)
    return { decision: 'auto-approved', stage: next }
  }
  mutateTask(taskId, (t) => { t.gate = { label: gate, detail } })
  return { decision: 'pending' }
}

/** Rename a session node (the orchestrator naming its children for the board). */
export function renamePipelineSession(taskId: string, sessionId: string, label: string): PipelineTask[] {
  return mutateTask(taskId, (task) => {
    const node = findNode(task.orchestrator, sessionId)
    if (node) node.label = label
  }).tasks
}

/** Mark a worktree worker's tree node as merged + removed (read-only, Option B). */
export function markWorktreeRemoved(taskId: string, sessionId: string): PipelineTask[] {
  return mutateTask(taskId, (task) => {
    const node = findNode(task.orchestrator, sessionId)
    if (node) node.worktreeRemoved = true
  }).tasks
}
