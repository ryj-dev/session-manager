import { app, BrowserWindow, shell, protocol, net, Menu } from 'electron'
import { join, resolve, relative, isAbsolute, extname } from 'path'
import { rmSync } from 'fs'
import { pathToFileURL } from 'url'
import { getArtifactById, sweepOrphanedImages } from './canvas-store'
import { ALLOWED_IMAGE_EXTS } from './canvas-types'
import { registerIpcHandlers } from './ipc'
import { getResumableSessions, killAllSessions, onClaudeSessionIdChange } from './pty-manager'
import { getArchivedResumable } from './session-archiver'
import { saveSessions, type SavedSession } from './session-store'
import { getPipelineClaudeSessionIds } from './pipeline-store'
import { getScheduleClaudeSessionIds } from './schedule-store'
import { startHookServer, stopHookServer, runGithubAgent, githubAutoModeFor } from './hook-server'
import { startScheduler, stopScheduler } from './scheduler'
import { startGithubPoller, stopGithubPoller, configureGithubAutoStart } from './github-poller'
import { cleanupAllSkillCommands } from './fs-service'
import { startMemoryWatcher, stopMemoryWatcher } from './memory/watcher'
import { initMemoryEmbeddings, reindexAll } from './memory/embeddings-runtime'
import { startEmbedServer, stopEmbedServer } from './memory/embed-server'
import { setNotesRoot, startNotesWatcher, stopNotesWatcher, setEmbedHooks } from './notes-manager'
import { indexTodo, removeTodoFromIndex, searchTodosSemantic, reindexAllTodos } from './todos-embeddings'
import { reindexAllWiki } from './wiki-embeddings'
import { resolveAppWikiDir } from './wiki'
import { registerMcpServer, unregisterMcpServer, getMcpServerScriptPath } from './mcp-launcher'
import { installPlugin, uninstallPlugin } from './plugin-manager'
import { loadSettings } from './settings-store'
import { startObserver, stopObserver } from './observer'
import { warmMemoryInjection } from './memory-injection'

// Register design:// + canvas:// as privileged schemes (must be done before app ready)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'design',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  },
  {
    scheme: 'canvas',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let didSave = false

// Exclude agentic-pipeline and scheduled-task sessions — they shouldn't be offered
// in the generic restore prompt (which would re-add them as ordinary graph nodes).
// Pipeline resume is on-demand via the board (pipeline.json); scheduled runs resume
// on-demand via the Scheduled Tasks panel (schedules.json).
function collectResumableSessions(): SavedSession[] {
  const pipelineIds = getPipelineClaudeSessionIds()
  const scheduleIds = getScheduleClaudeSessionIds()
  // Archived sessions have no live PTY but their conversations are just as
  // resumable — merge them in so quitting doesn't silently drop them. (Only
  // graph sessions can archive, so no pipeline/schedule filtering needed.)
  return [...getResumableSessions(), ...getArchivedResumable()]
    .filter(
      (s) => !s.claudeSessionId || (!pipelineIds.has(s.claudeSessionId) && !scheduleIds.has(s.claudeSessionId))
    )
    .map((s) => ({
      claudeSessionId: s.claudeSessionId,
      projectPath: s.projectPath,
      terminalTitle: s.terminalTitle,
      savedAt: Date.now()
    }))
}

// Crash-resilient session journal: sessions.json is written on graceful quit
// (saveAndCleanup), but a hard crash — e.g. a native-module fault — never
// reaches that path, so every session was lost. Journal the same snapshot
// during runtime so a relaunch after a crash still offers the restore prompt.
let journalTimer: NodeJS.Timeout | null = null
let journalWroteNonEmpty = false
let lastJournal = ''

function journalSessions(): void {
  if (didSave) return
  const resumable = collectResumableSessions()
  // Never clobber a previous run's saved sessions with an empty list before
  // this run has produced any resumable sessions of its own — e.g. while the
  // restore prompt is still open right after a crash relaunch.
  if (resumable.length === 0 && !journalWroteNonEmpty) return
  // savedAt changes every call; compare content without it to skip no-op writes.
  const serialized = JSON.stringify(resumable.map(({ savedAt: _, ...rest }) => rest))
  if (serialized === lastJournal) return
  lastJournal = serialized
  if (resumable.length > 0) journalWroteNonEmpty = true
  saveSessions(resumable)
}

function saveAndCleanup(): void {
  if (didSave) return
  didSave = true

  if (journalTimer) {
    clearInterval(journalTimer)
    journalTimer = null
  }
  const resumable = collectResumableSessions()
  console.log('[main] saving resumable sessions:', resumable.length, resumable.map(s => s.claudeSessionId))
  saveSessions(resumable)
  killAllSessions()
  cleanupAllSkillCommands()
  stopScheduler()
  stopGithubPoller()
  stopObserver()
  stopHookServer()
  stopMemoryWatcher()
  stopEmbedServer()
  stopNotesWatcher()
  unregisterMcpServer()
  uninstallPlugin()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#0a0a0a', symbolColor: '#71717a', height: 40 } }
    ),
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Detect renderer crash (e.g. GPU process death on screen lock) and reload
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.warn(`[main] renderer process gone: ${details.reason}`, details)
    // Don't reload if the app is shutting down
    if (didSave) return
    // Reload the renderer — it will reconnect to existing PTY sessions via pty:listActive
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[main] reloading renderer after crash')
        mainWindow.reload()
      }
    }, 500)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Forward Escape key from any frame (including cross-origin iframes) to the renderer,
  // and intercept the DevTools toggle shortcut before the app's hotkey handler swallows it.
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'Escape') {
      mainWindow?.webContents.send('global:escape')
      return
    }
    const isMac = process.platform === 'darwin'
    const keyI = input.key.toLowerCase() === 'i'
    const devToolsCombo =
      (isMac && input.meta && input.alt && keyI) ||
      (!isMac && input.control && input.shift && keyI) ||
      input.key === 'F12'
    if (devToolsCombo) {
      mainWindow?.webContents.toggleDevTools()
    }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // Register design:// protocol to serve local HTML files from resources/design/
  const resourcesBase = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')

  protocol.handle('design', (request) => {
    // design://brand/filename.html → host=brand, pathname=/filename.html
    const url = new URL(request.url)
    const brand = decodeURIComponent(url.host)
    const file = decodeURIComponent(url.pathname).replace(/^\//, '')
    const designRoot = join(resourcesBase, 'design')
    const filePath = resolve(designRoot, brand, file)
    // Prevent path traversal — resolved path must stay within design directory
    const rel = relative(designRoot, filePath)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })

  // canvas://image/<artifactId> — serve canvas artifact images. Lookup is BY
  // ARTIFACT ID in the canvas store (registered via the secret-authenticated
  // /canvas/emit), so the renderer can never request an arbitrary path. The
  // extension allowlist is re-checked at serve time in case canvas.json was
  // hand-edited.
  protocol.handle('canvas', (request) => {
    const url = new URL(request.url)
    if (url.host !== 'image') return new Response('Not found', { status: 404 })
    const id = decodeURIComponent(url.pathname).replace(/^\//, '')
    const artifact = getArtifactById(id)
    const imagePath = artifact && 'image' in artifact ? artifact.image.path : null
    if (!imagePath) return new Response('Not found', { status: 404 })
    if (!ALLOWED_IMAGE_EXTS.has(extname(imagePath).toLowerCase())) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(imagePath).toString())
  })

  // GC clipboard-paste images that no artifact references (never-confirmed
  // pastes from a previous run, or files orphaned by artifact pruning).
  sweepOrphanedImages()

  // Remove Chromium's default menu so it doesn't intercept our hotkeys
  // (e.g. Cmd+Shift+T = "Reopen Closed Tab", Cmd+N = "New Window")
  if (process.platform === 'darwin') {
    // macOS needs a menu for clipboard accelerators (Cmd+C/V/X) and system items
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' }
          // selectAll intentionally omitted — Cmd+A is used for the agents panel
        ]
      },
      {
        label: 'View',
        submenu: [
          { role: 'toggleDevTools' },
          { role: 'reload' },
          { role: 'forceReload' }
        ]
      }
    ]))
  } else {
    // Windows/Linux: remove the menu entirely so Alt keypresses reach the renderer
    // (Ctrl+C/V/X work natively on these platforms without a menu).
    // Register DevTools globally on the window so F12 / Ctrl+Shift+I still works.
    Menu.setApplicationMenu(null)
  }

  cleanupAllSkillCommands() // Remove stale skill commands from previous sessions
  // Wipe stale inbox files from previous sessions/crashes (may fail on Windows if files are still locked)
  try { rmSync(join(app.getPath('userData'), 'messages'), { recursive: true, force: true }) } catch { /* best-effort */ }
  const disabled = loadSettings().disabledIntegrations ?? {}
  await startHookServer({ skipInstall: !!disabled.hooks })
  if (!disabled.plugin) {
    uninstallPlugin() // Clean stale registration from prior crash before re-installing
    installPlugin()
  }
  // Start the embed-server socket immediately so MCP children that connect
  // before the model finishes loading get a definitive "not yet" via ping.
  const embedHandle = await startEmbedServer().catch((err) => {
    console.error('[memory] embed-server failed to start:', err)
    return null
  })
  const wikiDir = resolveAppWikiDir(app.getAppPath(), app.isPackaged, process.resourcesPath)
  // Kick off model resolution (bundled or downloaded). Doesn't block UI.
  // The bootstrap reindex awaits this internally.
  void initMemoryEmbeddings().then(async () => {
    try {
      await reindexAll((p) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win && !win.isDestroyed()) {
          win.webContents.send('memory:index-progress', p)
        }
      })
    } catch (err) {
      console.error('[memory] bootstrap reindex failed:', err)
    }
    // Todo embeddings live in the same DB; reindex after memory.
    try { await reindexAllTodos() } catch (err) { console.error('[todos:embed] bootstrap reindex failed:', err) }
    // Feature wiki is read-only product docs — one reindex at startup, no watcher.
    try { await reindexAllWiki(wikiDir) } catch (err) { console.error('[wiki:embed] bootstrap reindex failed:', err) }
    // Prompt-time memory injection races a hard time budget on the sync hook
    // path — pre-load the model so the first prompt doesn't lose that race.
    if (loadSettings().memoryInjectionMode !== 'off') warmMemoryInjection()
  })
  startMemoryWatcher()
  setEmbedHooks({
    index: indexTodo,
    remove: removeTodoFromIndex,
    searchSemantic: searchTodosSemantic,
  })
  setNotesRoot(join(app.getPath('userData'), 'notes'))
  startNotesWatcher(() => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) win.webContents.send('notes:changed')
  })
  const doRegisterMcp = (): void => {
    registerMcpServer(
      getMcpServerScriptPath(),
      join(app.getPath('userData'), 'memories'),
      app.getPath('userData'),
      join(app.getPath('userData'), 'notes'),
      embedHandle?.socketPath,
      wikiDir
    )
  }
  if (!disabled.mcp) doRegisterMcp()
  registerIpcHandlers({ reinstallMcp: doRegisterMcp })
  createWindow()
  startScheduler()
  // Polls GitHub notifications for the PR panel; no-ops (with an auth-lost
  // broadcast) until a token is available via gh CLI or an explicit connect.
  // Auto-start is injected (not imported by the poller) to avoid the
  // hook-server → github-actions → github-poller cycle.
  configureGithubAutoStart(runGithubAgent, githubAutoModeFor)
  startGithubPoller()
  // The observer watches app usage and proposes automations. Debt-based and
  // idle-gated (see observer/jobs.ts) — nothing fires while the user is busy.
  startObserver()

  // Session journal: interval catches title/activity changes; the
  // claudeSessionId listener captures new sessions as soon as they get an id,
  // so a crash loses at most ~15s of state.
  journalTimer = setInterval(journalSessions, 15_000)
  onClaudeSessionIdChange(() => journalSessions())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  saveAndCleanup()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  saveAndCleanup()
})
