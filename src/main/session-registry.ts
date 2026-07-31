/**
 * Unified live-session registry.
 *
 * Every PTY the app owns is spawned through pty-manager, but WHO owns it was
 * previously scattered: the renderer store knew about graph sessions, the
 * pipeline store knew about orchestrators/workers, schedule-store knew about
 * runs, and nothing joined them. This module is the single place that answers
 * "everything alive right now, tagged by what owns it".
 *
 * Design constraints:
 *  - It imports only pty-manager (the PTY table) and the observer's capture
 *    funnel (a leaf module). Everything else pushes into it — hook-server
 *    writes origins + status, ipc.ts writes origins for user-initiated spawns.
 *    That keeps it free of the hook-server/pipeline/schedule import cycle.
 *  - It is derived state: pty-manager is the source of truth for liveness. An
 *    origin whose PTY is gone is reported as a 'zombie' once and then pruned,
 *    so a leaked origin can never masquerade as a live session.
 *  - It is in-memory only. Sessions do not survive a process restart, so
 *    neither should the registry; the pipeline/schedule stores own the durable
 *    records that outlive a run.
 */

import { getAllSessions, getSession, type PtySession } from './pty-manager'
import { recordSessionLifecycle } from './observer/capture'

/** What kind of thing owns a live session. */
export type SessionKind =
  /** A Claude session the user spawned (Cmd+T) — lives on the graph. */
  | 'user'
  /** A raw shell (Cmd+Shift+T, or a paired/attached terminal). */
  | 'terminal'
  /** A one-shot run of a scheduled task (Cmd+J). */
  | 'scheduled'
  /** An agentic-pipeline orchestrator or worker (Cmd+L). */
  | 'pipeline'
  /** A session spawned from the agent gallery or the spawn-agent MCP tool. */
  | 'agent'
  /** A headless background run owned by the observer/curator. */
  | 'observer'
  /**
   * A throwaway PTY a panel spawned to SHOW an existing conversation — the
   * pipeline drawer's terminal, the ⌘J run-history preview. The renderer owns
   * it and kills it when the drawer closes.
   *
   * Deliberately not 'user': these are not sessions the user started, they are
   * a rendering of one that already happened. Tagging them 'user' put them in
   * the graph-sessions list of the ⌘P overview (a list the graph itself does
   * not contain), and fed a spawn/end pair per drawer-open into the observer's
   * event log, where they read as real session activity and skewed mining.
   */
  | 'preview'

export type RegistryStatus = 'working' | 'idle' | 'permission' | 'zombie' | 'unknown'

/** Origin metadata attached to a live session at spawn time. */
export interface SessionOrigin {
  kind: SessionKind
  /** scheduled: the schedule this run belongs to. */
  scheduleId?: string
  /** scheduled: denormalised schedule name (schedules can be renamed/deleted). */
  scheduleName?: string
  /** scheduled: the run id inside the schedule's history. */
  scheduleRunId?: string
  /** pipeline: the owning task. */
  pipelineTaskId?: string
  /** pipeline: the node's role in the task tree. */
  pipelineRole?: string
  /** pipeline: the node's board label. */
  pipelineLabel?: string
  /** agent: which agent definition was installed for this session. */
  agentName?: string
  /** observer: which background job spawned it (e.g. 'curator'). */
  observerJob?: string
  /** App session id of the spawner, when one is known. */
  parentSessionId?: string
  /** Human label preferred over the terminal title when present. */
  label?: string
}

/** A live session joined with its origin and current hook status. */
export interface RegistryEntry {
  id: string
  origin: SessionOrigin
  projectPath: string
  projectName: string
  claudeSessionId: string | null
  terminalTitle: string | null
  /** Origin label → terminal title → project name. Never empty. */
  displayName: string
  status: RegistryStatus
  /** ms epoch the PTY was spawned. */
  startedAt: number
  /** ms since spawn. */
  uptimeMs: number
  /** True for drawer/preview PTYs the renderer owns and reaps. */
  ephemeral: boolean
  /** 'claude' | 'shell' | resolved binary. */
  command: string
}

const origins = new Map<string, SessionOrigin>()
const statuses = new Map<string, RegistryStatus>()

/**
 * Session kinds the observer does NOT record activity for.
 *
 * 'preview' — a drawer re-rendering an old conversation is not the user doing
 * something; counting it would make "opened the pipeline drawer" look like a
 * daily session habit.
 *
 * 'observer' — the curator's own run. Its reads (list-memories, read-todo,
 * search-wiki, the Grep/Read it does to check evidence) went into the same log
 * it is judging, so it observed itself: a perfectly regular once-a-day
 * "habit", by construction present on every day the curator ran, feeding its
 * own mining a pattern only it produces. The observer is not a user.
 */
const UNOBSERVED_KINDS: ReadonlySet<SessionKind> = new Set<SessionKind>(['preview', 'observer'])

/** True when this session's activity belongs in the observer's event log.
 *  Untagged sessions are observed — the default has to be "record it", or a
 *  future spawn path that forgets to tag itself would go silently unmined. */
export function shouldObserveSession(id: string): boolean {
  const kind = origins.get(id)?.kind
  return kind === undefined || !UNOBSERVED_KINDS.has(kind)
}

/** Listeners notified whenever the registry's observable content changes. */
type ChangeListener = () => void
const listeners = new Set<ChangeListener>()

export function onRegistryChanged(cb: ChangeListener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Coalesce bursts (a spawn writes origin + status back-to-back). */
let notifyTimer: ReturnType<typeof setTimeout> | null = null
function notify(): void {
  if (notifyTimer) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    for (const cb of listeners) {
      try { cb() } catch (err) { console.error('[registry] listener failed:', err) }
    }
  }, 120)
  notifyTimer.unref?.()
}

/** Tag a session with its origin. Called on EVERY spawn path. Merges into any
 *  existing origin so a later, more specific tag (e.g. the pipeline role,
 *  applied after the generic spawn) refines rather than replaces. */
export function setOrigin(id: string, origin: SessionOrigin): void {
  const prev = origins.get(id)
  origins.set(id, prev ? { ...prev, ...origin } : origin)
  // The registry is the one choke point every spawn path already goes through,
  // so it is also where the observer learns a session began. Only the FIRST
  // tag emits — later calls refine an existing origin, they aren't new sessions
  // — and only for kinds whose activity is the user's own (see UNOBSERVED_KINDS).
  if (!prev && !UNOBSERVED_KINDS.has(origin.kind)) {
    recordSessionLifecycle({
      sessionId: id,
      projectPath: getSession(id)?.projectPath ?? null,
      action: 'spawn',
      sessionKind: origin.kind,
      parentSessionId: origin.parentSessionId ?? null,
      agentName: origin.agentName ?? null,
    })
  }
  notify()
}

export function getOrigin(id: string): SessionOrigin | undefined {
  return origins.get(id)
}

/** Re-key an origin when a session is resumed onto a fresh PTY id (the pipeline
 *  orchestrator resume path does this). No-op if the old id is untracked. */
export function rekeyOrigin(oldId: string, newId: string): void {
  const origin = origins.get(oldId)
  if (!origin) return
  origins.delete(oldId)
  statuses.delete(oldId)
  origins.set(newId, origin)
  notify()
}

/** Record the latest hook-derived status for a session. */
export function setStatus(id: string, status: RegistryStatus): void {
  if (statuses.get(id) === status) return
  statuses.set(id, status)
  notify()
}

/** Drop all registry state for a session (call alongside PTY teardown). */
export function forget(id: string): void {
  const origin = origins.get(id)
  origins.delete(id)
  statuses.delete(id)
  if (!origin) return
  // Close the pair in the event log — but only for the kinds whose 'spawn' we
  // recorded in the first place, or the log accumulates unmatched ends.
  if (!UNOBSERVED_KINDS.has(origin.kind)) {
    // Teardown usually kills the PTY first, so projectPath is often already
    // gone — the session id is enough to close the pair in the event log.
    recordSessionLifecycle({
      sessionId: id,
      projectPath: getSession(id)?.projectPath ?? null,
      action: 'end',
      sessionKind: origin.kind,
      parentSessionId: origin.parentSessionId ?? null,
      agentName: origin.agentName ?? null,
    })
  }
  notify()
}

function projectNameFromPath(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}

function displayNameFor(session: PtySession, origin: SessionOrigin): string {
  if (origin.label) return origin.label
  const title = session.terminalTitle?.trim()
  if (title) return title
  return projectNameFromPath(session.projectPath)
}

/** Origins we hold for sessions whose PTY is gone. Surfaced once as 'zombie'
 *  (so a leak is visible rather than silent) and pruned on the next read. */
const zombieSeen = new Set<string>()

/**
 * Everything alive right now, newest first, tagged by what owns it.
 *
 * Sessions with no recorded origin still appear — tagged by a best-effort
 * inference from the spawn command — so the overview can never hide a live
 * PTY just because some future spawn path forgot to tag it.
 */
export function listRegistry(): RegistryEntry[] {
  const now = Date.now()
  const live = getAllSessions()
  const liveIds = new Set(live.map((s) => s.id))

  const entries: RegistryEntry[] = live.map((session) => {
    const origin = origins.get(session.id) ?? inferOrigin(session)
    const status = statuses.get(session.id) ?? 'unknown'
    return {
      id: session.id,
      origin,
      projectPath: session.projectPath,
      projectName: projectNameFromPath(session.projectPath),
      claudeSessionId: session.claudeSessionId,
      terminalTitle: session.terminalTitle,
      displayName: displayNameFor(session, origin),
      status,
      startedAt: session.createdAt,
      uptimeMs: Math.max(0, now - session.createdAt),
      ephemeral: session.ephemeral === true,
      command: session.command,
    }
  })

  // Zombies: an origin with no PTY. Report each once, then prune.
  for (const [id, origin] of origins) {
    if (liveIds.has(id)) continue
    if (zombieSeen.has(id)) { origins.delete(id); statuses.delete(id); zombieSeen.delete(id); continue }
    zombieSeen.add(id)
    entries.push({
      id,
      origin,
      projectPath: '',
      projectName: '',
      claudeSessionId: null,
      terminalTitle: null,
      displayName: origin.label ?? 'Ended session',
      status: 'zombie',
      startedAt: now,
      uptimeMs: 0,
      ephemeral: false,
      command: '',
    })
  }

  return entries.sort((a, b) => b.startedAt - a.startedAt)
}

/** Best-effort origin for an untagged session — never guesses a specific
 *  owner, only user (claude) vs terminal (anything else). */
function inferOrigin(session: PtySession): SessionOrigin {
  return { kind: session.command === 'claude' ? 'user' : 'terminal' }
}

/** True when every live, non-ephemeral session is settled (not working and not
 *  blocked on a permission prompt). Used as the "app is quiet" gate for
 *  background observer jobs. Sessions whose status was never reported count as
 *  settled — an unknown-status session has produced no hook traffic at all. */
export function allSessionsIdle(): boolean {
  for (const session of getAllSessions()) {
    if (session.ephemeral) continue
    const status = statuses.get(session.id)
    if (status === 'working' || status === 'permission') return false
  }
  return true
}

/** ms since the most recent status transition into 'working' across all
 *  sessions, or Infinity when nothing has ever worked. */
let lastWorkingAt = 0
export function markActivity(): void { lastWorkingAt = Date.now() }
export function msSinceLastActivity(): number {
  return lastWorkingAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - lastWorkingAt
}

/** Live entry lookup — used by kill/attach actions to validate a target. */
export function getEntry(id: string): RegistryEntry | undefined {
  return getSession(id) ? listRegistry().find((e) => e.id === id) : undefined
}
