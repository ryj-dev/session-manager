import { contextBridge, ipcRenderer } from 'electron'

export type PtySpawnResult = { id: string; projectPath: string; claudeSessionId?: string | null }
export type FsEntry = { name: string; path: string; isDirectory: boolean }
export type SavedSession = { claudeSessionId: string; projectPath: string; terminalTitle: string | null; savedAt: number }

/** Mirrors MemoryNote from memory/core.ts (preload can't import main process modules). */
export interface MemoryNote {
  filename: string
  title: string
  type: string
  tags: string[]
  date: string
  modified: string
  body: string
  rawBody: string
  wikilinks: string[]
}

/** Mirrors ShareableTurn from turn-parser.ts (preload can't import main process modules). */
export interface TurnFileDiff {
  filePath: string
  hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }>
}

export type TurnTimelineItem =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; arg: string; resultText: string | null; isEdit: boolean; diff?: TurnFileDiff }

export interface ShareableTurn {
  index: number
  timestamp: string
  endTimestamp: string | null
  promptText: string
  label: string
  resultText: string
  timeline: TurnTimelineItem[]
  diffs: TurnFileDiff[]
  interrupted: boolean
}

export interface MemoryIndexEntry {
  filename: string
  title: string
  type: string
  tags: string[]
  date: string
  wikilinks: string[]
}

const api = {
  // PTY operations
  spawnSession: (cwd: string, command?: string, args?: string[], allowedTools?: string[], autoMode?: boolean): Promise<PtySpawnResult> =>
    ipcRenderer.invoke('pty:spawn', { cwd, command, args, allowedTools, autoMode }),

  resumeSession: (claudeSessionId: string, projectPath: string, autoMode?: boolean, ephemeral?: boolean): Promise<PtySpawnResult> =>
    ipcRenderer.invoke('pty:resume', { claudeSessionId, projectPath, autoMode, ephemeral }),

  forkSession: (claudeSessionId: string, projectPath: string, autoMode?: boolean): Promise<PtySpawnResult> =>
    ipcRenderer.invoke('pty:fork', { claudeSessionId, projectPath, autoMode }),

  writeSession: (id: string, data: string): void =>
    ipcRenderer.send('pty:write', { id, data }),

  writeWhenReady: (id: string, data: string): void =>
    ipcRenderer.send('pty:writeWhenReady', { id, data }),

  resizeSession: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('pty:resize', { id, cols, rows }),

  killSession: (id: string): void =>
    ipcRenderer.send('pty:kill', { id }),

  updateSessionTitle: (id: string, title: string): void =>
    ipcRenderer.send('pty:title', { id, title }),

  // Session archiving — resume an archived session in place (same app session
  // id), pin/unpin a session against auto-archiving, and report which sessions
  // are on screen (visible sessions are never archived).
  archiveResume: (id: string): Promise<{ ok: boolean; alreadyLive?: boolean; error?: string }> =>
    ipcRenderer.invoke('archive:resume', id),

  archiveSetPinned: (id: string, pinned: boolean): Promise<boolean> =>
    ipcRenderer.invoke('archive:setPinned', id, pinned),

  archiveSetVisible: (ids: string[]): void =>
    ipcRenderer.send('archive:setVisible', ids),

  onSessionArchived: (callback: (data: { id: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string }) => callback(data)
    ipcRenderer.on('session:archived', handler)
    return (): void => { ipcRenderer.removeListener('session:archived', handler) }
  },

  onSessionWaking: (callback: (data: { id: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string }) => callback(data)
    ipcRenderer.on('session:waking', handler)
    return (): void => { ipcRenderer.removeListener('session:waking', handler) }
  },

  onSessionWoke: (callback: (data: { id: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string }) => callback(data)
    ipcRenderer.on('session:woke', handler)
    return (): void => { ipcRenderer.removeListener('session:woke', handler) }
  },

  getClaudeSessionInfo: (id: string): Promise<{ claudeSessionId: string | null; isResumable: boolean } | null> =>
    ipcRenderer.invoke('pty:claudeSessionInfo', { id }),

  listActiveSessions: (): Promise<Array<{
    id: string; projectPath: string; claudeSessionId: string | null
    terminalTitle: string | null; hasActivity: boolean
  }>> => ipcRenderer.invoke('pty:listActive'),

  onPtyData: (id: string, callback: (data: string) => void) => {
    const channel = `pty:data:${id}`
    const handler = (_event: Electron.IpcRendererEvent, data: string) => callback(data)
    ipcRenderer.on(channel, handler)
    return (): void => { ipcRenderer.removeListener(channel, handler) }
  },

  onPtyActivity: (callback: (id: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string) => callback(id)
    ipcRenderer.on('pty:activity', handler)
    return (): void => { ipcRenderer.removeListener('pty:activity', handler) }
  },

  onPtyExit: (callback: (data: { id: string; exitCode: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string; exitCode: number }) =>
      callback(data)
    ipcRenderer.on('pty:exit', handler)
    return (): void => { ipcRenderer.removeListener('pty:exit', handler) }
  },

  onClaudeStatus: (callback: (data: { id: string; status: string }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; status: string }
    ) => callback(data)
    ipcRenderer.on('claude:status', handler)
    return (): void => { ipcRenderer.removeListener('claude:status', handler) }
  },

  // Saved sessions
  loadSavedSessions: (): Promise<SavedSession[]> =>
    ipcRenderer.invoke('sessions:loadSaved'),

  clearSavedSessions: (): Promise<void> =>
    ipcRenderer.invoke('sessions:clearSaved'),

  // Composite/split-view group persistence (members keyed by claudeSessionId)
  loadSplitGroups: (): Promise<Array<{ id: string; claudeSessionIds: string[]; layout?: unknown; shapeId?: string | null }>> =>
    ipcRenderer.invoke('splitGroups:load'),

  saveSplitGroups: (groups: Array<{ id: string; claudeSessionIds: string[]; layout?: unknown; shapeId?: string | null }>): void =>
    ipcRenderer.send('splitGroups:save', groups),

  // Settings
  loadSettings: (): Promise<{ baseProjectsDir: string | null; autoFocusOnSpawn: boolean; persistExplorerPath: boolean; explorerFollowsProject: boolean; colorExplorerByProject?: boolean; hotkeys?: Record<string, string>; messagePopup?: string; messagePopupSeconds?: number; todosShowCompleted?: boolean; todosSelectedTags?: string[]; todosDetailWidth?: number; autoModeForChildSessions?: boolean; autoModeForManualSessions?: boolean; autoModeForRestoredSessions?: boolean; ambientTodoNudge?: boolean; injectSpinnerTips?: boolean; memoryInjectionMode?: 'off' | 'first' | 'every'; memoryInjectionSessionCap?: number | null; memoryInjectionThreshold?: 'super-strict' | 'strict' | 'balanced' | 'lenient'; spawnIntoCurrentSplit?: boolean; terminalPairingMode?: 'off' | 'split' | 'overlay'; turnExportFolder?: string | null; turnShareDefaults?: { prompt: boolean; tool: boolean; result: boolean; toolLevel: 'summary' | 'commands' | 'full' }; openBranchInSplit?: boolean; archiveInactiveSessions?: boolean; archiveInactiveMinutes?: number; observerEnabled?: boolean; }> =>
    ipcRenderer.invoke('settings:load'),

  saveSettings: (settings: { baseProjectsDir: string | null; autoFocusOnSpawn: boolean; persistExplorerPath: boolean; explorerFollowsProject: boolean; colorExplorerByProject?: boolean; hotkeys: Record<string, string>; messagePopup?: string; messagePopupSeconds?: number; todosShowCompleted?: boolean; todosSelectedTags?: string[]; todosDetailWidth?: number; autoModeForChildSessions?: boolean; autoModeForManualSessions?: boolean; autoModeForRestoredSessions?: boolean; ambientTodoNudge?: boolean; injectSpinnerTips?: boolean; memoryInjectionMode?: 'off' | 'first' | 'every'; memoryInjectionSessionCap?: number | null; memoryInjectionThreshold?: 'super-strict' | 'strict' | 'balanced' | 'lenient'; spawnIntoCurrentSplit?: boolean; terminalPairingMode?: 'off' | 'split' | 'overlay'; turnExportFolder?: string | null; turnShareDefaults?: { prompt: boolean; tool: boolean; result: boolean; toolLevel: 'summary' | 'commands' | 'full' }; openBranchInSplit?: boolean; archiveInactiveSessions?: boolean; archiveInactiveMinutes?: number; observerEnabled?: boolean; }): Promise<void> =>
    ipcRenderer.invoke('settings:save', settings),

  // Share Turn
  listTurns: (sessionId: string): Promise<{ turns: ShareableTurn[]; error?: string }> =>
    ipcRenderer.invoke('turns:list', sessionId),

  saveTurn: (payload: { sessionId: string; filename: string; markdown: string }): Promise<{ path?: string; error?: string }> =>
    ipcRenderer.invoke('turns:save', payload),

  // File system operations
  readFile: (path: string): Promise<string> =>
    ipcRenderer.invoke('fs:readFile', path),

  readDirectory: (path: string): Promise<FsEntry[]> =>
    ipcRenderer.invoke('fs:readdir', path),

  getHomeDir: (): Promise<string> =>
    ipcRenderer.invoke('fs:homedir'),

  isDirectory: (path: string): Promise<boolean> =>
    ipcRenderer.invoke('fs:isDirectory', path),

  getResourcesPath: (): Promise<string> =>
    ipcRenderer.invoke('fs:resourcesPath'),

  onGlobalEscape: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('global:escape', handler)
    return (): void => { ipcRenderer.removeListener('global:escape', handler) }
  },

  onGlobalHotkey: (callback: (key: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, key: string) => callback(key)
    ipcRenderer.on('global:hotkey', handler)
    return (): void => { ipcRenderer.removeListener('global:hotkey', handler) }
  },

  // Skill commands — dynamically install/uninstall Claude Code slash commands
  installSkill: (skillName: string, content: string): Promise<string> =>
    ipcRenderer.invoke('skill:install', { skillName, content }),

  uninstallSkill: (skillName: string): void =>
    ipcRenderer.send('skill:uninstall', { skillName }),

  cleanupAllSkills: (): void =>
    ipcRenderer.send('skill:cleanupAll'),

  // Claude Code settings
  getStatuslineConfig: (): Promise<{
    managed: boolean
    hasCustom?: boolean
    elements: string[]
    customComponents?: Array<{
      id: string
      label: string
      description: string
      preview: string
      extract: string
      format: string
      guard?: string
    }>
    scriptPath?: string
    settingsPath?: string
  }> => ipcRenderer.invoke('claude:getStatuslineConfig'),

  setStatuslineConfig: (elements: string[], customComponents?: Array<{
    id: string
    label: string
    description: string
    preview: string
    extract: string
    format: string
    guard?: string
  }>): Promise<boolean> =>
    ipcRenderer.invoke('claude:setStatuslineConfig', elements, customComponents),

  // Session spawned externally (via MCP)
  onSessionSpawned: (callback: (data: { id: string; projectPath: string; claudeSessionId?: string | null; isPipeline?: boolean; isScheduled?: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string; projectPath: string; claudeSessionId?: string | null; isPipeline?: boolean; isScheduled?: boolean }) => callback(data)
    ipcRenderer.on('session:spawned', handler)
    return (): void => { ipcRenderer.removeListener('session:spawned', handler) }
  },

  onSessionClaudeId: (callback: (data: { id: string; claudeSessionId: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { id: string; claudeSessionId: string }) => callback(data)
    ipcRenderer.on('session:claudeId', handler)
    return (): void => { ipcRenderer.removeListener('session:claudeId', handler) }
  },

  // Inter-session message received
  onMessageReceived: (callback: (data: { targetSessionId: string; fromSessionId: string | null; message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { targetSessionId: string; fromSessionId: string | null; message: string }) => callback(data)
    ipcRenderer.on('session:message-received', handler)
    return (): void => { ipcRenderer.removeListener('session:message-received', handler) }
  },

  // Memory operations
  memoryList: (filter?: { tag?: string; type?: string }): Promise<MemoryIndexEntry[]> =>
    ipcRenderer.invoke('memory:list', filter),

  memoryRead: (filename: string): Promise<MemoryNote | null> =>
    ipcRenderer.invoke('memory:read', filename),

  memoryCreate: (args: {
    filename?: string; title: string; type?: string; tags?: string[]
    summary?: string; context?: string; details?: string; outcome?: string
  }): Promise<MemoryNote> =>
    ipcRenderer.invoke('memory:create', args),

  memoryUpdate: (args: { filename: string; frontmatter?: Record<string, unknown>; body?: string }): Promise<MemoryNote> =>
    ipcRenderer.invoke('memory:update', args),

  memoryEditSection: (args: { filename: string; heading: string; operation: 'append' | 'prepend' | 'replace'; content: string }): Promise<MemoryNote> =>
    ipcRenderer.invoke('memory:editSection', args),

  memoryDelete: (filename: string, force?: boolean): Promise<{ ok?: boolean; cleaned?: number; error?: string; referencedBy?: string[] }> =>
    ipcRenderer.invoke('memory:delete', { filename, force }),

  memorySearch: (query: string, searchType?: 'content' | 'filename' | 'both', tag?: string, type?: string): Promise<MemoryIndexEntry[]> =>
    ipcRenderer.invoke('memory:search', { query, searchType, tag, type }),

  memoryGraph: (): Promise<{ nodes: Array<{ id: string; label: string; type: string; tags: string[] }>; edges: Array<{ source: string; target: string }> }> =>
    ipcRenderer.invoke('memory:graph'),

  memoryResolveLink: (link: string): Promise<string | null> =>
    ipcRenderer.invoke('memory:resolveLink', link),

  onMemoryChanged: (callback: (changed: string[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, changed: string[]) => callback(changed)
    ipcRenderer.on('memory:changed', handler)
    return (): void => { ipcRenderer.removeListener('memory:changed', handler) }
  },

  // Todos
  todosList: (filter?: { tags?: string[]; done?: boolean; search?: string }): Promise<Array<{
    id: string; title: string; done: boolean; tags: string[]; created: string; updated: string
  }>> => ipcRenderer.invoke('todos:list', filter),
  todosRead: (id: string): Promise<{
    id: string; title: string; body: string; done: boolean; tags: string[]; created: string; updated: string
  }> => ipcRenderer.invoke('todos:read', id),
  todosCreate: (input: { title: string; body?: string; tags?: string[] }): Promise<{
    id: string; title: string; body: string; done: boolean; tags: string[]; created: string; updated: string
  }> => ipcRenderer.invoke('todos:create', input),
  todosUpdate: (id: string, patch: { title?: string; body?: string; done?: boolean; tags?: string[] }): Promise<{
    id: string; title: string; body: string; done: boolean; tags: string[]; created: string; updated: string
  }> => ipcRenderer.invoke('todos:update', id, patch),
  todosDelete: (id: string): Promise<void> => ipcRenderer.invoke('todos:delete', id),
  todosListTags: (): Promise<Array<{ tag: string; count: number }>> => ipcRenderer.invoke('todos:listTags'),
  todosProjectFromCwd: (cwd: string): Promise<string> => ipcRenderer.invoke('todos:projectFromCwd', cwd),
  todosProjectTagFromCwd: (cwd: string): Promise<string> => ipcRenderer.invoke('todos:projectTagFromCwd', cwd),

  // Agentic pipeline (Cmd+L). Tasks are plain JSON; the renderer casts to its
  // own PipelineTask type. Mutations return the new list and also broadcast.
  pipelineList: (): Promise<unknown[]> => ipcRenderer.invoke('pipeline:list'),
  pipelineStart: (todo: { id: string; title: string; tags: string[] }, defaultAutonomy: string, projectPath?: string): Promise<unknown[]> =>
    ipcRenderer.invoke('pipeline:start', todo, defaultAutonomy, projectPath),
  pipelineStartReview: (
    todo: { id: string; title: string; tags: string[] },
    defaultAutonomy: string,
    diffSource: { kind: 'working-tree' } | { kind: 'range'; base: string; target: string },
    projectPath?: string,
  ): Promise<unknown[]> =>
    ipcRenderer.invoke('pipeline:startReview', todo, defaultAutonomy, diffSource, projectPath),
  pipelineSetStage: (id: string, stage: string): Promise<unknown[]> => ipcRenderer.invoke('pipeline:setStage', id, stage),
  pipelineSetAutonomy: (id: string, level: string): Promise<unknown[]> => ipcRenderer.invoke('pipeline:setAutonomy', id, level),
  pipelineResolveGate: (id: string, approve: boolean): Promise<unknown[]> => ipcRenderer.invoke('pipeline:resolveGate', id, approve),
  pipelineRemove: (id: string): Promise<unknown[]> => ipcRenderer.invoke('pipeline:remove', id),
  pipelinePause: (id: string): Promise<unknown[]> => ipcRenderer.invoke('pipeline:pause', id),
  pipelineResume: (id: string): Promise<{ result: 'resumed' | 'skipped-live' | 'failed'; tasks: unknown[] }> =>
    ipcRenderer.invoke('pipeline:resume', id),
  pipelineAutoResume: (): Promise<{ resumed: number; skipped: number; failed: number }> =>
    ipcRenderer.invoke('pipeline:autoResume'),
  onPipelineChanged: (callback: (tasks: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tasks: unknown[]) => callback(tasks)
    ipcRenderer.on('pipeline:changed', handler)
    return (): void => { ipcRenderer.removeListener('pipeline:changed', handler) }
  },

  // Scheduled tasks (Cmd+J). State lives in main (schedule-store); the renderer
  // mirrors it via the 'schedules:changed' broadcast. Returns are cast to the
  // renderer's own ScheduledTask type. Mirrors the pipeline* API above.
  schedulesList: (): Promise<unknown[]> => ipcRenderer.invoke('schedules:list'),
  schedulesCreate: (data: unknown): Promise<unknown> =>
    ipcRenderer.invoke('schedules:create', data),
  schedulesUpdate: (id: string, patch: unknown): Promise<unknown[]> =>
    ipcRenderer.invoke('schedules:update', id, patch),
  schedulesDelete: (id: string): Promise<unknown[]> =>
    ipcRenderer.invoke('schedules:delete', id),
  schedulesSetEnabled: (id: string, enabled: boolean): Promise<unknown[]> =>
    ipcRenderer.invoke('schedules:setEnabled', id, enabled),
  schedulesRunNow: (id: string): Promise<string | null> =>
    ipcRenderer.invoke('schedules:runNow', id),
  onSchedulesChanged: (callback: (tasks: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tasks: unknown[]) => callback(tasks)
    ipcRenderer.on('schedules:changed', handler)
    return (): void => { ipcRenderer.removeListener('schedules:changed', handler) }
  },

  // GitHub integration (PR panel). Auth + items live in main (github-auth /
  // github-store, fed by github-poller); the renderer mirrors items via
  // 'github:changed' and auth loss via 'github:authLost'. Mirrors the
  // schedules* API above.
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:openExternal', url),
  githubStatus: (): Promise<unknown> => ipcRenderer.invoke('github:status'),
  githubList: (): Promise<unknown> => ipcRenderer.invoke('github:list'),
  githubConnectToken: (token: string): Promise<unknown> =>
    ipcRenderer.invoke('github:connectToken', token),
  githubDeviceStart: (): Promise<unknown> => ipcRenderer.invoke('github:deviceStart'),
  githubDeviceWait: (): Promise<unknown> => ipcRenderer.invoke('github:deviceWait'),
  githubDisconnect: (): Promise<unknown> => ipcRenderer.invoke('github:disconnect'),
  githubRefresh: (): Promise<unknown> => ipcRenderer.invoke('github:refresh'),
  githubMarkRead: (id: string): Promise<unknown[]> =>
    ipcRenderer.invoke('github:markRead', id),
  githubStartAgent: (itemId: string): Promise<{ sessionId: string } | { skipped: string }> =>
    ipcRenderer.invoke('github:startAgent', itemId),
  githubSubmitDraft: (itemId: string): Promise<string> =>
    ipcRenderer.invoke('github:submitDraft', itemId),
  githubDiscardDraft: (itemId: string): Promise<unknown[]> =>
    ipcRenderer.invoke('github:discardDraft', itemId),
  onGithubChanged: (callback: (items: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, items: unknown[]) => callback(items)
    ipcRenderer.on('github:changed', handler)
    return (): void => { ipcRenderer.removeListener('github:changed', handler) }
  },
  onGithubAuthLost: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('github:authLost', handler)
    return (): void => { ipcRenderer.removeListener('github:authLost', handler) }
  },

  // Canvas artifacts. State lives in main (canvas-store); the renderer mirrors
  // it via 'canvas:changed'. 'canvas:emitted' carries each NEW artifact (drives
  // auto-open); 'canvas:focus' re-selects an existing one. Mutations flow only
  // through the hook-server, so there are no create/update invokes here.
  canvasList: (): Promise<unknown[]> => ipcRenderer.invoke('canvas:list'),
  onCanvasChanged: (callback: (artifacts: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, artifacts: unknown[]) => callback(artifacts)
    ipcRenderer.on('canvas:changed', handler)
    return (): void => { ipcRenderer.removeListener('canvas:changed', handler) }
  },
  onCanvasEmitted: (callback: (artifact: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, artifact: unknown) => callback(artifact)
    ipcRenderer.on('canvas:emitted', handler)
    return (): void => { ipcRenderer.removeListener('canvas:emitted', handler) }
  },
  onCanvasFocus: (callback: (data: { sessionId: string; artifactId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; artifactId: string }) => callback(data)
    ipcRenderer.on('canvas:focus', handler)
    return (): void => { ipcRenderer.removeListener('canvas:focus', handler) }
  },
  canvasStashClipboardImage: (sessionId: string): Promise<{ stashed: boolean }> =>
    ipcRenderer.invoke('canvas:stashClipboardImage', sessionId),

  // Prompt-time memory injection: main announces which notes were injected
  // into a session so the transcript's "[title]" tokens can be linkified.
  onMemoryInjected: (callback: (data: { sessionId: string; entries: unknown[] }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; entries: unknown[] }) => callback(data)
    ipcRenderer.on('memory:injected', handler)
    return (): void => { ipcRenderer.removeListener('memory:injected', handler) }
  },

  // Unified session registry (Cmd+P overview). Derived state owned by main
  // (session-registry.ts); the renderer mirrors it via 'registry:changed' and
  // re-polls while the panel is open so uptime ticks.
  registryList: (): Promise<unknown[]> => ipcRenderer.invoke('registry:list'),
  registryKill: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('registry:kill', id),
  onRegistryChanged: (callback: (entries: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entries: unknown[]) => callback(entries)
    ipcRenderer.on('registry:changed', handler)
    return (): void => { ipcRenderer.removeListener('registry:changed', handler) }
  },

  // Observer / insights inbox. Main owns the SQLite store; the renderer pulls
  // the inbox on demand and re-pulls on 'observer:changed'.
  observerInbox: (): Promise<unknown> => ipcRenderer.invoke('observer:inbox'),
  observerAccept: (id: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('observer:accept', id),
  observerDismiss: (id: string, forever: boolean): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('observer:dismiss', id, forever),
  observerRunJob: (jobId: string): Promise<boolean> => ipcRenderer.invoke('observer:runJob', jobId),
  onObserverChanged: (callback: () => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('observer:changed', handler)
    return (): void => { ipcRenderer.removeListener('observer:changed', handler) }
  },
  /** The curator's observations journal (read-only for the user). */
  observerJournal: (): Promise<{ exists: boolean; content: string; updatedAt: number | null; chars: number }> =>
    ipcRenderer.invoke('observer:journal'),
  sendSessionMessage: (targetSessionId: string, message: string, fromSessionId?: string | null):
    Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('session:sendMessage', targetSessionId, message, fromSessionId),
  onNotesChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('notes:changed', handler)
    return (): void => { ipcRenderer.removeListener('notes:changed', handler) }
  },

  // CLAUDE.md instructions
  getClaudeMdStatus: (): Promise<{ exists: boolean; hasInstructions: boolean }> =>
    ipcRenderer.invoke('claude:getClaudeMdStatus'),

  getClaudeMdPreview: (): Promise<string> =>
    ipcRenderer.invoke('claude:getClaudeMdPreview'),

  installClaudeMdInstructions: (): Promise<{ ok: boolean; alreadyInstalled?: boolean; error?: string }> =>
    ipcRenderer.invoke('claude:installClaudeMdInstructions'),

  removeClaudeMdInstructions: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('claude:removeClaudeMdInstructions'),

  // Cleanup / Uninstall
  cleanupStatus: (): Promise<CleanupStatus> => ipcRenderer.invoke('cleanup:status'),
  cleanupRemoveMcp: (): Promise<CleanupResult> => ipcRenderer.invoke('cleanup:removeMcp'),
  cleanupRemoveHooks: (): Promise<CleanupResult> => ipcRenderer.invoke('cleanup:removeHooks'),
  cleanupRemoveStatusline: (): Promise<CleanupResult> => ipcRenderer.invoke('cleanup:removeStatusline'),
  cleanupRemovePlugin: (): Promise<CleanupResult> => ipcRenderer.invoke('cleanup:removePlugin'),
  cleanupReinstallMcp: (): Promise<CleanupResult> => ipcRenderer.invoke('cleanup:reinstallMcp'),
  cleanupReinstallHooks: (): Promise<CleanupResult> => ipcRenderer.invoke('cleanup:reinstallHooks'),
  cleanupReinstallPlugin: (): Promise<CleanupResult> => ipcRenderer.invoke('cleanup:reinstallPlugin'),
  cleanupRemoveMemory: (): Promise<CleanupResult & { bytes?: number; files?: number }> => ipcRenderer.invoke('cleanup:removeMemory'),
  cleanupRemoveEmbeddings: (): Promise<CleanupResult & { bytes?: number }> => ipcRenderer.invoke('cleanup:removeEmbeddings'),
  cleanupRemoveNotes: (): Promise<CleanupResult & { bytes?: number; files?: number }> => ipcRenderer.invoke('cleanup:removeNotes'),
  cleanupRemoveSessions: (): Promise<CleanupResult> => ipcRenderer.invoke('cleanup:removeSessions'),
  cleanupRemoveObserver: (): Promise<CleanupResult & { bytes?: number }> => ipcRenderer.invoke('cleanup:removeObserver'),
  cleanupRemoveMemoryInjection: (): Promise<CleanupResult & { bytes?: number }> => ipcRenderer.invoke('cleanup:removeMemoryInjection'),
  cleanupResetAppSettings: (): Promise<CleanupResult> => ipcRenderer.invoke('cleanup:resetAppSettings'),

  // App lifecycle — real quit via app.quit() so the full before-quit cleanup
  // (session save, PTY teardown, MCP unregister, plugin uninstall) always runs
  quitApp: (): void => ipcRenderer.send('app:quit'),
}

export type CleanupResult = { ok: boolean; error?: string }

export interface CleanupStatus {
  mcp: { installed: boolean; disabled: boolean }
  hooks: { installed: boolean; disabled: boolean }
  statusline: { installed: boolean; managed: boolean; hasCustom: boolean }
  claudeMd: { installed: boolean }
  plugin: { pluginDirExists: boolean; disabled: boolean }
  memory: { exists: boolean; bytes: number; files: number }
  embeddings: { dbExists: boolean; dbBytes: number; modelCacheExists: boolean; modelCacheBytes: number }
  notes: { exists: boolean; bytes: number; files: number }
  sessions: { savedExists: boolean; messagesExists: boolean }
  appSettings: { exists: boolean }
  observer: { exists: boolean; bytes: number }
  memoryInjection: { exists: boolean; bytes: number; sessions: number }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
