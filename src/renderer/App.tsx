import { useEffect, useCallback, useRef, useState } from 'react'
import { useStore, defaultHotkeys, type HotkeyMap } from './store'
import { defaultShapeFor } from './lib/splitLayouts'
import { formatHotkey, comboFromEvent } from './lib/hotkeys'
import { GraphView } from './components/GraphView'
import { FileExplorer } from './components/FileExplorer'
import { Settings } from './components/Settings'
import { KeyboardShortcuts } from './components/KeyboardShortcuts'
import { StatuslineEditor } from './components/StatuslineEditor'
import { CleanupPanel } from './components/CleanupPanel'
import { SplitView } from './components/SplitView'
import { SplitArrangementModal } from './components/SplitArrangementModal'
import { SidebarPicker } from './components/SidebarPicker'
import { DesignGallery } from './components/DesignGallery'
import { AgentGallery } from './components/AgentGallery'
import { SkillsGallery } from './components/SkillsGallery'
import MemoryPanel from './components/memory/MemoryPanel'
import { NotesPanel } from './components/notes/NotesPanel'
import { MessagePopup } from './components/MessagePopup'
import { AttachedTerminalOverlay, PINNED_WIDTH_PCT } from './components/AttachedTerminalOverlay'
import { getTerminalCanvas, disposeTerminal, focusTerminal, onTerminalReady, clearTerminalReady } from './components/Terminal'
import { Terminal } from './components/Terminal'
import { useDesigns } from './hooks/useDesigns'
import { useAgents } from './hooks/useAgents'
import { useSkills } from './hooks/useSkills'

/** Returns true if a terminal title is a default/empty Claude session title. */
function isDefaultTitle(titleClean: string): boolean {
  if (titleClean === '') return true
  const lower = titleClean.toLowerCase()
  if (['claude code', 'claude'].includes(lower)) return true
  // Windows sets the title to the full executable path (e.g. C:\Users\ry\.local\bin\claude.exe)
  if (lower.endsWith('claude.exe') || lower.endsWith('claude')) return true
  return false
}

// Snapshot capture interval
const SNAPSHOT_INTERVAL_ACTIVE = 500
const SNAPSHOT_INTERVAL_IDLE = 3000
const IDLE_THRESHOLD = 5000
// Delay applied after a working→finished status hook before re-capturing the
// thumbnail. Gives the terminal a beat to paint the post-finish output (prompt
// return, finished banner) — without it the snapshot freezes on the working
// frame because the capture loop short-circuits once status is finished.
const POST_FINISH_PAINT_DELAY_MS = 220

// Thumbnail CSS dimensions (must match SessionNode THUMB_WIDTH/THUMB_HEIGHT)
const THUMB_W = 192
const THUMB_H = 120
// Snapshot quality multiplier — higher than dpr for extra sharpness at viewport zoom.
// 3x gives crisp text at up to 1.5x viewport zoom on Retina displays.
// Memory per snapshot: 576×360×4 ≈ 830KB (vs ~1.5MB before).
const SNAPSHOT_SCALE = 3



interface SavedSessionInfo {
  claudeSessionId: string
  projectPath: string
  terminalTitle: string | null
  savedAt: number
}

export function App(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const viewMode = useStore((s) => s.viewMode)
  const setViewMode = useStore((s) => s.setViewMode)
  const focusedSessionId = useStore((s) => s.focusedSessionId)
  const setFocusedSessionId = useStore((s) => s.setFocusedSessionId)
  const addSession = useStore((s) => s.addSession)
  const removeSession = useStore((s) => s.removeSession)
  const updateSessionStatus = useStore((s) => s.updateSessionStatus)
  const updateSessionSnapshot = useStore((s) => s.updateSessionSnapshot)
  const updateSessionTitle = useStore((s) => s.updateSessionTitle)
  const markSessionSeen = useStore((s) => s.markSessionSeen)
  const autoFocusOnSpawn = useStore((s) => s.autoFocusOnSpawn)
  const setAutoFocusOnSpawn = useStore((s) => s.setAutoFocusOnSpawn)
  const baseProjectsDir = useStore((s) => s.baseProjectsDir)
  const setBaseProjectsDir = useStore((s) => s.setBaseProjectsDir)
  const persistExplorerPath = useStore((s) => s.persistExplorerPath)
  const setPersistExplorerPath = useStore((s) => s.setPersistExplorerPath)
  const explorerFollowsProject = useStore((s) => s.explorerFollowsProject)
  const setExplorerFollowsProject = useStore((s) => s.setExplorerFollowsProject)
  const hotkeys = useStore((s) => s.hotkeys)
  const setHotkeys = useStore((s) => s.setHotkeys)
  const messagePopup = useStore((s) => s.messagePopup)
  const setMessagePopup = useStore((s) => s.setMessagePopup)
  const messagePopupSeconds = useStore((s) => s.messagePopupSeconds)
  const setMessagePopupSeconds = useStore((s) => s.setMessagePopupSeconds)
  const autoModeForChildSessions = useStore((s) => s.autoModeForChildSessions)
  const setAutoModeForChildSessions = useStore((s) => s.setAutoModeForChildSessions)
  const autoModeForManualSessions = useStore((s) => s.autoModeForManualSessions)
  const setAutoModeForManualSessions = useStore((s) => s.setAutoModeForManualSessions)
  const autoModeForRestoredSessions = useStore((s) => s.autoModeForRestoredSessions)
  const setAutoModeForRestoredSessions = useStore((s) => s.setAutoModeForRestoredSessions)
  const ambientTodoNudge = useStore((s) => s.ambientTodoNudge)
  const setAmbientTodoNudge = useStore((s) => s.setAmbientTodoNudge)
  const spawnIntoCurrentSplit = useStore((s) => s.spawnIntoCurrentSplit)
  const setSpawnIntoCurrentSplit = useStore((s) => s.setSpawnIntoCurrentSplit)
  const terminalPairingMode = useStore((s) => s.terminalPairingMode)
  const setTerminalPairingMode = useStore((s) => s.setTerminalPairingMode)
  const setAttachedTerminal = useStore((s) => s.setAttachedTerminal)
  const createSplitGroup = useStore((s) => s.createSplitGroup)
  const enterSplitGroup = useStore((s) => s.enterSplitGroup)
  const updateSplitGroupMembers = useStore((s) => s.updateSplitGroupMembers)
  const updateSplitGroupShape = useStore((s) => s.updateSplitGroupShape)
  const todosShowCompleted = useStore((s) => s.todosShowCompleted)
  const todosSelectedTags = useStore((s) => s.todosSelectedTags)
  const todosDetailWidth = useStore((s) => s.todosDetailWidth)
  const addMessageNotification = useStore((s) => s.addMessageNotification)
  const selectedIndex = useStore((s) => s.selectedSessionIndex)
  const setSelectedIndex = useStore((s) => s.setSelectedSessionIndex)
  const splitGroups = useStore((s) => s.splitGroups)
  const activeSplitGroupId = useStore((s) => s.activeSplitGroupId)
  const pinnedAttachedTerminalIds = useStore((s) => s.pinnedAttachedTerminalIds)

  // Panel data
  const { items: designItems } = useDesigns()
  const { items: agentItems } = useAgents()
  const { items: skillItems } = useSkills()

  // Track last data received per session for idle detection
  const lastDataRef = useRef<Map<string, number>>(new Map())
  // Sessions we've already registered a first-snapshot listener for
  const firstSnapshotSubs = useRef<Set<string>>(new Set())
  // Reuse offscreen canvases for snapshot capture to avoid GC churn
  const snapshotCanvases = useRef<Map<string, HTMLCanvasElement>>(new Map())
  // Pending post-finished re-capture timers, keyed by session id
  const postFinishTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Panel state
  const activePanel = useStore((s) => s.activePanel)
  const setActivePanel = useStore((s) => s.setActivePanel)
  const explorerCurrentPath = useRef<string>('')

  // Settings
  const [showSettings, setShowSettings] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showStatusline, setShowStatusline] = useState(false)
  const [showCleanup, setShowCleanup] = useState(false)

  // Saved sessions restore prompt
  const [savedSessions, setSavedSessions] = useState<SavedSessionInfo[]>([])
  const [showRestorePrompt, setShowRestorePrompt] = useState(false)

  // Load persisted settings on startup
  const settingsLoadedRef = useRef(false)
  useEffect(() => {
    window.api.loadSettings().then((settings: Record<string, unknown>) => {
      if (settings.baseProjectsDir) setBaseProjectsDir(settings.baseProjectsDir as string)
      setAutoFocusOnSpawn(settings.autoFocusOnSpawn as boolean)
      setPersistExplorerPath(settings.persistExplorerPath as boolean)
      setExplorerFollowsProject(settings.explorerFollowsProject as boolean)
      if (settings.hotkeys) setHotkeys({ ...defaultHotkeys, ...settings.hotkeys } as HotkeyMap)
      if (settings.messagePopup) setMessagePopup(settings.messagePopup as 'manual' | 'timed' | 'disabled')
      if (settings.messagePopupSeconds != null) setMessagePopupSeconds(settings.messagePopupSeconds as number)
      if (typeof settings.autoModeForChildSessions === 'boolean') setAutoModeForChildSessions(settings.autoModeForChildSessions)
      if (typeof settings.autoModeForManualSessions === 'boolean') setAutoModeForManualSessions(settings.autoModeForManualSessions)
      if (typeof settings.autoModeForRestoredSessions === 'boolean') setAutoModeForRestoredSessions(settings.autoModeForRestoredSessions)
      if (typeof settings.ambientTodoNudge === 'boolean') setAmbientTodoNudge(settings.ambientTodoNudge)
      if (typeof settings.spawnIntoCurrentSplit === 'boolean') setSpawnIntoCurrentSplit(settings.spawnIntoCurrentSplit)
      if (settings.terminalPairingMode === 'off' || settings.terminalPairingMode === 'split' || settings.terminalPairingMode === 'overlay') {
        setTerminalPairingMode(settings.terminalPairingMode)
      }
      if (typeof settings.todosShowCompleted === 'boolean') useStore.getState().setTodosShowCompleted(settings.todosShowCompleted)
      if (Array.isArray(settings.todosSelectedTags)) useStore.getState().setTodosSelectedTags(settings.todosSelectedTags as string[])
      if (typeof settings.todosDetailWidth === 'number') useStore.getState().setTodosDetailWidth(settings.todosDetailWidth)
      settingsLoadedRef.current = true
    })
  }, [])

  // Persist settings whenever they change (only after initial load to avoid overwriting)
  useEffect(() => {
    if (!settingsLoadedRef.current) return
    window.api.saveSettings({ baseProjectsDir, autoFocusOnSpawn, persistExplorerPath, explorerFollowsProject, hotkeys: hotkeys as unknown as Record<string, string>, messagePopup, messagePopupSeconds, todosShowCompleted, todosSelectedTags, todosDetailWidth, autoModeForChildSessions, autoModeForManualSessions, autoModeForRestoredSessions, ambientTodoNudge, spawnIntoCurrentSplit, terminalPairingMode } as unknown as Parameters<typeof window.api.saveSettings>[0])
  }, [baseProjectsDir, autoFocusOnSpawn, persistExplorerPath, explorerFollowsProject, hotkeys, messagePopup, messagePopupSeconds, todosShowCompleted, todosSelectedTags, todosDetailWidth, autoModeForChildSessions, autoModeForManualSessions, autoModeForRestoredSessions, ambientTodoNudge, spawnIntoCurrentSplit, terminalPairingMode])

  // Persist split groups whenever they change. Members are translated to
  // claudeSessionId so the file is meaningful across restarts. Groups
  // whose members lack a claudeSessionId (raw shells, not resumable) are
  // skipped — they couldn't be restored anyway.
  //
  // Skip empty-array writes until we've observed at least one non-empty
  // state. A one-shot "skip first fire" ref isn't enough: StrictMode's
  // dev-mode double mount-effect invocation (setup → cleanup → setup)
  // preserves refs, so the second invocation would clobber the persisted
  // file with [] before restoreSplitGroups has had a chance to rebuild
  // groups from disk.
  const hasSeenGroupsRef = useRef(false)
  const splitGroupsForPersist = useStore((s) => s.splitGroups)
  useEffect(() => {
    if (splitGroupsForPersist.length === 0 && !hasSeenGroupsRef.current) {
      return
    }
    if (splitGroupsForPersist.length > 0) {
      hasSeenGroupsRef.current = true
    }
    const state = useStore.getState()
    const cidById = new Map<string, string>()
    for (const s of state.sessions) {
      if (s.claudeSessionId) cidById.set(s.id, s.claudeSessionId)
    }
    const out = splitGroupsForPersist
      .map((g) => ({
        id: g.id,
        shapeId: g.shapeId,
        claudeSessionIds: g.orderedSessionIds
          .map((id) => cidById.get(id))
          .filter((cid): cid is string => !!cid),
      }))
      .filter((g) => g.claudeSessionIds.length >= 2)
    window.api.saveSplitGroups(out)
  }, [splitGroupsForPersist])

  // On startup: reconnect to active PTY sessions (renderer crash recovery),
  // then check for saved sessions from a previous clean quit.
  useEffect(() => {
    // First, check if the main process has live PTY sessions we lost track of
    window.api.listActiveSessions().then((active) => {
      if (active.length > 0) {
        console.log(`[recovery] reconnecting to ${active.length} active PTY sessions`)
        for (const s of active) {
          addSession(s.id, s.projectPath, s.claudeSessionId)
          if (s.terminalTitle) {
            updateSessionTitle(s.id, s.terminalTitle)
          }
        }

        // Force screen redraws so recovered terminals aren't blank.
        // After renderer crash, new xterm instances have no scrollback.
        // Nudging the PTY size triggers SIGWINCH → the running process redraws.
        // Once it renders, the onTerminalReady effect captures the snapshot.
        setTimeout(() => {
          for (const s of active) {
            window.api.resizeSession(s.id, 119, 30)
          }
          setTimeout(() => {
            for (const s of active) {
              window.api.resizeSession(s.id, 120, 30)
            }
          }, 50)
        }, 500)

        // Active sessions found — skip the saved-sessions restore prompt.
        // Composite groups were lost when the renderer crashed; rebuild
        // them from the persisted disk state by mapping claudeSessionIds.
        restoreSplitGroups()
        return
      }

      // No active sessions — check for saved sessions from a previous clean quit
      window.api.loadSavedSessions().then((saved) => {
        if (saved.length > 0) {
          setSavedSessions(saved)
          setShowRestorePrompt(true)
        }
      })
    })
  }, [])

  // Reconstruct composite/split-view groups from disk. Maps each saved
  // claudeSessionId to the current PTY session.id and drops members no
  // longer present. A group with <2 surviving members is dropped entirely
  // (mirrors the design's "drop empties, don't restore-then-dissolve" rule).
  const restoreSplitGroups = useCallback(async () => {
    const saved = await window.api.loadSplitGroups().catch(() => [])
    if (!saved || saved.length === 0) return
    const state = useStore.getState()
    if (state.splitGroups.length > 0) return // already reconstructed this run
    const byClaudeId = new Map<string, string>()
    for (const s of state.sessions) {
      if (s.claudeSessionId) byClaudeId.set(s.claudeSessionId, s.id)
    }
    for (const g of saved) {
      const members = g.claudeSessionIds
        .map((cid) => byClaudeId.get(cid))
        .filter((id): id is string => !!id)
      if (members.length < 2) continue
      state.createSplitGroup(members, g.shapeId ?? null)
    }
  }, [])

  // Resume saved sessions
  const restoreSessions = useCallback(async () => {
    for (const saved of savedSessions) {
      const result = await window.api.resumeSession(saved.claudeSessionId, saved.projectPath, autoModeForRestoredSessions)
      addSession(result.id, result.projectPath, result.claudeSessionId ?? saved.claudeSessionId)
      if (saved.terminalTitle) {
        updateSessionTitle(result.id, saved.terminalTitle)
        window.api.updateSessionTitle(result.id, saved.terminalTitle)
      }
    }
    await window.api.clearSavedSessions()
    setSavedSessions([])
    setShowRestorePrompt(false)
    // Now that all sessions are in the store, rebuild any composite groups.
    await restoreSplitGroups()
  }, [savedSessions, addSession, updateSessionTitle, restoreSplitGroups, autoModeForRestoredSessions])

  // Update title in both renderer store and main process
  const handleTitleChange = useCallback(
    (id: string, title: string) => {
      const titleClean = title.replace(/[✳*\u2800-\u28FF]\s*/g, '').trim()
      if (isDefaultTitle(titleClean)) {
        // Don't overwrite a real title with a default one
        const current = useStore.getState().sessions.find((s) => s.id === id)?.terminalTitle
        const currentClean = current?.replace(/[✳*\u2800-\u28FF]\s*/g, '').trim() ?? ''
        if (!isDefaultTitle(currentClean)) return
      }
      updateSessionTitle(id, title)
      window.api.updateSessionTitle(id, title)
    },
    [updateSessionTitle]
  )

  // Dismiss saved sessions
  const dismissSaved = useCallback(async () => {
    await window.api.clearSavedSessions()
    setSavedSessions([])
    setShowRestorePrompt(false)
  }, [])

  // Resolve the best project path for spawning.
  // Prefer the focused session's project (what the user is looking at) over the
  // keyboard-selected index, so spawning from inside a session uses the right project.
  const resolveProjectPath = useCallback(async (cwd?: string): Promise<string> => {
    if (cwd) return cwd
    const focused = focusedSessionId ? sessions.find((s) => s.id === focusedSessionId) : null
    const fromSession = focused?.projectPath ?? sessions[selectedIndex]?.projectPath
    if (fromSession) return fromSession
    return baseProjectsDir || (await window.api.getHomeDir())
  }, [sessions, selectedIndex, focusedSessionId, baseProjectsDir])

  // Add a freshly-spawned session to the active split group (or create one).
  // Returns true if the session was absorbed into a split — callers should skip
  // their normal focus path when this returns true.
  const addToCurrentSplitIfActive = useCallback(
    (newId: string): boolean => {
      const state = useStore.getState()
      if (state.viewMode !== 'split' || !state.activeSplitGroupId) return false
      const group = state.splitGroups.find((g) => g.id === state.activeSplitGroupId)
      if (!group) return false
      const newMembers = [...group.orderedSessionIds, newId]
      updateSplitGroupMembers(state.activeSplitGroupId, newMembers)
      const newShape = defaultShapeFor(newMembers.length)?.id ?? null
      if (newShape) updateSplitGroupShape(state.activeSplitGroupId, newShape)
      setFocusedSessionId(newId)
      return true
    },
    [updateSplitGroupMembers, updateSplitGroupShape, setFocusedSessionId]
  )

  // Spawn a new claude session
  const spawnSession = useCallback(
    async (cwd?: string) => {
      const projectPath = await resolveProjectPath(cwd)

      console.log('[spawn] calling api.spawnSession with path:', projectPath)
      const result = await window.api.spawnSession(projectPath, 'claude')
      console.log('[spawn] session created:', result)
      addSession(result.id, result.projectPath, result.claudeSessionId ?? null)

      // Feature 2 — spawn into current split. Takes precedence over pairing/attach.
      if (spawnIntoCurrentSplit && addToCurrentSplitIfActive(result.id)) {
        return
      }

      // Terminal pairing — single mutually-exclusive mode.
      if (terminalPairingMode === 'split') {
        const term = await window.api.spawnSession(projectPath, 'shell')
        addSession(term.id, term.projectPath)
        const groupId = createSplitGroup([result.id, term.id])
        enterSplitGroup(groupId)
        setFocusedSessionId(result.id)
        return
      }
      if (terminalPairingMode === 'overlay') {
        const term = await window.api.spawnSession(projectPath, 'shell')
        addSession(term.id, term.projectPath, null, { isAttached: true })
        setAttachedTerminal(result.id, term.id)
      }

      if (autoFocusOnSpawn) {
        setFocusedSessionId(result.id)
        setViewMode('focused')
      }
    },
    [resolveProjectPath, addSession, setFocusedSessionId, setViewMode, autoFocusOnSpawn, terminalPairingMode, spawnIntoCurrentSplit, createSplitGroup, enterSplitGroup, addToCurrentSplitIfActive, setAttachedTerminal]
  )

  // Spawn a plain terminal
  const spawnTerminal = useCallback(
    async (cwd?: string) => {
      const projectPath = await resolveProjectPath(cwd)

      // Pass 'shell' as a sentinel — main process resolves the actual shell binary
      const result = await window.api.spawnSession(projectPath, 'shell')
      addSession(result.id, result.projectPath)

      // Feature 2 — spawn into current split (terminals too).
      if (spawnIntoCurrentSplit && addToCurrentSplitIfActive(result.id)) {
        return
      }

      if (autoFocusOnSpawn) {
        setFocusedSessionId(result.id)
        setViewMode('focused')
      }
    },
    [resolveProjectPath, addSession, setFocusedSessionId, setViewMode, autoFocusOnSpawn, spawnIntoCurrentSplit, addToCurrentSplitIfActive]
  )

  // Handle spawning from file explorer
  const handleSpawnInDir = useCallback(
    (dir: string) => {
      explorerCurrentPath.current = dir
      spawnSession(dir)
      setActivePanel(null)
    },
    [spawnSession, setActivePanel]
  )

  // Spawn a new agent session (installed as slash command with --allowedTools)
  const handleSpawnAgent = useCallback(
    async (name: string, content: string, allowedTools?: string[]) => {
      const projectPath = await resolveProjectPath()
      const commandName = await window.api.installSkill(name, content)
      const result = await window.api.spawnSession(
        projectPath,
        'claude',
        [],
        allowedTools
      )
      addSession(result.id, result.projectPath)
      window.api.writeWhenReady(result.id, `/${commandName}\r`)
      setActivePanel(null)
    },
    [resolveProjectPath, addSession, setActivePanel]
  )

  // Spawn a new session with a skill (installed as a Claude Code slash command)
  const handleSpawnWithSkill = useCallback(
    async (skillName: string, content: string) => {
      const commandName = await window.api.installSkill(skillName, content)
      await spawnSession()
      const store = useStore.getState()
      const latestSession = store.sessions[store.sessions.length - 1]
      if (latestSession) {
        window.api.writeWhenReady(latestSession.id, `/${commandName}\r`)
      }
      setActivePanel(null)
    },
    [spawnSession, setActivePanel]
  )

  // Inject a skill into the focused session by restarting Claude Code
  const handleInjectSkill = useCallback(
    async (skillName: string, content: string) => {
      if (!focusedSessionId) return
      const session = sessions.find((s) => s.id === focusedSessionId)
      if (!session) return

      const info = await window.api.getClaudeSessionInfo(focusedSessionId)
      if (!info) return

      // Install the skill before restarting so the new process discovers it
      const commandName = await window.api.installSkill(skillName, content)

      // Tear down the old session
      window.api.killSession(focusedSessionId)
      disposeTerminal(focusedSessionId)
      removeSession(focusedSessionId)

      // If the session had real conversation history, resume it; otherwise start fresh
      let result
      if (info.isResumable && info.claudeSessionId) {
        result = await window.api.resumeSession(info.claudeSessionId, session.projectPath)
      } else {
        result = await window.api.spawnSession(session.projectPath, 'claude')
      }

      addSession(result.id, result.projectPath)
      if (session.terminalTitle) {
        updateSessionTitle(result.id, session.terminalTitle)
      }
      setFocusedSessionId(result.id)
      window.api.writeWhenReady(result.id, `/${commandName}\r`)
      setActivePanel(null)
    },
    [focusedSessionId, sessions, removeSession, addSession, updateSessionTitle, setFocusedSessionId, setActivePanel]
  )

  // Capture a single session's snapshot (reuses canvas to avoid GC churn)
  const captureSnapshot = useCallback((sessionId: string): void => {
    const canvas = getTerminalCanvas(sessionId)
    if (!canvas) return
    let thumb = snapshotCanvases.current.get(sessionId)
    if (!thumb) {
      thumb = document.createElement('canvas')
      snapshotCanvases.current.set(sessionId, thumb)
    }
    thumb.width = THUMB_W * SNAPSHOT_SCALE
    thumb.height = THUMB_H * SNAPSHOT_SCALE
    const ctx = thumb.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height)
    updateSessionSnapshot(sessionId, thumb)
  }, [updateSessionSnapshot])

  // Compute the best next selected index after removing a session.
  // Prefers another session in the same project; falls back to nearest neighbor.
  const selectNextAfterRemoval = useCallback(
    (sessionId: string) => {
      const current = useStore.getState()
      const { sessions: allSessions, selectedSessionIndex } = current
      const removedIdx = allSessions.findIndex((s) => s.id === sessionId)
      if (removedIdx === -1) return

      const removedSession = allSessions[removedIdx]
      const remaining = allSessions.filter((s) => s.id !== sessionId)
      if (remaining.length === 0) {
        setSelectedIndex(0)
        return
      }

      // Prefer next session in same project
      const sameProject = remaining.filter(
        (s) => s.projectPath === removedSession.projectPath
      )
      if (sameProject.length > 0) {
        // Pick the session that was closest after the removed one
        const target = sameProject[0]
        const newIdx = remaining.findIndex((s) => s.id === target.id)
        setSelectedIndex(newIdx)
        return
      }

      // No same-project sessions — clamp to valid range
      const newIdx = Math.min(selectedSessionIndex, remaining.length - 1)
      setSelectedIndex(Math.max(0, newIdx))
    },
    [setSelectedIndex]
  )

  // Force-close the focused pane inside a split view.
  // Removes the session from the active group and kills its PTY. If only one
  // member remains the group dissolves and the user is dropped into focused
  // view of the surviving session; with N>=2 left we stay in split and focus
  // the previous slot.
  const forceClosePaneInSplit = useCallback(
    (sessionId: string) => {
      const state = useStore.getState()
      const groupId = state.activeSplitGroupId
      const group = groupId ? state.splitGroups.find((g) => g.id === groupId) : null
      if (!group || !groupId) return

      const closedIdx = group.orderedSessionIds.indexOf(sessionId)
      if (closedIdx === -1) return
      const remaining = group.orderedSessionIds.filter((id) => id !== sessionId)

      // Tear down the PTY + terminal for the closed session.
      captureSnapshot(sessionId)
      window.api.killSession(sessionId)
      disposeTerminal(sessionId)
      removeSession(sessionId)
      snapshotCanvases.current.delete(sessionId)
      firstSnapshotSubs.current.delete(sessionId)
      clearTerminalReady(sessionId)
      const pendingFinish = postFinishTimers.current.get(sessionId)
      if (pendingFinish) {
        clearTimeout(pendingFinish)
        postFinishTimers.current.delete(sessionId)
      }

      if (remaining.length <= 1) {
        // Dissolve and switch to focused view of the surviving session (or graph if none).
        state.dissolveSplitGroup(groupId)
        const survivor = remaining[0]
        if (survivor) {
          setFocusedSessionId(survivor)
          setViewMode('focused')
        } else {
          setFocusedSessionId(null)
          setViewMode('graph')
        }
        return
      }

      // Update group members and shift focus to the previous slot (or slot 0).
      state.updateSplitGroupMembers(groupId, remaining)
      const nextIdx = Math.max(0, Math.min(closedIdx - 1, remaining.length - 1))
      const nextId = remaining[nextIdx]
      setFocusedSessionId(nextId ?? null)
      // Re-derive the default shape for the new N so the layout reflows.
      const newDefault = defaultShapeFor(remaining.length)?.id ?? null
      if (newDefault) state.updateSplitGroupShape(groupId, newDefault)
    },
    [captureSnapshot, removeSession, setFocusedSessionId, setViewMode]
  )

  // Force-close the focused session (kills PTY, returns to graph)
  // Tear down a single session (PTY, terminal, store) without touching focus/view state.
  // Used both for the primary close and to cascade-kill an attached overlay terminal.
  const teardownSession = useCallback((sessionId: string): void => {
    captureSnapshot(sessionId)
    window.api.killSession(sessionId)
    disposeTerminal(sessionId)
    removeSession(sessionId)
    snapshotCanvases.current.delete(sessionId)
    firstSnapshotSubs.current.delete(sessionId)
    clearTerminalReady(sessionId)
    const pendingFinish = postFinishTimers.current.get(sessionId)
    if (pendingFinish) {
      clearTimeout(pendingFinish)
      postFinishTimers.current.delete(sessionId)
    }
  }, [captureSnapshot, removeSession])

  const forceCloseSession = useCallback(
    (sessionId: string) => {
      // Cascade-kill any attached overlay terminal owned by this Claude session.
      const closing = useStore.getState().sessions.find((s) => s.id === sessionId)
      const attachedId = closing?.attachedTerminalId ?? null
      selectNextAfterRemoval(sessionId)
      teardownSession(sessionId)
      if (attachedId) teardownSession(attachedId)
      setFocusedSessionId(null)
      setViewMode('graph')
    },
    [selectNextAfterRemoval, teardownSession, setFocusedSessionId, setViewMode]
  )

  // Snapshot capture helper
  const captureAllSnapshots = useCallback(() => {
    for (const session of sessions) {
      captureSnapshot(session.id)
    }
  }, [sessions, captureSnapshot])

  // Global hotkeys
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      // Cancel any in-progress split-build selection on the first non-modifier
      // keydown while Cmd is held. We do this BEFORE per-hotkey processing so
      // cancel runs even for hotkeys that stopImmediatePropagation later.
      const splitState = useStore.getState()
      if (splitState.isCmdHeld) {
        const MOD_KEYS = ['Meta', 'Control', 'Alt', 'Shift', 'OS']
        if (!MOD_KEYS.includes(e.key)) {
          splitState.closeSplitModal()
          splitState.setCmdHeld(false)
          splitState.setExpandingExistingGroup(false)
          // Don't return — let the hotkey still process (e.g. Cmd+T spawn).
        }
      }

      // macOS: Cmd (metaKey) for app hotkeys — Ctrl passes through to terminal
      // Windows/Linux: Alt for app hotkeys — Ctrl passes through to terminal
      const isMac = navigator.platform.startsWith('Mac')
      const meta = isMac ? e.metaKey : e.altKey
      if (!meta) return

      // Build a normalized combo string using physical key codes
      // This avoids Opt+key producing special chars (e.g. opt+o → ø)
      const key = comboFromEvent(e)
      if (!key) return

      if (key === hotkeys.spawnSession) {
        e.preventDefault()
        if (activePanel === 'explorer' && explorerCurrentPath.current) {
          spawnSession(explorerCurrentPath.current).catch((err) =>
            console.error('[hotkey] spawn in explorer dir failed:', err)
          )
          setActivePanel(null)
        } else {
          spawnSession().catch((err) =>
            console.error('[hotkey] spawn failed:', err)
          )
        }
        return
      }

      if (key === hotkeys.spawnTerminal) {
        e.preventDefault()
        spawnTerminal()
        return
      }

      if (key === hotkeys.returnToGraph) {
        e.preventDefault()
        captureAllSnapshots()
        if (focusedSessionId) {
          markSessionSeen(focusedSessionId)
        }
        setActivePanel(null)
        setShowSettings(false)
        setShowShortcuts(false)
        setShowStatusline(false)
        setFocusedSessionId(null)
        setViewMode('graph')
        return
      }

      // Force-close session — works in focused view (closes focused), split view
      // (closes the focused pane; dissolves the group if only one remains),
      // and graph view (closes selected).
      if (key === 'shift+w') {
        if (viewMode === 'focused' && focusedSessionId) {
          e.preventDefault()
          forceCloseSession(focusedSessionId)
          return
        }
        if (viewMode === 'split' && focusedSessionId && activeSplitGroupId) {
          e.preventDefault()
          forceClosePaneInSplit(focusedSessionId)
          return
        }
        if (viewMode === 'graph' && sessions.length > 0) {
          e.preventDefault()
          const idx = Math.min(selectedIndex, sessions.length - 1)
          const session = sessions[idx]
          if (session) forceCloseSession(session.id)
          return
        }
      }

      // Panel toggles — mutually exclusive
      if (key === hotkeys.toggleExplorer) {
        e.preventDefault()
        setActivePanel(activePanel === 'explorer' ? null : 'explorer')
        return
      }

      if (key === hotkeys.toggleAgents) {
        // Bail when a real editable element is focused so Cmd+A performs native
        // select-all (notes panel, settings inputs, any textarea/contenteditable).
        // xterm.js uses a hidden <textarea class="xterm-helper-textarea"> for input;
        // that element lives inside .xterm so we exclude it from the bail-out so
        // Cmd+A still opens the agent sidebar when the terminal has focus.
        const ae = document.activeElement as HTMLElement | null
        const tag = ae?.tagName
        const isXtermInput = !!ae?.closest?.('.xterm')
        const isEditable =
          !!ae && (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable) && !isXtermInput
        if (isEditable) return
        e.preventDefault()
        e.stopImmediatePropagation()
        setActivePanel(activePanel === 'agents' ? null : 'agents')
        return
      }

      if (key === hotkeys.toggleSkills) {
        e.preventDefault()
        setActivePanel(activePanel === 'skills' ? null : 'skills')
        return
      }

      if (key === hotkeys.toggleDesign) {
        e.preventDefault()
        setActivePanel(activePanel === 'design' ? null : 'design')
        return
      }

      if (key === hotkeys.toggleMemory) {
        e.preventDefault()
        setActivePanel(activePanel === 'memory' ? null : 'memory')
        return
      }

      if (key === hotkeys.toggleNotesProject) {
        e.preventDefault()
        if (activePanel === 'notes') {
          setActivePanel(null)
        } else {
          const store = useStore.getState()
          // Only inherit project context when the user is actually inside a session,
          // not hovering one on the graph. focusedSessionId is the authoritative signal.
          const focused = store.focusedSessionId
            ? store.sessions.find((s) => s.id === store.focusedSessionId)
            : null
          const projectPath = focused?.projectPath ?? null
          if (projectPath) {
            window.api.todosProjectTagFromCwd(projectPath).then((projectTag) => {
              store.setTodosSessionProjectTag(projectTag)
              store.setTodosSelectedTags([projectTag])
              store.setTodosSelectedId(null)
              setActivePanel('notes')
            })
          } else {
            store.setTodosSessionProjectTag(null)
            store.setTodosSelectedTags([])
            store.setTodosSelectedId(null)
            setActivePanel('notes')
          }
        }
        return
      }

      if (key === hotkeys.toggleNotesGlobal) {
        e.preventDefault()
        const store = useStore.getState()
        store.setTodosSessionProjectTag(null)
        store.setTodosSelectedTags([])
        store.setTodosSelectedId(null)
        setActivePanel(activePanel === 'notes' ? null : 'notes')
        return
      }

      if (key === hotkeys.openSettings) {
        e.preventDefault()
        setShowSettings((prev) => !prev)
        return
      }

      // Quit app — on Mac this is handled natively by Cmd+Q via the menu;
      // on Windows/Linux there's no menu so we handle it here
      if (key === 'q') {
        e.preventDefault()
        window.close()
        return
      }
    }

    // Use capture phase so app hotkeys fire before native browser actions (e.g. Cmd+A select-all)
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [viewMode, activePanel, hotkeys, spawnSession, spawnTerminal, setViewMode, setActivePanel, setFocusedSessionId, autoFocusOnSpawn, captureAllSnapshots, markSessionSeen, focusedSessionId, forceCloseSession, forceClosePaneInSplit, activeSplitGroupId, sessions, selectedIndex])

  // Blur terminal when a panel opens so keyboard input goes to the panel
  useEffect(() => {
    if (activePanel) {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
    } else if (viewMode === 'focused' && focusedSessionId) {
      // Refocus terminal when panel closes
      focusTerminal(focusedSessionId)
    }
  }, [activePanel, viewMode, focusedSessionId])

  // Mark finished sessions as seen when user enters them
  useEffect(() => {
    if (viewMode === 'focused' && focusedSessionId) {
      markSessionSeen(focusedSessionId)
    }
  }, [viewMode, focusedSessionId, markSessionSeen])

  // Listen for PTY exits
  useEffect(() => {
    const unsubscribe = window.api.onPtyExit(({ id }) => {
      updateSessionStatus(id, 'exited')

      const store = useStore.getState()
      // Cascade an attached-terminal exit when its parent dies — and vice versa,
      // remove the binding if just the attached terminal exited so we don't try
      // to render it later.
      const exited = store.sessions.find((s) => s.id === id)
      const attachedId = exited?.attachedTerminalId ?? null
      if (attachedId) {
        teardownSession(attachedId)
      } else if (exited?.isAttached) {
        const parent = store.sessions.find((s) => s.attachedTerminalId === id)
        if (parent) setAttachedTerminal(parent.id, null)
      }
      const wasFocused = store.focusedSessionId === id && store.viewMode === 'focused'

      if (wasFocused) {
        // Brief pause so user can see Claude's exit/resume message
        setTimeout(() => {
          window.api.killSession(id)
          // Check focus BEFORE removeSession (which nulls focusedSessionId)
          const current = useStore.getState()
          const stillViewing = current.focusedSessionId === id
          selectNextAfterRemoval(id)
          removeSession(id)
          disposeTerminal(id)
          snapshotCanvases.current.delete(id)
          firstSnapshotSubs.current.delete(id)
          clearTerminalReady(id)
          const pendingFinish = postFinishTimers.current.get(id)
          if (pendingFinish) {
            clearTimeout(pendingFinish)
            postFinishTimers.current.delete(id)
          }
          if (stillViewing) {
            setFocusedSessionId(null)
            setViewMode('graph')
          }
        }, 500)
      } else {
        // Session exited while in graph view — just remove it
        window.api.killSession(id)
        selectNextAfterRemoval(id)
        removeSession(id)
        disposeTerminal(id)
        snapshotCanvases.current.delete(id)
        firstSnapshotSubs.current.delete(id)
        clearTerminalReady(id)
      }
    })
    return unsubscribe
  }, [updateSessionStatus, selectNextAfterRemoval, removeSession, setFocusedSessionId, setViewMode])

  // Listen for sessions spawned externally (via MCP)
  useEffect(() => {
    const unsubscribe = window.api.onSessionSpawned(({ id, projectPath, claudeSessionId }) => {
      addSession(id, projectPath, claudeSessionId ?? null)
    })
    return unsubscribe
  }, [addSession])

  // Track claudeSessionId updates so the renderer can use the stable ID for assignments
  useEffect(() => {
    const unsub = window.api.onSessionClaudeId(({ id, claudeSessionId }) => {
      useStore.getState().updateSessionClaudeId(id, claudeSessionId)
    })
    return unsub
  }, [])

  // Listen for inter-session messages
  useEffect(() => {
    const unsubscribe = window.api.onMessageReceived((data) => {
      addMessageNotification(data)
    })
    return unsubscribe
  }, [addMessageNotification])

  // Listen for Claude status changes from hooks
  useEffect(() => {
    const finishedCaptureTimers = postFinishTimers.current

    const unsubscribe = window.api.onClaudeStatus(({ id, status }) => {
      const store = useStore.getState()
      const session = store.sessions.find((s) => s.id === id)
      if (!session) return

      if (status === 'finished') {
        // If user is currently focused on this session, mark as seen immediately
        if (store.focusedSessionId === id && store.viewMode === 'focused') {
          updateSessionStatus(id, 'seen')
        } else {
          updateSessionStatus(id, 'finished')
        }
        // Capture once on the next frame, then again after a short delay: the
        // terminal usually paints the post-finish output (prompt return,
        // finished banner) within ~150-250ms of the status hook firing, and
        // the periodic capture loop short-circuits once status is finished,
        // so without this delayed re-capture the thumbnail freezes on the
        // pre-transition working frame. Coalesce repeat 'finished' events
        // so we don't stack timers.
        requestAnimationFrame(() => captureSnapshot(id))
        const prev = finishedCaptureTimers.get(id)
        if (prev) clearTimeout(prev)
        const handle = setTimeout(() => {
          finishedCaptureTimers.delete(id)
          captureSnapshot(id)
        }, POST_FINISH_PAINT_DELAY_MS)
        finishedCaptureTimers.set(id, handle)
      } else if (status === 'permission') {
        updateSessionStatus(id, 'permission')
        requestAnimationFrame(() => captureSnapshot(id))
      } else if (status === 'working') {
        // PreToolUse / UserPromptSubmit hook fired — Claude is actively working
        if (session.status !== 'working') {
          updateSessionStatus(id, 'working')
        }
      }
    })
    return () => {
      unsubscribe()
      for (const handle of finishedCaptureTimers.values()) clearTimeout(handle)
      finishedCaptureTimers.clear()
    }
  }, [updateSessionStatus, captureSnapshot])

  // Track last data time for idle detection
  useEffect(() => {
    const unsubscribe = window.api.onPtyActivity((id) => {
      lastDataRef.current.set(id, Date.now())
    })
    return unsubscribe
  }, [])

  // Capture the first snapshot the moment a terminal paints for the first time.
  // onTerminalReady fires from xterm's write callback — no timer guesswork, and
  // if the terminal is already rendered when we subscribe, it fires immediately.
  //
  // We subscribe regardless of whether the session already has a snapshot:
  // for large resumed sessions, the periodic capture loop can fire before any
  // PTY data has arrived and commit a frame of the empty terminal background.
  // Once data arrives and the terminal actually paints, this listener
  // overwrites that placeholder with the real frame. Gating on
  // firstSnapshotSubs (a Set we add to here) ensures we still only attach one
  // listener per session.
  useEffect(() => {
    for (const session of sessions) {
      if (firstSnapshotSubs.current.has(session.id)) continue
      firstSnapshotSubs.current.add(session.id)
      onTerminalReady(session.id, () => {
        requestAnimationFrame(() => captureSnapshot(session.id))
      })
    }
  }, [sessions, captureSnapshot])

  // Snapshot capture loop (only in graph view, only when sessions are active)
  useEffect(() => {
    if (viewMode !== 'graph') return

    const currentSessions = useStore.getState().sessions
    const hasActive = currentSessions.some(
      (s) => s.status !== 'finished' && s.status !== 'seen' && s.status !== 'exited'
    )
    if (!hasActive && currentSessions.every((s) => s.snapshot)) return

    const interval = setInterval(() => {
      const now = Date.now()
      const liveSessions = useStore.getState().sessions
      let anyActive = false

      for (const session of liveSessions) {
        // Skip idle sessions that already have a snapshot (hooks capture final snapshots on state change).
        // Keep capturing for sessions without a snapshot yet (waiting for WebGL to render).
        if (session.snapshot && (session.status === 'finished' || session.status === 'seen' || session.status === 'permission')) continue

        anyActive = true
        const lastData = lastDataRef.current.get(session.id) ?? 0
        const isIdle = now - lastData > IDLE_THRESHOLD
        const shouldCapture = !isIdle

        if (shouldCapture || now % SNAPSHOT_INTERVAL_IDLE < SNAPSHOT_INTERVAL_ACTIVE) {
          captureSnapshot(session.id)
        }
      }

      // Stop polling when all sessions are idle with snapshots
      if (!anyActive) clearInterval(interval)
    }, SNAPSHOT_INTERVAL_ACTIVE)

    return () => clearInterval(interval)
  }, [viewMode, sessions, captureSnapshot])

  const focusedSession = sessions.find((s) => s.id === focusedSessionId)

  return (
    <div className="h-full w-full relative bg-[#0a0a0a]">
      {/* Off-screen terminals — in-viewport so WebGL renders, hidden behind opaque UI layers.
          Split-view members are excluded since SplitView mounts them visibly itself
          (each xterm instance can only attach to one DOM node at a time). */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" style={{ zIndex: 0 }}>
        {sessions
          .filter((s) => {
            if (viewMode === 'focused' && s.id === focusedSessionId) return false
            // Attached overlay terminal of the currently focused Claude session is
            // mounted by AttachedTerminalOverlay itself — exclude it from the
            // hidden layer so xterm doesn't try to attach to two DOM nodes.
            if (viewMode === 'focused' && focusedSession?.attachedTerminalId === s.id) return false
            if (viewMode === 'split' && activeSplitGroupId) {
              const group = splitGroups.find((g) => g.id === activeSplitGroupId)
              if (group && group.orderedSessionIds.includes(s.id)) return false
            }
            return true
          })
          .map((session) => (
            <Terminal
              key={session.id}
              sessionId={session.id}
              visible={false}
              onTitleChange={(title) => handleTitleChange(session.id, title)}
            />
          ))}
      </div>

      {/* Graph View — opaque bg to cover the hidden terminal layer beneath */}
      {viewMode === 'graph' && (
        <div className="absolute inset-0 bg-[#0a0a0a]" style={{ zIndex: 1 }}>
          <GraphView />
        </div>
      )}

      {/* Split View */}
      {viewMode === 'split' && (
        <SplitView onTitleChange={handleTitleChange} />
      )}

      {/* Focused View — titlebar + terminal */}
      {viewMode === 'focused' && focusedSession && (
        <div className="absolute inset-0 z-20 flex flex-col bg-[#0a0a0a]">
          <div className={`h-10 flex items-center pr-4 border-b border-zinc-800/50 titlebar-drag shrink-0 ${navigator.platform.startsWith('Mac') ? 'pl-20' : 'pl-4'}`}>
            <div className="titlebar-no-drag flex items-center gap-2">
              {focusedSession.terminalTitle && (
                <>
                  <span className="text-xs text-zinc-300 font-medium">{focusedSession.terminalTitle}</span>
                  <span className="text-zinc-700">·</span>
                </>
              )}
              <span className="text-xs text-zinc-500 font-mono">{focusedSession.projectName}</span>
              <span className="text-zinc-700">·</span>
              <span className="text-xs text-zinc-600 font-mono truncate max-w-[300px]">
                {focusedSession.projectPath}
              </span>
            </div>
            <div className="ml-auto titlebar-no-drag flex items-center gap-3">
              <span className="text-[10px] text-zinc-600">{formatHotkey(hotkeys.returnToGraph)} to return</span>
              <button
                onClick={() => forceCloseSession(focusedSessionId!)}
                className="text-zinc-600 hover:text-zinc-400 transition-colors"
                title={`Close session (⌘⇧W)`}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
                </svg>
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0 relative">
            {/* When an attached terminal is pinned, the main Terminal shrinks to leave room
                for the side-by-side overlay panel. When unpinned (or no attachment), the
                main Terminal fills the body and the overlay (if any) floats over it. */}
            {(() => {
              const attachedId = focusedSession?.attachedTerminalId ?? null
              const isPinned = attachedId
                ? pinnedAttachedTerminalIds.includes(focusedSessionId!)
                : false
              return (
                <>
                  <div
                    className="absolute top-0 left-0 h-full"
                    style={{ width: isPinned ? `${100 - PINNED_WIDTH_PCT}%` : '100%' }}
                  >
                    <Terminal
                      key={`focused-${focusedSessionId}`}
                      sessionId={focusedSessionId!}
                      visible={true}
                      onTitleChange={(title) => handleTitleChange(focusedSessionId!, title)}
                    />
                  </div>
                  {attachedId && (
                    <AttachedTerminalOverlay
                      parentSessionId={focusedSessionId!}
                      attachedId={attachedId}
                    />
                  )}
                </>
              )
            })()}
            <MessagePopup focusedSessionId={focusedSessionId} />
          </div>
        </div>
      )}


      {/* Click-away backdrop — closes sidebar panels when clicking outside */}
      {activePanel && viewMode === 'focused' && (
        <div
          className="absolute inset-0 z-[25]"
          onClick={() => setActivePanel(null)}
        />
      )}

      {/* File explorer overlay */}
      <FileExplorer
        visible={activePanel === 'explorer'}
        initialPath={
          explorerFollowsProject && viewMode === 'focused' && focusedSession
            ? focusedSession.projectPath
            : undefined
        }
        persistPath={persistExplorerPath}
        onSpawnInDir={handleSpawnInDir}
        onClose={() => setActivePanel(null)}
        onPathChange={(path) => { explorerCurrentPath.current = path }}
      />

      {/* Design panel */}
      {activePanel === 'design' && viewMode === 'graph' && (
        <DesignGallery
          visible={true}
          items={designItems}
          onClose={() => setActivePanel(null)}
        />
      )}
      {activePanel === 'design' && viewMode === 'focused' && (
        <SidebarPicker
          visible={true}
          items={designItems}
          title="Design Systems"
          onSelect={(item) => item.content && handleInjectSkill(item.name, item.content)}
          onClose={() => setActivePanel(null)}
          renderItem={(item) => (
            <div className="flex items-center gap-2">
              <div
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: item.brandColor }}
              />
              <span className="truncate">{item.name}</span>
            </div>
          )}
        />
      )}

      {/* Agents panel — always spawns a new independent session */}
      {activePanel === 'agents' && viewMode !== 'focused' && (
        <AgentGallery
          visible={true}
          items={agentItems}
          onSpawn={handleSpawnAgent}
          onClose={() => setActivePanel(null)}
        />
      )}
      {activePanel === 'agents' && viewMode === 'focused' && (
        <SidebarPicker
          visible={true}
          items={agentItems}
          title="Agents"
          onSelect={(item) => item.content && handleSpawnAgent(item.name, item.content, item.allowedTools)}
          onClose={() => setActivePanel(null)}
        />
      )}

      {/* Skills panel */}
      {activePanel === 'skills' && viewMode === 'graph' && (
        <SkillsGallery
          visible={true}
          items={skillItems}
          onSpawn={(name, content) => handleSpawnWithSkill(name, content)}
          onClose={() => setActivePanel(null)}
        />
      )}
      {activePanel === 'skills' && viewMode === 'focused' && (
        <SidebarPicker
          visible={true}
          items={skillItems}
          title="Skills"
          onSelect={(item) => item.content && handleInjectSkill(item.name, item.content)}
          onClose={() => setActivePanel(null)}
        />
      )}

      {/* Memory panel */}
      <MemoryPanel
        visible={activePanel === 'memory'}
        onClose={() => setActivePanel(null)}
      />

      {/* Notes panel */}
      <NotesPanel
        visible={activePanel === 'notes'}
        onClose={() => setActivePanel(null)}
      />

      {/* Settings overlay */}
      <Settings visible={showSettings} onClose={() => setShowSettings(false)} onOpenShortcuts={() => setShowShortcuts(true)} onOpenStatusline={() => setShowStatusline(true)} onOpenCleanup={() => setShowCleanup(true)} />

      {/* Keyboard shortcuts page */}
      <KeyboardShortcuts visible={showShortcuts} onClose={() => setShowShortcuts(false)} />

      {/* Statusline editor page */}
      <StatuslineEditor
        visible={showStatusline}
        onClose={() => setShowStatusline(false)}
        onSpawn={(name, content) => handleSpawnWithSkill(name, content)}
      />

      {/* Cleanup & uninstall page */}
      <CleanupPanel visible={showCleanup} onClose={() => setShowCleanup(false)} />

      {/* Split arrangement modal */}
      <SplitArrangementModal />

      {/* Restore sessions prompt */}
      {showRestorePrompt && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
            <h2 className="text-sm font-medium text-zinc-200 mb-3">
              Restore previous sessions?
            </h2>
            <p className="text-xs text-zinc-500 mb-4">
              {savedSessions.length} Claude session{savedSessions.length !== 1 ? 's' : ''} from
              your last run can be resumed.
            </p>
            <div className="mb-4 max-h-40 overflow-y-auto">
              {savedSessions.map((s) => (
                <div
                  key={s.claudeSessionId}
                  className="flex items-center gap-2 py-1.5 text-xs"
                >
                  <span className="text-zinc-400 truncate">
                    {(() => {
                      const titleClean = s.terminalTitle?.replace(/[✳*\u2800-\u28FF]\s*/g, '').trim() ?? ''
                      return isDefaultTitle(titleClean)
                        ? s.projectPath.split(/[\\/]/).filter(Boolean).pop()
                        : s.terminalTitle
                    })()}
                  </span>
                  <span className="text-zinc-600 ml-auto">
                    {new Date(s.savedAt).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={restoreSessions}
                className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
              >
                Resume all
              </button>
              <button
                onClick={dismissSaved}
                className="flex-1 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium rounded-lg transition-colors"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
