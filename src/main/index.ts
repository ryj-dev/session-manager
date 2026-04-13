import { app, BrowserWindow, shell, protocol, net, Menu } from 'electron'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { registerIpcHandlers } from './ipc'
import { getResumableSessions, killAllSessions } from './pty-manager'
import { saveSessions } from './session-store'
import { startHookServer, stopHookServer } from './hook-server'
import { cleanupAllSkillCommands } from './fs-service'
import { startMemoryWatcher, stopMemoryWatcher } from './memory/watcher'
import { registerMcpServer, unregisterMcpServer, getMcpServerScriptPath } from './mcp-launcher'

// Register design:// as a privileged scheme (must be done before app ready)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'design',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
])

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let didSave = false

function saveAndCleanup(): void {
  if (didSave) return
  didSave = true

  const resumable = getResumableSessions()
  console.log('[main] saving resumable sessions:', resumable.length, resumable.map(s => s.claudeSessionId))
  saveSessions(
    resumable.map((s) => ({
      claudeSessionId: s.claudeSessionId,
      projectPath: s.projectPath,
      terminalTitle: s.terminalTitle,
      savedAt: Date.now()
    }))
  )
  killAllSessions()
  cleanupAllSkillCommands()
  stopHookServer()
  stopMemoryWatcher()
  unregisterMcpServer()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Forward Escape key from any frame (including cross-origin iframes) to the renderer
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'Escape' && input.type === 'keyDown') {
      mainWindow?.webContents.send('global:escape')
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
    if (!filePath.startsWith(designRoot)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })

  // Remove Chromium's default menu so it doesn't intercept our hotkeys
  // (e.g. Cmd+Shift+T = "Reopen Closed Tab", Cmd+N = "New Window")
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
    }
  ]))

  cleanupAllSkillCommands() // Remove stale skill commands from previous sessions
  await startHookServer()
  startMemoryWatcher()
  registerMcpServer(getMcpServerScriptPath())
  registerIpcHandlers()
  createWindow()

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
