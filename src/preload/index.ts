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
  spawnSession: (cwd: string, command?: string, args?: string[], allowedTools?: string[]): Promise<PtySpawnResult> =>
    ipcRenderer.invoke('pty:spawn', { cwd, command, args, allowedTools }),

  resumeSession: (claudeSessionId: string, projectPath: string): Promise<PtySpawnResult> =>
    ipcRenderer.invoke('pty:resume', { claudeSessionId, projectPath }),

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

  // Settings
  loadSettings: (): Promise<{ baseProjectsDir: string | null; autoFocusOnSpawn: boolean; persistExplorerPath: boolean; explorerFollowsProject: boolean; hotkeys?: Record<string, string>; messagePopup?: string; messagePopupSeconds?: number; todosShowCompleted?: boolean; todosSelectedTags?: string[]; todosDetailWidth?: number }> =>
    ipcRenderer.invoke('settings:load'),

  saveSettings: (settings: { baseProjectsDir: string | null; autoFocusOnSpawn: boolean; persistExplorerPath: boolean; explorerFollowsProject: boolean; hotkeys: Record<string, string>; messagePopup?: string; messagePopupSeconds?: number; todosShowCompleted?: boolean; todosSelectedTags?: string[]; todosDetailWidth?: number }): Promise<void> =>
    ipcRenderer.invoke('settings:save', settings),

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
  onSessionSpawned: (callback: (data: { id: string; projectPath: string; claudeSessionId?: string | null }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string; projectPath: string; claudeSessionId?: string | null }) => callback(data)
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
  cleanupResetAppSettings: (): Promise<CleanupResult> => ipcRenderer.invoke('cleanup:resetAppSettings'),
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
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
