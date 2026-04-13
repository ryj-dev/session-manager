import { contextBridge, ipcRenderer } from 'electron'

export type PtySpawnResult = { id: string; projectPath: string }
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

  onPtyData: (callback: (data: { id: string; data: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string; data: string }) =>
      callback(data)
    ipcRenderer.on('pty:data', handler)
    return (): void => { ipcRenderer.removeListener('pty:data', handler) }
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
  loadSettings: (): Promise<{ baseProjectsDir: string | null; autoFocusOnSpawn: boolean; persistExplorerPath: boolean; explorerFollowsProject: boolean; hotkeys?: Record<string, string> }> =>
    ipcRenderer.invoke('settings:load'),

  saveSettings: (settings: { baseProjectsDir: string | null; autoFocusOnSpawn: boolean; persistExplorerPath: boolean; explorerFollowsProject: boolean; hotkeys: Record<string, string> }): Promise<void> =>
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
  getIdleThreshold: (): Promise<number> =>
    ipcRenderer.invoke('claude:getIdleThreshold'),

  setIdleThreshold: (ms: number): Promise<boolean> =>
    ipcRenderer.invoke('claude:setIdleThreshold', ms),

  // Session spawned externally (via MCP)
  onSessionSpawned: (callback: (data: { id: string; projectPath: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string; projectPath: string }) => callback(data)
    ipcRenderer.on('session:spawned', handler)
    return (): void => { ipcRenderer.removeListener('session:spawned', handler) }
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
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
