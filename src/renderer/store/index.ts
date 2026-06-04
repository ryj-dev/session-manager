import { create } from 'zustand'
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

export interface HotkeyMap {
  spawnSession: string
  spawnTerminal: string
  returnToGraph: string
  toggleExplorer: string
  toggleAgents: string
  toggleSkills: string
  toggleDesign: string
  openSettings: string
  toggleMemory: string
  toggleNotesProject: string
  toggleNotesGlobal: string
  copyFilePath: string
}

export const defaultHotkeys: HotkeyMap = {
  spawnSession: 't',
  spawnTerminal: 'shift+t',
  returnToGraph: 'w',
  toggleExplorer: 'e',
  toggleAgents: 'a',
  toggleSkills: 's',
  toggleDesign: 'd',
  openSettings: 'o',
  toggleMemory: 'm',
  toggleNotesProject: 'n',
  toggleNotesGlobal: 'shift+n',
  // Mac: Cmd+Opt+C. Windows: Alt+Shift+C (Alt is the base app modifier on Windows,
  // so 'alt' isn't expressible as an extra; use shift instead).
  copyFilePath: typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac') ? 'alt+c' : 'shift+c',
}

export type ActivePanel = 'explorer' | 'agents' | 'skills' | 'design' | 'memory' | 'notes' | null


export type SessionStatus = 'working' | 'permission' | 'finished' | 'seen' | 'exited'

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
  /** For Claude sessions with `terminalPairingMode === 'overlay'`: the id of the hidden
   *  terminal session attached to this one. Null on attached sessions and on
   *  Claude sessions without an attachment. */
  attachedTerminalId: string | null
}

export interface AppState {
  // Sessions
  sessions: Session[]
  addSession: (id: string, projectPath: string, claudeSessionId?: string | null, opts?: { isAttached?: boolean }) => void
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
  spawnIntoCurrentSplit: boolean
  setSpawnIntoCurrentSplit: (value: boolean) => void
  /** How spawned Claude sessions are paired with a shell. Mutually exclusive. */
  terminalPairingMode: 'off' | 'split' | 'overlay'
  setTerminalPairingMode: (value: 'off' | 'split' | 'overlay') => void

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
  todosSelectedId: string | null
  setTodosSelectedId: (id: string | null) => void
  /** Session-project tag auto-applied when the panel is opened from a session (e.g. `project:session-manager`). */
  todosSessionProjectTag: string | null
  setTodosSessionProjectTag: (tag: string | null) => void
  /** Persisted width (px) of the todo detail pane when a todo is selected. */
  todosDetailWidth: number
  setTodosDetailWidth: (w: number) => void

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

export const useStore = create<AppState>((set) => ({
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
            attachedTerminalId: null,
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
      focusedSessionId: state.focusedSessionId === id ? null : state.focusedSessionId
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
    set((state) => ({
      splitGroups: state.splitGroups.filter((g) => g.id !== groupId),
      activeSplitGroupId: state.activeSplitGroupId === groupId ? null : state.activeSplitGroupId,
    })),
  enterSplitGroup: (groupId) =>
    set({ activeSplitGroupId: groupId, viewMode: 'split', focusedSessionId: null }),
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
  spawnIntoCurrentSplit: false,
  setSpawnIntoCurrentSplit: (value) => set({ spawnIntoCurrentSplit: value }),
  terminalPairingMode: 'off',
  setTerminalPairingMode: (value) => set({ terminalPairingMode: value }),

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
  todosSelectedId: null,
  setTodosSelectedId: (id) => set({ todosSelectedId: id }),
  todosSessionProjectTag: null,
  setTodosSessionProjectTag: (tag) => set({ todosSessionProjectTag: tag }),
  todosDetailWidth: 460,
  setTodosDetailWidth: (w) => set({ todosDetailWidth: Math.max(320, Math.min(1100, Math.round(w))) }),

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
