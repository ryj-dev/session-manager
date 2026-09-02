import type { ReportBackMode } from '../lib/spawn-tree'
export type { ReportBackMode }
import { create } from 'zustand'
import { defaultHotkeysFor, type HotkeyMap } from '../../shared/hotkeys'
import {
  defaultLayoutFor,
  getLeafIds,
  insertLeaf,
  removeLeaf,
  type Layout,
} from './../lib/splitLayouts'

export type ViewMode = 'graph' | 'focused' | 'split'

export interface SplitGroup {
  /** Stable group identifier. */
  id: string
  /** BSP layout tree — single source of truth for tile placement. */
  layout: Layout
  /** Cached `getLeafIds(layout)`. Used for tab-order / Cmd+N / focus cycling. */
  orderedSessionIds: string[]
}

/** Mirrors MemoryInjectionThreshold in src/main/memory-injection.ts. */
export type MemoryInjectionThreshold = 'super-strict' | 'strict' | 'balanced' | 'lenient'

/** A memory note injected into a session's context at prompt time.
 *  Mirrors InjectedMemory in src/main/memory-injection.ts. */
export interface InjectedMemory {
  filename: string
  title: string
  /** Exact token (without brackets) shown in the transcript announcement. */
  label: string
  type: string
  excerpt: string
  body: string
}

// Hotkey actions + defaults live in src/shared/hotkeys.ts, shared with the
// main process (settings-store, claude-tips, CLAUDE.md block) so the two
// sides can never drift apart again.
export type { HotkeyMap } from '../../shared/hotkeys'

export const defaultHotkeys: HotkeyMap = defaultHotkeysFor(
  typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')
)

export type TurnToolLevel = 'summary' | 'commands' | 'full'

/** Default layer selection + tool-activity level for the Share Turn modal. */
export interface TurnShareDefaults {
  prompt: boolean
  tool: boolean
  result: boolean
  toolLevel: TurnToolLevel
}

export const defaultTurnShareDefaults: TurnShareDefaults = {
  prompt: true,
  tool: true,
  result: true,
  toolLevel: 'commands',
}

export type ActivePanel = 'explorer' | 'agents' | 'skills' | 'design' | 'memory' | 'notes' | 'pipeline' | 'scheduled' | 'overview' | 'github' | null


export type SessionStatus =
  | 'working' | 'permission' | 'finished' | 'seen' | 'exited'
  /** PTY torn down for inactivity; node + snapshot + claudeSessionId kept.
   *  Entering the session (or a message arriving for it) resumes it. */
  | 'archived'
  /** `claude --resume` respawn in flight — keystrokes are blocked until ready. */
  | 'waking'

export type MessagePopupMode = 'manual' | 'timed' | 'disabled'

export interface MessageNotification {
  id: string
  targetSessionId: string
  fromSessionId: string | null
  message: string
  receivedAt: number
  dismissed: boolean
  expanded: boolean
  /** Remaining auto-dismiss ms for 'timed' mode. null = timer not yet started. */
  timerRemainingMs: number | null
}

// ---- Agentic pipeline (Cmd+L) ----

export type PipelineStage = 'plan' | 'implement' | 'review' | 'done'
export type AutonomyLevel = 'manual' | 'gated' | 'auto'
export type PipelineRole = 'orchestrator' | 'plan' | 'implement' | 'review'
export type PipelineSessionStatus = 'working' | 'idle' | 'permission' | 'done' | 'queued'
export type PipelineTone = 'pass' | 'fail' | 'warn' | 'active' | 'neutral'
export type PipelineKind = 'info' | 'plan-ready' | 'fanout' | 'review-verdict' | 'blocked' | 'done' | 'error'

/** Where a send-to-review task's diff comes from. Mirrors pipeline-store.ts. */
export type DiffSource =
  | { kind: 'working-tree' }
  | { kind: 'range'; base: string; target: string }

/** One entry in a session's curated milestone feed. Legacy persisted entries
 *  may be bare strings; the renderer normalizes those defensively. */
export interface FeedEntry {
  text: string
  kind?: PipelineKind
  tone?: PipelineTone
  ts?: number
}

/** A node in a task's session tree — orchestrator, a stage run, or a fan-out
 *  child. Populated by real orchestration (spawn-session / emit-milestone);
 *  undefined until a task is actually wired to running sessions. */
export interface PipelineSession {
  id: string
  label: string
  role: PipelineRole
  status: PipelineSessionStatus
  badge?: string
  tone?: PipelineTone
  log: FeedEntry[]
  children?: PipelineSession[]
  fanoutKind?: string
  /** Stable Claude conversation id for best-effort live resume. */
  claudeSessionId?: string | null
  /** Working directory the session ran in (for resume). */
  cwd?: string
  /** For worktree fan-out workers: the branch they built on. */
  worktreeBranch?: string
  /** Filesystem path of the worker's isolated worktree. */
  worktreePath?: string
  /** Worktree merged + removed → node is read-only (no live resume). */
  worktreeRemoved?: boolean
  /** Best-effort live resume failed (transcript gone) → node is read-only. */
  resumeFailed?: boolean
}

export interface PipelineTask {
  /** Equals the backing todo id. */
  id: string
  title: string
  tags: string[]
  stage: PipelineStage
  autonomy: AutonomyLevel
  reviewRound?: number
  gate?: { label: string; detail: string } | null
  orchestrator?: PipelineSession
  createdAt: number
  /** When the task entered the Done stage (ms). Used by the completed-filter. */
  completedAt?: number
  /** Integration state of the per-task branch: 'merged' (cleanly integrated),
   *  'conflict' (merge failed — card held out of Done, worktree kept), or
   *  'pending'. Undefined for non-isolated tasks. */
  integrationStatus?: 'pending' | 'merged' | 'conflict'
  /** Files that conflicted on the last failed integration. */
  conflictFiles?: string[]
  /** The stage the orchestrator began at (default 'plan'). 'review' marks a
   *  send-to-review task — plan/implement were skipped. */
  startStage?: PipelineStage
  /** Where the diff under review comes from (send-to-review tasks only). */
  diffSource?: DiffSource
  /** True while paused: live sessions gracefully stopped, worktree +
   *  claudeSessionId preserved for resume. */
  paused?: boolean
  /** When the task was paused (ms). */
  pausedAt?: number
}

export const PIPELINE_STAGE_ORDER: PipelineStage[] = ['plan', 'implement', 'review', 'done']

/** Recency window for showing completed todos / pipeline cards (Linear-style). */
export type CompletedFilter = 'all' | 'day' | 'week' | 'month'

/** Cutoff timestamp (ms) for a completed-filter window; null = show all. Items
 *  completed at or after the cutoff are shown. */
export function completedCutoffMs(filter: CompletedFilter, now: number = Date.now()): number | null {
  const DAY = 86_400_000
  switch (filter) {
    case 'day': return now - DAY
    case 'week': return now - 7 * DAY
    case 'month': return now - 30 * DAY
    default: return null
  }
}

// ---- Scheduled tasks (Cmd+J) ----
// Types mirror the main-process source of truth in src/main/schedule-store.ts.
// The main process owns the authoritative state; the renderer keeps this mirror,
// refreshed by the 'schedules:changed' broadcast (wired in App.tsx).

export type ScheduleRecurrence =
  | { kind: 'none' }
  | { kind: 'interval'; minutes: number } // 60 = hourly
  | { kind: 'daily'; hour: number; minute: number }

/** Launch-trigger behaviour. 'off' = never on launch, 'every' = each launch,
 *  'firstOfDay' = only the first launch of a calendar day. */
export type LaunchTrigger = 'off' | 'every' | 'firstOfDay'

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
  /** Human-readable failure reason when status === 'error'. */
  error?: string
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
  /** Model for spawned runs: alias (haiku|sonnet|opus|fable) or a full model id.
   *  Undefined/empty = inherit the user's current default model. */
  model?: string
  /** Launch-trigger behaviour: 'off' = recurrence only, 'every' = each app
   *  launch, 'firstOfDay' = first launch of a calendar day. */
  launch: LaunchTrigger
  recurrence: ScheduleRecurrence
  /** Cap on automatic fires per calendar day; undefined/<=0 = unlimited. */
  maxRunsPerDay?: number
  enabled: boolean
  /** ISO 8601. */
  createdAt: string
  /** ISO 8601; last time any run started. */
  lastRunAt?: string
  /** Run history, capped to the most-recent runs in the main store. */
  runs: ScheduleRun[]
}

// ---- GitHub integration (PR panel) ----
// Types mirror the main-process source of truth in src/main/github-store.ts /
// github-auth.ts. The renderer keeps a mirror refreshed by 'github:changed'.

export type GithubItemKind = 'review-request' | 'mention' | 'my-pr-activity'

/** Mirrors GithubDraft in src/main/github-store.ts. */
export interface GithubDraft {
  type: 'review' | 'reply-with-fixes'
  verdict?: 'approve' | 'request-changes' | 'comment'
  body: string
  comments?: { path: string; line: number; body: string }[]
  replies?: { commentId: number; body: string }[]
  commitsReady?: boolean
  repoPath?: string
  sessionId: string | null
  createdAt: string
}

export interface GithubItem {
  /** GitHub notification thread id — stable per PR per user. */
  id: string
  kind: GithubItemKind
  /** "owner/repo" */
  repo: string
  prNumber: number
  title: string
  author: string
  htmlUrl: string
  prState: 'open' | 'draft' | 'merged' | 'closed'
  updatedAt: string
  unread: boolean
  latestCommentUrl: string | null
  /** Agent-prepared response awaiting Submit (draft mode). */
  draft?: GithubDraft | null
  respondedAt?: string
  respondedSummary?: string
  /** 'submitted' = a response went to GitHub; 'dismissed' = an agent judged
   *  none was warranted. Missing on items closed out before this existed. */
  respondedKind?: 'submitted' | 'dismissed'
  /** The (torn-down) agent's resumable conversation — powers "Discuss". */
  agentClaudeSessionId?: string | null
  agentCwd?: string
  /** App session id while the agent is live — powers "Watch live". */
  agentSessionId?: string | null
}

/** Mirrors GithubAutoMode / GithubAutoReviewRules in src/main/settings-store.ts. */
export type GithubAutoMode = 'off' | 'draft' | 'auto'
export interface GithubAutoReviewRules {
  reviewRequest: GithubAutoMode
  mention: GithubAutoMode
  myPrActivity: GithubAutoMode
}
export const defaultGithubAutoReview: GithubAutoReviewRules = {
  reviewRequest: 'off',
  mention: 'off',
  myPrActivity: 'off',
}

/** PR-state filter: 'active' hides merged/closed (the default). */
export type GithubStateFilter = 'active' | 'all'
/** How far back to show items, by notification updatedAt. */
export type GithubRangeFilter = 'day' | 'week' | 'month' | 'all'

export interface GithubAuthStatus {
  connected: boolean
  source: 'stored' | 'gh-cli' | null
  login: string | null
  scopes: string | null
  deviceFlowAvailable: boolean
  error: string | null
}

// ---- Unified session registry (Cmd+P overview) ----
// Types mirror the main-process source of truth in src/main/session-registry.ts.
// Derived state: main joins the live PTY table with per-session origin tags and
// hook status. The renderer keeps a mirror refreshed by 'registry:changed' plus
// a slow poll while the overview is open (so uptime ticks and zombies surface).

/** Mirrors SessionKind in src/main/session-registry.ts. */
export type SessionKind =
  | 'user' | 'terminal' | 'scheduled' | 'pipeline' | 'agent' | 'observer'
  /** A drawer/preview PTY rendering an existing conversation — not a session
   *  the user started, and never shown on the graph. */
  | 'preview'
  /** A background GitHub PR review/fix agent (Cmd+G panel). */
  | 'github'
export type RegistryStatus = 'working' | 'idle' | 'permission' | 'zombie' | 'unknown'

export interface SessionOrigin {
  kind: SessionKind
  scheduleId?: string
  scheduleName?: string
  scheduleRunId?: string
  pipelineTaskId?: string
  pipelineRole?: string
  pipelineLabel?: string
  agentName?: string
  observerJob?: string
  parentSessionId?: string
  reportBack?: ReportBackMode
  label?: string
}

export interface RegistryEntry {
  id: string
  origin: SessionOrigin
  projectPath: string
  projectName: string
  claudeSessionId: string | null
  terminalTitle: string | null
  displayName: string
  status: RegistryStatus
  startedAt: number
  uptimeMs: number
  ephemeral: boolean
  command: string
}

// ---- Observer / insights inbox (bottom of the Cmd+P overview) ----
// Types mirror src/main/observer/db.ts + observer/index.ts. The observer keeps
// its own SQLite store; the renderer pulls the whole inbox on demand and
// re-pulls on the 'observer:changed' broadcast.

export type SuggestionKind =
  | 'scheduled-task' | 'todo' | 'skill' | 'memory-link' | 'todo-cleanup'
  | 'memory-note' | 'claude-md' | 'use-feature' | 'pipeline-candidate'
export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed' | 'never'

export interface Suggestion {
  id: string
  patternId: string | null
  createdAt: number
  title: string
  rationale: string
  kind: SuggestionKind
  proposal: Record<string, unknown>
  status: SuggestionStatus
  resolvedAt: number | null
  result: string | null
}

export interface ObserverJobStatus {
  id: string
  everyHours: number
  running: boolean
  lastRunAt: number | null
  debtMs: number
  remainingMs: number
  blockedBy: 'debt' | 'busy' | 'quiet' | null
}

export interface ObserverInbox {
  suggestions: Suggestion[]
  pendingCount: number
  statusLine: string
  jobs: ObserverJobStatus[]
  activeSessionId: string | null
  enabled: boolean
  digestCount: number
  queuedCount: number
  journalUpdatedAt: number | null
}

// ---- Canvas (per-session UI artifacts) ----
// Types mirror the main-process source of truth in src/main/canvas-types.ts.
// The main process owns the authoritative state (canvas-store.ts); the renderer
// keeps this mirror, refreshed by the 'canvas:changed' broadcast (wired in
// App.tsx). Open/selection/unseen state is renderer-local UI state.

export type CanvasArtifactSource = 'agent' | 'user'

export interface CanvasTableColumn {
  key: string
  label?: string
  align?: 'left' | 'right' | 'center'
}

export type CanvasTableCell = string | number | boolean | null

export interface CanvasTableSpec {
  columns: CanvasTableColumn[]
  rows: Array<Record<string, CanvasTableCell>>
}

export interface CanvasImageSpec {
  path: string
  /** Caller-supplied source path the app-owned copy was made from (display only). */
  originalPath?: string
  alt?: string
}

/** Coordinates are pixels in the image's NATURAL size (SVG viewBox scaling). */
export type CanvasAnnotation =
  | { kind: 'circle'; cx: number; cy: number; r: number; label?: string; color?: string }
  | { kind: 'box'; x: number; y: number; w: number; h: number; label?: string; color?: string }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; label?: string; color?: string }
  | { kind: 'label'; x: number; y: number; text: string; color?: string }

export interface CanvasArtifactBase {
  id: string
  /** App/PTY session id of the emitter (dead after an app restart). */
  sessionId: string
  /** Claude conversation id — re-binds persisted artifacts to restored sessions. */
  claudeSessionId: string | null
  source: CanvasArtifactSource
  title?: string
  /** ms epoch. */
  createdAt: number
}

export type CanvasArtifact =
  | (CanvasArtifactBase & { component: 'result-table'; table: CanvasTableSpec })
  | (CanvasArtifactBase & { component: 'markdown'; markdown: string })
  | (CanvasArtifactBase & { component: 'image'; image: CanvasImageSpec })
  | (CanvasArtifactBase & { component: 'annotated-image'; image: CanvasImageSpec; annotations: CanvasAnnotation[] })

/** All artifacts belonging to a session, oldest → newest. Matches on the live
 *  app session id OR the stable claudeSessionId (how persisted artifacts from a
 *  previous app run re-attach to a restored session). */
export function artifactsForSession(
  artifacts: CanvasArtifact[],
  session: Pick<Session, 'id' | 'claudeSessionId'>,
): CanvasArtifact[] {
  return artifacts
    .filter(
      (a) =>
        a.sessionId === session.id ||
        (a.claudeSessionId != null && a.claudeSessionId === session.claudeSessionId),
    )
    .sort((a, b) => a.createdAt - b.createdAt)
}

export interface Session {
  id: string
  projectPath: string
  projectName: string
  terminalTitle: string | null
  status: SessionStatus
  snapshot: HTMLCanvasElement | null
  /** Bumped on each snapshot capture. Snapshot canvases are reused (same reference)
      to avoid GC churn, so consumers must depend on this counter to detect updates. */
  snapshotVersion: number
  createdAt: number
  /** Stable Claude Code conversation UUID (persists across resumes / app reloads). */
  claudeSessionId: string | null
  /** True when this session is a hidden terminal attached to a Claude session as a
   *  hover-overlay sidebar. Attached sessions are excluded from the graph and from
   *  graph navigation but still mount as real PTYs. */
  isAttached: boolean
  /** True for agentic-pipeline sessions (orchestrator + stage/fan-out workers).
   *  Excluded from the graph view and graph nav — they live in the pipeline
   *  board (Cmd+L) — but still mount as real PTYs. */
  isPipeline: boolean
  /** True for scheduled-task sessions (one-shot runs spawned by the scheduler, and
   *  resumed historical runs). Excluded from the graph view, graph nav, the hidden
   *  snapshot layer, and the restore prompt — they live in the Scheduled Tasks panel
   *  — but still mount as real PTYs. */
  isScheduled: boolean
  /** Background GitHub agent — kept off the graph (Cmd+G panel is its home). */
  isGithub: boolean
  /** For Claude sessions with `terminalPairingMode === 'overlay'`: the id of the hidden
   *  terminal session attached to this one. Null on attached sessions and on
   *  Claude sessions without an attachment. */
  attachedTerminalId: string | null
  /** App session id of the session that spawned this one (spawn-session /
   *  spawn-agent), when known. Null for sessions the user opened themselves and
   *  for sessions restored after an app restart — spawn linkage is in-memory. */
  spawnParentId: string | null
  /** The spawner's report-back contract. 'true' / 'done' mean the parent is
   *  waiting on this child, which is what makes the graph hang it off the
   *  parent instead of the project hub. */
  reportBack: ReportBackMode | null
}

export interface AppState {
  // Sessions
  sessions: Session[]
  addSession: (id: string, projectPath: string, claudeSessionId?: string | null, opts?: { isAttached?: boolean; isPipeline?: boolean; isScheduled?: boolean; isGithub?: boolean; spawnParentId?: string | null; reportBack?: ReportBackMode | null }) => void
  removeSession: (id: string) => void
  updateSessionStatus: (id: string, status: SessionStatus) => void
  markSessionSeen: (id: string) => void
  updateSessionSnapshot: (id: string, snapshot: HTMLCanvasElement) => void
  updateSessionTitle: (id: string, title: string) => void
  updateSessionClaudeId: (id: string, claudeSessionId: string) => void
  /** Bind a hidden terminal session as the attached overlay terminal for a Claude session. */
  setAttachedTerminal: (parentId: string, attachedId: string | null) => void

  // UI state
  viewMode: ViewMode
  setViewMode: (mode: ViewMode) => void
  activePanel: ActivePanel
  setActivePanel: (panel: ActivePanel) => void
  focusedSessionId: string | null
  setFocusedSessionId: (id: string | null) => void
  selectedSessionIndex: number
  setSelectedSessionIndex: (index: number) => void
  designDarkMode: boolean
  toggleDesignDarkMode: () => void

  // Split-view group selection (Phase 1)
  /** True while the user is holding the platform-meta key (Cmd/Ctrl) without any other key. */
  isCmdHeld: boolean
  setCmdHeld: (held: boolean) => void
  /** Sessions the user has Cmd+clicked while building a group. Cleared on release. */
  selectedForGroupingIds: string[]
  toggleGroupingSelection: (id: string) => void
  clearGroupingSelection: () => void
  setGroupingSelection: (ids: string[]) => void

  // Split-view groups
  splitGroups: SplitGroup[]
  activeSplitGroupId: string | null
  /** True while the Cmd-hold-still preview modal is shown. Modal reads selection live. */
  isSplitModalOpen: boolean
  openSplitModal: () => void
  closeSplitModal: () => void
  /** Layout chosen by the user during the modal drag preview. `null` = no pending
   *  change. Cleared on close. */
  pendingLayout: Layout | null
  setPendingLayout: (layout: Layout | null) => void
  /** Create a new group with an explicit layout, or a default one for `orderedSessionIds`. */
  createSplitGroup: (orderedSessionIds: string[], layout?: Layout | null) => string
  dissolveSplitGroup: (groupId: string) => void
  /** Switch to split view on the given group. */
  enterSplitGroup: (groupId: string) => void
  /** Last-focused pane per group — restored by `enterSplitGroup` on re-entry.
   *  In-memory only; not persisted across app restarts. */
  splitGroupLastFocus: Record<string, string>
  setSplitGroupLastFocus: (groupId: string, sessionId: string) => void
  /** Replace the group's layout tree. `orderedSessionIds` is recomputed from leaves. */
  setSplitGroupLayout: (groupId: string, layout: Layout) => void
  /** Append a new session into the active group by splitting the largest pane. */
  addSessionToSplitGroup: (groupId: string, sessionId: string) => void
  /** Remove a session from the group's layout; collapse the surviving sibling. */
  removeSessionFromSplitGroup: (groupId: string, sessionId: string) => void
  /** True when the user clicked + in the modal and is graph-picking more sessions
   *  to add to the existing active group. */
  isExpandingExistingGroup: boolean
  setExpandingExistingGroup: (v: boolean) => void

  // Settings
  baseProjectsDir: string | null
  setBaseProjectsDir: (dir: string) => void
  autoFocusOnSpawn: boolean
  setAutoFocusOnSpawn: (value: boolean) => void
  persistExplorerPath: boolean
  setPersistExplorerPath: (value: boolean) => void
  explorerFollowsProject: boolean
  setExplorerFollowsProject: (value: boolean) => void
  colorExplorerByProject: boolean
  setColorExplorerByProject: (value: boolean) => void
  hotkeys: HotkeyMap
  setHotkeys: (hotkeys: HotkeyMap) => void
  messagePopup: MessagePopupMode
  setMessagePopup: (mode: MessagePopupMode) => void
  messagePopupSeconds: number
  setMessagePopupSeconds: (seconds: number) => void
  autoModeForChildSessions: boolean
  setAutoModeForChildSessions: (value: boolean) => void
  autoModeForManualSessions: boolean
  setAutoModeForManualSessions: (value: boolean) => void
  autoModeForRestoredSessions: boolean
  setAutoModeForRestoredSessions: (value: boolean) => void
  ambientTodoNudge: boolean
  setAmbientTodoNudge: (value: boolean) => void
  /** Mix Session Manager feature tips into Claude Code's spinner tips. */
  injectSpinnerTips: boolean
  setInjectSpinnerTips: (value: boolean) => void
  /** Prompt-time memory injection mode (off / first prompt only / every prompt). */
  memoryInjectionMode: 'off' | 'first' | 'every'
  setMemoryInjectionMode: (value: 'off' | 'first' | 'every') => void
  /** Max notes injected across one session; null = unlimited. */
  memoryInjectionSessionCap: number | null
  setMemoryInjectionSessionCap: (value: number | null) => void
  /** How similar a note must be to inject (strictness preset). */
  memoryInjectionThreshold: MemoryInjectionThreshold
  setMemoryInjectionThreshold: (value: MemoryInjectionThreshold) => void
  /** Notes injected per session (union across the session's prompts), so the
   *  transcript's "[title]" tokens can be linkified and expanded on click. */
  memoryInjections: Record<string, InjectedMemory[]>
  handleMemoryInjected: (sessionId: string, entries: InjectedMemory[]) => void
  /** Open expansion for a clicked injected-memory token, anchored at the
   *  click's viewport coordinates. Null when closed. */
  memoryExpansion: { sessionId: string; filename: string; x: number; y: number } | null
  openMemoryExpansion: (sessionId: string, filename: string, x: number, y: number) => void
  closeMemoryExpansion: () => void
  /** Auto-display image paths from user prompts on the session's canvas. */
  canvasAutoShowUserImages: boolean
  setCanvasAutoShowUserImages: (value: boolean) => void
  spawnIntoCurrentSplit: boolean
  setSpawnIntoCurrentSplit: (value: boolean) => void
  /** How spawned Claude sessions are paired with a shell. Mutually exclusive. */
  terminalPairingMode: 'off' | 'split' | 'overlay'
  setTerminalPairingMode: (value: 'off' | 'split' | 'overlay') => void
  /** Share Turn export folder. Blank/null = `<projectPath>/turns/`. */
  turnExportFolder: string | null
  setTurnExportFolder: (dir: string | null) => void
  turnShareDefaults: TurnShareDefaults
  setTurnShareDefaults: (defaults: TurnShareDefaults) => void
  /** Session id the Share Turn modal is open for, or null when closed. */
  shareTurnSessionId: string | null
  setShareTurnSessionId: (id: string | null) => void
  /** Cmd+B branch: open the fork beside the original in a split group. */
  openBranchInSplit: boolean
  setOpenBranchInSplit: (value: boolean) => void
  /** Archive inactive sessions (kill PTY, keep node, resume on click). Opt-in. */
  archiveInactiveSessions: boolean
  setArchiveInactiveSessions: (value: boolean) => void
  /** Observer (session digests + curator). Opt-in — reads transcripts on disk. */
  observerEnabled: boolean
  setObserverEnabled: (value: boolean) => void
  /** Minutes of inactivity before an eligible session archives (min 5). */
  archiveInactiveMinutes: number
  setArchiveInactiveMinutes: (value: number) => void
  /** Sessions pinned against auto-archiving (mirror of main's in-memory set). */
  archivePinnedSessionIds: string[]
  setArchivePinned: (id: string, pinned: boolean) => void

  // Hover-overlay attached-terminal pin state (per-parent-Claude-session ids).
  // When pinned, the overlay sticks open and lays side-by-side instead of overlaying.
  pinnedAttachedTerminalIds: string[]
  togglePinnedAttachedTerminal: (parentId: string) => void

  // Todos
  todosSelectedTags: string[]
  setTodosSelectedTags: (tags: string[]) => void
  toggleTodosTag: (tag: string) => void
  todosSearch: string
  setTodosSearch: (s: string) => void
  todosShowCompleted: boolean
  setTodosShowCompleted: (v: boolean) => void
  /** Recency window for completed items, shared by Notes (Cmd+N) and Pipeline (Cmd+L). */
  completedFilter: CompletedFilter
  setCompletedFilter: (f: CompletedFilter) => void
  todosSelectedId: string | null
  setTodosSelectedId: (id: string | null) => void
  /** Session-project tag auto-applied when the panel is opened from a session (e.g. `project:session-manager`). */
  todosSessionProjectTag: string | null
  setTodosSessionProjectTag: (tag: string | null) => void
  /** Persisted width (px) of the todo detail pane when a todo is selected. */
  todosDetailWidth: number
  setTodosDetailWidth: (w: number) => void

  // Agentic pipeline (Cmd+L)
  pipelineTasks: PipelineTask[]
  pipelineDefaultAutonomy: AutonomyLevel
  setPipelineDefaultAutonomy: (level: AutonomyLevel) => void
  /** Replace the mirror from the main-process store (initial load + broadcast). */
  setPipelineTasks: (tasks: PipelineTask[]) => void
  /** Board project filter (project basename, or null = all). Set on open from
   *  the current session's project; user-overridable via the board dropdown. */
  pipelineProjectFilter: string | null
  setPipelineProjectFilter: (name: string | null) => void
  /** Move a todo into the pipeline at the Plan stage (no-op if already present). */
  startPipelineTask: (todo: { id: string; title: string; tags: string[] }) => void
  /** Send EXISTING work straight into the review⇄fix loop (skip plan/implement).
   *  The diff is resolved from git per `diffSource`; the todo body is the rubric. */
  startPipelineReview: (todo: { id: string; title: string; tags: string[] }, diffSource: DiffSource) => void
  /** Resolves to the updated task list once the main process has applied the
   *  stage change (a Done transition only lands if the merge succeeds). */
  setPipelineStage: (id: string, stage: PipelineStage) => Promise<PipelineTask[]>
  setPipelineAutonomy: (id: string, level: AutonomyLevel) => void
  /** Resolve a pending gate: approve advances to the next stage; reject clears it.
   *  Resolves to the updated task list (an approve→Done only lands on clean merge). */
  resolvePipelineGate: (id: string, approve: boolean) => Promise<PipelineTask[]>
  /** Remove a task from the pipeline (back to Backlog). */
  removePipelineTask: (id: string) => void
  /** Pause a task: gracefully stop its live sessions, keep the worktree +
   *  claudeSessionId so it can be resumed. */
  pausePipelineTask: (id: string) => void
  /** Resume a paused task: re-wake the orchestrator from its saved conversation. */
  resumePipelineTask: (id: string) => void

  // Scheduled tasks (Cmd+J). The main process owns the authoritative state
  // (schedule-store.ts); these actions write through via IPC and the mirror is
  // refreshed by the 'schedules:changed' broadcast (wired in App.tsx).
  scheduledTasks: ScheduledTask[]
  /** Replace the mirror from the main-process store (initial load + broadcast). */
  setScheduledTasks: (tasks: ScheduledTask[]) => void
  /** Create a schedule. Resolves once the main process applies it. */
  createScheduledTask: (data: Omit<ScheduledTask, 'id' | 'createdAt' | 'runs' | 'lastRunAt'>) => Promise<ScheduledTask>
  /** Partial update (server-managed fields not patchable). */
  updateScheduledTask: (id: string, patch: Partial<Omit<ScheduledTask, 'id' | 'createdAt' | 'runs'>>) => void
  /** Remove a schedule. */
  deleteScheduledTask: (id: string) => void
  /** Enable/disable a schedule. */
  setScheduledTaskEnabled: (id: string, enabled: boolean) => void
  /** Fire a schedule immediately; resolves to the spawned session id (or null). */
  runScheduledTaskNow: (id: string) => Promise<string | null>

  // GitHub integration. Main owns auth + items (github-auth/github-store, fed
  // by github-poller); these mirror via 'github:changed' (wired in App.tsx).
  githubItems: GithubItem[]
  setGithubItems: (items: GithubItem[]) => void
  /** Last-known auth status; null until the first probe resolves. */
  githubStatus: GithubAuthStatus | null
  setGithubStatus: (status: GithubAuthStatus | null) => void
  /** Poller hit a 401 and no fallback token worked — panel shows reconnect. */
  githubAuthLost: boolean
  setGithubAuthLost: (lost: boolean) => void
  /** The user engaged a GitHub agent — un-hide it on the graph. */
  adoptGithubSession: (sessionId: string) => void
  /** Panel filters — prefs, persisted in the settings blob (wired in App.tsx). */
  githubStateFilter: GithubStateFilter
  setGithubStateFilter: (f: GithubStateFilter) => void
  githubRangeFilter: GithubRangeFilter
  setGithubRangeFilter: (f: GithubRangeFilter) => void
  /** Per-event auto-review modes (settings pref; enforced in main). */
  githubAutoReview: GithubAutoReviewRules
  setGithubAutoReview: (rules: GithubAutoReviewRules) => void
  /** Model for review/fix agents: alias or full id; '' = user default. */
  githubReviewModel: string
  setGithubReviewModel: (model: string) => void

  // Canvas. Main process owns the artifact list (canvas-store.ts); the mirror is
  // refreshed by 'canvas:changed'. Everything else here is renderer-local UI
  // state: which sessions' docks are open, which artifact is selected per
  // session, and which sessions have unseen artifacts (graph-node badge).
  canvasArtifacts: CanvasArtifact[]
  /** Replace the mirror from the main-process store (initial load + broadcast). */
  setCanvasArtifacts: (artifacts: CanvasArtifact[]) => void
  /** Sessions whose canvas dock is open. A new emit re-adds a dismissed session. */
  openCanvasSessionIds: string[]
  openCanvas: (sessionId: string) => void
  dismissCanvas: (sessionId: string) => void
  /** Selected artifact id per session; absent = latest. */
  canvasSelection: Record<string, string>
  selectCanvasArtifact: (sessionId: string, artifactId: string) => void
  /** Sessions with artifacts the user hasn't viewed yet (drives the graph badge). */
  unseenCanvasSessionIds: string[]
  markCanvasSeen: (sessionId: string) => void
  /** A NEW artifact arrived ('canvas:emitted'): upsert it, open the session's
   *  dock, select it, and mark unseen unless the session is currently visible. */
  handleCanvasEmitted: (artifact: CanvasArtifact) => void
  /** 'canvas:focus' from an agent: open the dock + select an existing artifact. */
  handleCanvasFocus: (sessionId: string, artifactId: string) => void

  // Observer / insights inbox. Pulled on demand; refreshed on 'observer:changed'.
  observerInbox: ObserverInbox | null
  setObserverInbox: (inbox: ObserverInbox | null) => void
  /** Pull the inbox from main. Safe to call repeatedly. */
  refreshObserverInbox: () => Promise<void>
  acceptSuggestion: (id: string) => Promise<{ ok: boolean; message: string }>
  dismissSuggestion: (id: string, forever: boolean) => Promise<{ ok: boolean; message: string }>
  runObserverJob: (jobId: string) => Promise<boolean>

  // Sessions overview (Cmd+P). Main owns the registry; the renderer mirrors it
  // via 'registry:changed' and a poll while the panel is open.
  registryEntries: RegistryEntry[]
  setRegistryEntries: (entries: RegistryEntry[]) => void
  /** Kill a live session from the overview. Resolves once main has torn it down. */
  killRegistrySession: (id: string) => Promise<{ ok: boolean; error?: string }>

  // Message notifications
  pendingMessages: MessageNotification[]
  addMessageNotification: (msg: { targetSessionId: string; fromSessionId: string | null; message: string }) => void
  dismissMessage: (id: string) => void
  toggleMessageExpanded: (id: string) => void
  updateMessageTimer: (id: string, remainingMs: number) => void
}

function normalizePath(p: string): string {
  // Normalize to forward slashes on all platforms (JS/Node handles them fine on Windows)
  return p.replace(/\\/g, '/')
}

function projectNameFromPath(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).pop() || projectPath
}

export const useStore = create<AppState>((set, get) => ({
  // Sessions
  sessions: [],
  addSession: (id, projectPath, claudeSessionId = null, opts) =>
    set((state) => {
      // Guard against duplicate ids. Multiple paths can fire for the same
      // session (crash-recovery, restoreSessions, onSessionSpawned IPC,
      // local spawn handlers), and StrictMode double-invokes the recovery
      // effect in dev. Without this, the graph view stacks N SessionNode
      // elements at the same spoke position for each duplicated id.
      if (state.sessions.some((s) => s.id === id)) return state
      return {
        sessions: [
          ...state.sessions,
          {
            id,
            projectPath: normalizePath(projectPath),
            projectName: projectNameFromPath(projectPath),
            terminalTitle: null,
            status: 'seen',
            snapshot: null,
            snapshotVersion: 0,
            createdAt: Date.now(),
            claudeSessionId,
            isAttached: !!opts?.isAttached,
            isPipeline: !!opts?.isPipeline,
            isScheduled: !!opts?.isScheduled,
            isGithub: !!opts?.isGithub,
            attachedTerminalId: null,
            spawnParentId: opts?.spawnParentId ?? null,
            reportBack: opts?.reportBack ?? null,
          }
        ]
      }
    }),
  setAttachedTerminal: (parentId, attachedId) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === parentId ? { ...s, attachedTerminalId: attachedId } : s
      ),
    })),
  removeSession: (id) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      focusedSessionId: state.focusedSessionId === id ? null : state.focusedSessionId,
      // Canvas UI state is per-live-session; artifacts themselves persist in main.
      openCanvasSessionIds: state.openCanvasSessionIds.filter((sid) => sid !== id),
      unseenCanvasSessionIds: state.unseenCanvasSessionIds.filter((sid) => sid !== id),
    })),
  updateSessionStatus: (id, status) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, status } : s))
    })),
  markSessionSeen: (id) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id && s.status === 'finished' ? { ...s, status: 'seen' as SessionStatus } : s
      )
    })),
  updateSessionSnapshot: (id, snapshot) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, snapshot, snapshotVersion: s.snapshotVersion + 1 } : s
      )
    })),
  updateSessionTitle: (id, title) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, terminalTitle: title } : s))
    })),
  updateSessionClaudeId: (id, claudeSessionId) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, claudeSessionId } : s))
    })),

  // UI state
  viewMode: 'graph',
  setViewMode: (mode) => set({ viewMode: mode }),
  activePanel: null,
  setActivePanel: (panel) => set({ activePanel: panel }),
  focusedSessionId: null,
  setFocusedSessionId: (id) => set({ focusedSessionId: id }),
  selectedSessionIndex: 0,
  setSelectedSessionIndex: (index) => set({ selectedSessionIndex: index }),
  designDarkMode: true,
  toggleDesignDarkMode: () => set((state) => ({ designDarkMode: !state.designDarkMode })),

  // Split-view group selection
  isCmdHeld: false,
  setCmdHeld: (held) =>
    set(() => (held ? { isCmdHeld: true } : { isCmdHeld: false, selectedForGroupingIds: [] })),
  selectedForGroupingIds: [],
  toggleGroupingSelection: (id) =>
    set((state) => ({
      selectedForGroupingIds: state.selectedForGroupingIds.includes(id)
        ? state.selectedForGroupingIds.filter((s) => s !== id)
        : [...state.selectedForGroupingIds, id],
    })),
  clearGroupingSelection: () => set({ selectedForGroupingIds: [] }),
  setGroupingSelection: (ids) => set({ selectedForGroupingIds: ids }),

  // Split groups
  splitGroups: [],
  activeSplitGroupId: null,
  isSplitModalOpen: false,
  openSplitModal: () => set({ isSplitModalOpen: true }),
  closeSplitModal: () => set({ isSplitModalOpen: false, pendingLayout: null }),
  pendingLayout: null,
  setPendingLayout: (layout) => set({ pendingLayout: layout }),
  createSplitGroup: (orderedSessionIds, layout) => {
    const id = crypto.randomUUID()
    const finalLayout = layout ?? defaultLayoutFor(orderedSessionIds)
    if (!finalLayout) throw new Error('Cannot create a split group with no members')
    const finalOrder = getLeafIds(finalLayout)
    set((state) => ({
      splitGroups: [...state.splitGroups, { id, layout: finalLayout, orderedSessionIds: finalOrder }],
    }))
    return id
  },
  dissolveSplitGroup: (groupId) =>
    set((state) => {
      const { [groupId]: _dropped, ...lastFocus } = state.splitGroupLastFocus
      return {
        splitGroups: state.splitGroups.filter((g) => g.id !== groupId),
        activeSplitGroupId: state.activeSplitGroupId === groupId ? null : state.activeSplitGroupId,
        splitGroupLastFocus: lastFocus,
      }
    }),
  enterSplitGroup: (groupId) =>
    set((state) => {
      // Restore the pane the user had focused last time they were in this
      // group; fall back to null so SplitView defaults to slot 0.
      const group = state.splitGroups.find((g) => g.id === groupId)
      const remembered = state.splitGroupLastFocus[groupId]
      const focusedSessionId =
        remembered && group?.orderedSessionIds.includes(remembered) ? remembered : null
      return { activeSplitGroupId: groupId, viewMode: 'split', focusedSessionId }
    }),
  splitGroupLastFocus: {},
  setSplitGroupLastFocus: (groupId, sessionId) =>
    set((state) =>
      state.splitGroupLastFocus[groupId] === sessionId
        ? {}
        : { splitGroupLastFocus: { ...state.splitGroupLastFocus, [groupId]: sessionId } }
    ),
  setSplitGroupLayout: (groupId, layout) =>
    set((state) => ({
      splitGroups: state.splitGroups.map((g) =>
        g.id === groupId ? { ...g, layout, orderedSessionIds: getLeafIds(layout) } : g
      ),
    })),
  addSessionToSplitGroup: (groupId, sessionId) =>
    set((state) => ({
      splitGroups: state.splitGroups.map((g) => {
        if (g.id !== groupId) return g
        if (g.orderedSessionIds.includes(sessionId)) return g
        const layout = insertLeaf(g.layout, sessionId)
        return { ...g, layout, orderedSessionIds: getLeafIds(layout) }
      }),
    })),
  removeSessionFromSplitGroup: (groupId, sessionId) =>
    set((state) => {
      const next: SplitGroup[] = []
      let removedGroup = false
      for (const g of state.splitGroups) {
        if (g.id !== groupId) { next.push(g); continue }
        const layout = removeLeaf(g.layout, sessionId)
        if (!layout) { removedGroup = true; continue }
        next.push({ ...g, layout, orderedSessionIds: getLeafIds(layout) })
      }
      return {
        splitGroups: next,
        activeSplitGroupId:
          removedGroup && state.activeSplitGroupId === groupId
            ? null
            : state.activeSplitGroupId,
      }
    }),
  isExpandingExistingGroup: false,
  setExpandingExistingGroup: (v) => set({ isExpandingExistingGroup: v }),

  // Settings
  baseProjectsDir: null,
  setBaseProjectsDir: (dir) => set({ baseProjectsDir: dir }),
  autoFocusOnSpawn: true,
  setAutoFocusOnSpawn: (value) => set({ autoFocusOnSpawn: value }),
  persistExplorerPath: true,
  setPersistExplorerPath: (value) => set({ persistExplorerPath: value }),
  explorerFollowsProject: true,
  setExplorerFollowsProject: (value) => set({ explorerFollowsProject: value }),
  colorExplorerByProject: false,
  setColorExplorerByProject: (value) => set({ colorExplorerByProject: value }),
  hotkeys: { ...defaultHotkeys },
  setHotkeys: (hotkeys) => set({ hotkeys }),
  messagePopup: 'manual',
  setMessagePopup: (mode) => set({ messagePopup: mode }),
  messagePopupSeconds: 15,
  setMessagePopupSeconds: (seconds) => set({ messagePopupSeconds: seconds }),
  autoModeForChildSessions: false,
  setAutoModeForChildSessions: (value) => set({ autoModeForChildSessions: value }),
  autoModeForManualSessions: false,
  setAutoModeForManualSessions: (value) => set({ autoModeForManualSessions: value }),
  autoModeForRestoredSessions: false,
  setAutoModeForRestoredSessions: (value) => set({ autoModeForRestoredSessions: value }),
  ambientTodoNudge: false,
  setAmbientTodoNudge: (value) => set({ ambientTodoNudge: value }),
  injectSpinnerTips: false,
  setInjectSpinnerTips: (value) => set({ injectSpinnerTips: value }),
  memoryInjectionMode: 'off',
  setMemoryInjectionMode: (value) => set({ memoryInjectionMode: value }),
  memoryInjectionSessionCap: null,
  setMemoryInjectionSessionCap: (value) => set({ memoryInjectionSessionCap: value }),
  memoryInjectionThreshold: 'balanced',
  setMemoryInjectionThreshold: (value) => set({ memoryInjectionThreshold: value }),
  memoryInjections: {},
  handleMemoryInjected: (sessionId, entries) =>
    set((state) => {
      const existing = state.memoryInjections[sessionId] ?? []
      const known = new Set(existing.map((e) => e.filename))
      const merged = [...existing, ...entries.filter((e) => !known.has(e.filename))]
      return { memoryInjections: { ...state.memoryInjections, [sessionId]: merged } }
    }),
  memoryExpansion: null,
  openMemoryExpansion: (sessionId, filename, x, y) =>
    set({ memoryExpansion: { sessionId, filename, x, y } }),
  closeMemoryExpansion: () => set({ memoryExpansion: null }),
  canvasAutoShowUserImages: true,
  setCanvasAutoShowUserImages: (value) => set({ canvasAutoShowUserImages: value }),
  spawnIntoCurrentSplit: false,
  setSpawnIntoCurrentSplit: (value) => set({ spawnIntoCurrentSplit: value }),
  terminalPairingMode: 'off',
  setTerminalPairingMode: (value) => set({ terminalPairingMode: value }),
  turnExportFolder: null,
  setTurnExportFolder: (dir) => set({ turnExportFolder: dir }),
  turnShareDefaults: { ...defaultTurnShareDefaults },
  setTurnShareDefaults: (defaults) => set({ turnShareDefaults: defaults }),
  shareTurnSessionId: null,
  setShareTurnSessionId: (id) => set({ shareTurnSessionId: id }),
  openBranchInSplit: true,
  setOpenBranchInSplit: (value) => set({ openBranchInSplit: value }),
  archiveInactiveSessions: false,
  setArchiveInactiveSessions: (value) => set({ archiveInactiveSessions: value }),
  observerEnabled: false,
  setObserverEnabled: (value) => set({ observerEnabled: value }),
  archiveInactiveMinutes: 30,
  setArchiveInactiveMinutes: (value) => set({ archiveInactiveMinutes: Math.max(5, Math.round(value) || 5) }),
  archivePinnedSessionIds: [],
  setArchivePinned: (id, pinned) =>
    set((state) => ({
      archivePinnedSessionIds: pinned
        ? state.archivePinnedSessionIds.includes(id)
          ? state.archivePinnedSessionIds
          : [...state.archivePinnedSessionIds, id]
        : state.archivePinnedSessionIds.filter((x) => x !== id),
    })),

  pinnedAttachedTerminalIds: [],
  togglePinnedAttachedTerminal: (parentId) =>
    set((state) => ({
      pinnedAttachedTerminalIds: state.pinnedAttachedTerminalIds.includes(parentId)
        ? state.pinnedAttachedTerminalIds.filter((id) => id !== parentId)
        : [...state.pinnedAttachedTerminalIds, parentId],
    })),

  // Notes & todos
  todosSelectedTags: [],
  setTodosSelectedTags: (tags) => set({ todosSelectedTags: [...new Set(tags)] }),
  toggleTodosTag: (tag) => set((state) => ({
    todosSelectedTags: state.todosSelectedTags.includes(tag)
      ? state.todosSelectedTags.filter((t) => t !== tag)
      : [...state.todosSelectedTags, tag],
  })),
  todosSearch: '',
  setTodosSearch: (s) => set({ todosSearch: s }),
  todosShowCompleted: false,
  setTodosShowCompleted: (v) => set({ todosShowCompleted: v }),
  completedFilter: 'week',
  setCompletedFilter: (f) => set({ completedFilter: f }),
  todosSelectedId: null,
  setTodosSelectedId: (id) => set({ todosSelectedId: id }),
  todosSessionProjectTag: null,
  setTodosSessionProjectTag: (tag) => set({ todosSessionProjectTag: tag }),
  todosDetailWidth: 460,
  setTodosDetailWidth: (w) => set({ todosDetailWidth: Math.max(320, Math.min(1100, Math.round(w))) }),

  // Agentic pipeline. The main process owns the authoritative state
  // (pipeline-store.ts); these actions write through via IPC and the mirror is
  // refreshed by the 'pipeline:changed' broadcast (wired in App.tsx).
  pipelineTasks: [],
  pipelineDefaultAutonomy: 'gated',
  setPipelineDefaultAutonomy: (level) => set({ pipelineDefaultAutonomy: level }),
  setPipelineTasks: (tasks) => set({ pipelineTasks: tasks }),
  pipelineProjectFilter: null,
  setPipelineProjectFilter: (name) => set({ pipelineProjectFilter: name }),
  startPipelineTask: (todo) => {
    const state = get()
    // Resolve the project directory the orchestrator should run in, from the
    // todo's project: tag — prefer an open session for that project, else
    // baseProjectsDir/<name>. Main falls back to baseProjectsDir/home if unset.
    const projectTag = todo.tags.find((t) => t.startsWith('project:'))
    const name = projectTag ? projectTag.slice('project:'.length) : null
    let projectPath: string | undefined
    if (name) {
      const match = state.sessions.find((s) => s.projectName === name)
      projectPath = match?.projectPath ?? (state.baseProjectsDir ? `${state.baseProjectsDir}/${name}` : undefined)
    }
    if (!projectPath) projectPath = state.baseProjectsDir ?? undefined
    void window.api.pipelineStart(todo, state.pipelineDefaultAutonomy, projectPath)
  },
  startPipelineReview: (todo, diffSource) => {
    const state = get()
    // Same projectPath derivation as startPipelineTask — the repo holding the
    // changes is where the orchestrator (and, for working-tree, the diff) lives.
    const projectTag = todo.tags.find((t) => t.startsWith('project:'))
    const name = projectTag ? projectTag.slice('project:'.length) : null
    let projectPath: string | undefined
    if (name) {
      const match = state.sessions.find((s) => s.projectName === name)
      projectPath = match?.projectPath ?? (state.baseProjectsDir ? `${state.baseProjectsDir}/${name}` : undefined)
    }
    if (!projectPath) projectPath = state.baseProjectsDir ?? undefined
    void window.api.pipelineStartReview(todo, state.pipelineDefaultAutonomy, diffSource, projectPath)
  },
  setPipelineStage: (id, stage) => window.api.pipelineSetStage(id, stage) as Promise<PipelineTask[]>,
  setPipelineAutonomy: (id, level) => { void window.api.pipelineSetAutonomy(id, level) },
  resolvePipelineGate: (id, approve) => window.api.pipelineResolveGate(id, approve) as Promise<PipelineTask[]>,
  removePipelineTask: (id) => { void window.api.pipelineRemove(id) },
  pausePipelineTask: (id) => { void window.api.pipelinePause(id) },
  resumePipelineTask: (id) => { void window.api.pipelineResume(id) },

  // Scheduled tasks. Main process owns authoritative state (schedule-store.ts);
  // these write through via IPC and the mirror is refreshed by the
  // 'schedules:changed' broadcast (wired in App.tsx). Mirrors the pipeline block.
  scheduledTasks: [],
  setScheduledTasks: (tasks) => set({ scheduledTasks: tasks }),
  createScheduledTask: (data) => window.api.schedulesCreate(data) as Promise<ScheduledTask>,
  updateScheduledTask: (id, patch) => { void window.api.schedulesUpdate(id, patch) },
  deleteScheduledTask: (id) => { void window.api.schedulesDelete(id) },
  setScheduledTaskEnabled: (id, enabled) => { void window.api.schedulesSetEnabled(id, enabled) },
  runScheduledTaskNow: (id) => window.api.schedulesRunNow(id),

  // GitHub integration
  githubItems: [],
  setGithubItems: (items) => set({ githubItems: items }),
  githubStatus: null,
  setGithubStatus: (status) => set({ githubStatus: status }),
  githubAuthLost: false,
  setGithubAuthLost: (lost) => set({ githubAuthLost: lost }),
  adoptGithubSession: (sessionId) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, isGithub: false } : s)),
    })),
  githubStateFilter: 'active',
  setGithubStateFilter: (f) => set({ githubStateFilter: f }),
  githubRangeFilter: 'week',
  setGithubRangeFilter: (f) => set({ githubRangeFilter: f }),
  githubAutoReview: { ...defaultGithubAutoReview },
  setGithubAutoReview: (rules) => set({ githubAutoReview: rules }),
  githubReviewModel: '',
  setGithubReviewModel: (model) => set({ githubReviewModel: model }),

  // Canvas
  canvasArtifacts: [],
  setCanvasArtifacts: (artifacts) => set({ canvasArtifacts: artifacts }),
  openCanvasSessionIds: [],
  openCanvas: (sessionId) =>
    set((state) => ({
      openCanvasSessionIds: state.openCanvasSessionIds.includes(sessionId)
        ? state.openCanvasSessionIds
        : [...state.openCanvasSessionIds, sessionId],
    })),
  dismissCanvas: (sessionId) =>
    set((state) => ({
      openCanvasSessionIds: state.openCanvasSessionIds.filter((id) => id !== sessionId),
    })),
  canvasSelection: {},
  selectCanvasArtifact: (sessionId, artifactId) =>
    set((state) => ({
      canvasSelection: { ...state.canvasSelection, [sessionId]: artifactId },
    })),
  unseenCanvasSessionIds: [],
  markCanvasSeen: (sessionId) =>
    set((state) => ({
      unseenCanvasSessionIds: state.unseenCanvasSessionIds.filter((id) => id !== sessionId),
    })),
  handleCanvasEmitted: (artifact) =>
    set((state) => {
      // Visible right now → no unseen badge. Focused view shows one session;
      // split view shows every member pane of the active group.
      const visible =
        (state.viewMode === 'focused' && state.focusedSessionId === artifact.sessionId) ||
        (state.viewMode === 'split' &&
          !!state.activeSplitGroupId &&
          (state.splitGroups
            .find((g) => g.id === state.activeSplitGroupId)
            ?.orderedSessionIds.includes(artifact.sessionId) ?? false))
      return {
        // Upsert — the 'canvas:changed' full-list broadcast races this event.
        canvasArtifacts: [...state.canvasArtifacts.filter((a) => a.id !== artifact.id), artifact],
        openCanvasSessionIds: state.openCanvasSessionIds.includes(artifact.sessionId)
          ? state.openCanvasSessionIds
          : [...state.openCanvasSessionIds, artifact.sessionId],
        canvasSelection: { ...state.canvasSelection, [artifact.sessionId]: artifact.id },
        unseenCanvasSessionIds:
          visible || state.unseenCanvasSessionIds.includes(artifact.sessionId)
            ? state.unseenCanvasSessionIds
            : [...state.unseenCanvasSessionIds, artifact.sessionId],
      }
    }),
  handleCanvasFocus: (sessionId, artifactId) =>
    set((state) => ({
      openCanvasSessionIds: state.openCanvasSessionIds.includes(sessionId)
        ? state.openCanvasSessionIds
        : [...state.openCanvasSessionIds, sessionId],
      canvasSelection: { ...state.canvasSelection, [sessionId]: artifactId },
    })),

  // Observer / insights inbox
  observerInbox: null,
  setObserverInbox: (inbox) => set({ observerInbox: inbox }),
  refreshObserverInbox: async () => {
    const inbox = await window.api.observerInbox().catch(() => null)
    if (inbox) set({ observerInbox: inbox as ObserverInbox })
  },
  acceptSuggestion: async (id) => {
    const result = await window.api.observerAccept(id)
    await get().refreshObserverInbox()
    return result
  },
  dismissSuggestion: async (id, forever) => {
    const result = await window.api.observerDismiss(id, forever)
    await get().refreshObserverInbox()
    return result
  },
  runObserverJob: (jobId) => window.api.observerRunJob(jobId),

  // Sessions overview
  registryEntries: [],
  setRegistryEntries: (entries) => set({ registryEntries: entries }),
  killRegistrySession: (id) => window.api.registryKill(id),

  // Message notifications
  pendingMessages: [],
  addMessageNotification: (msg) =>
    set((state) => ({
      pendingMessages: [
        {
          id: crypto.randomUUID(),
          ...msg,
          receivedAt: Date.now(),
          dismissed: false,
          expanded: false,
          timerRemainingMs: null,
        },
        ...state.pendingMessages,
      ],
    })),
  dismissMessage: (id) => {
    set((state) => ({
      pendingMessages: state.pendingMessages.map((m) =>
        m.id === id ? { ...m, dismissed: true } : m
      ),
    }))
    // Prune after exit animation completes
    setTimeout(() => {
      set((state) => ({
        pendingMessages: state.pendingMessages.filter((m) => m.id !== id),
      }))
    }, 500)
  },
  toggleMessageExpanded: (id) =>
    set((state) => ({
      pendingMessages: state.pendingMessages.map((m) =>
        m.id === id ? { ...m, expanded: !m.expanded } : m
      ),
    })),
  updateMessageTimer: (id, remainingMs) =>
    set((state) => ({
      pendingMessages: state.pendingMessages.map((m) =>
        m.id === id ? { ...m, timerRemainingMs: remainingMs } : m
      ),
    })),
}))
