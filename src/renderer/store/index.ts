import { create } from 'zustand'

export type ViewMode = 'graph' | 'focused'

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
  toggleMemory: 'm'
}

export type ActivePanel = 'explorer' | 'agents' | 'skills' | 'design' | 'memory' | null

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
  createdAt: number
}

export interface AppState {
  // Sessions
  sessions: Session[]
  addSession: (id: string, projectPath: string) => void
  removeSession: (id: string) => void
  updateSessionStatus: (id: string, status: SessionStatus) => void
  markSessionSeen: (id: string) => void
  updateSessionSnapshot: (id: string, snapshot: HTMLCanvasElement) => void
  updateSessionTitle: (id: string, title: string) => void

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

  // Settings
  baseProjectsDir: string | null
  setBaseProjectsDir: (dir: string) => void
  autoFocusOnSpawn: boolean
  setAutoFocusOnSpawn: (value: boolean) => void
  persistExplorerPath: boolean
  setPersistExplorerPath: (value: boolean) => void
  explorerFollowsProject: boolean
  setExplorerFollowsProject: (value: boolean) => void
  hotkeys: HotkeyMap
  setHotkeys: (hotkeys: HotkeyMap) => void
  messagePopup: MessagePopupMode
  setMessagePopup: (mode: MessagePopupMode) => void
  messagePopupSeconds: number
  setMessagePopupSeconds: (seconds: number) => void

  // Message notifications
  pendingMessages: MessageNotification[]
  addMessageNotification: (msg: { targetSessionId: string; fromSessionId: string | null; message: string }) => void
  dismissMessage: (id: string) => void
  toggleMessageExpanded: (id: string) => void
  updateMessageTimer: (id: string, remainingMs: number) => void
}

function projectNameFromPath(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).pop() || projectPath
}

export const useStore = create<AppState>((set) => ({
  // Sessions
  sessions: [],
  addSession: (id, projectPath) =>
    set((state) => ({
      sessions: [
        ...state.sessions,
        {
          id,
          projectPath,
          projectName: projectNameFromPath(projectPath),
          terminalTitle: null,
          status: 'seen',
          snapshot: null,
          createdAt: Date.now()
        }
      ]
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
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, snapshot } : s))
    })),
  updateSessionTitle: (id, title) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, terminalTitle: title } : s))
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

  // Settings
  baseProjectsDir: null,
  setBaseProjectsDir: (dir) => set({ baseProjectsDir: dir }),
  autoFocusOnSpawn: true,
  setAutoFocusOnSpawn: (value) => set({ autoFocusOnSpawn: value }),
  persistExplorerPath: true,
  setPersistExplorerPath: (value) => set({ persistExplorerPath: value }),
  explorerFollowsProject: true,
  setExplorerFollowsProject: (value) => set({ explorerFollowsProject: value }),
  hotkeys: { ...defaultHotkeys },
  setHotkeys: (hotkeys) => set({ hotkeys }),
  messagePopup: 'manual',
  setMessagePopup: (mode) => set({ messagePopup: mode }),
  messagePopupSeconds: 15,
  setMessagePopupSeconds: (seconds) => set({ messagePopupSeconds: seconds }),

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
