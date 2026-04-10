import { ipcMain, BrowserWindow, app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  spawnSession,
  writeToSession,
  writeWhenReady,
  resizeSession,
  killSession,
  getSession,
  updateSessionTitle
} from './pty-manager'
import { readDirectory, readFile, getHomeDir, isDirectory, installSkillCommand, uninstallSkillCommand, cleanupAllSkillCommands } from './fs-service'
import { onPtyData as hookOnPtyData } from './hook-server'
import { loadSavedSessions, clearSavedSessions, type SavedSession } from './session-store'
import { loadSettings, saveSettings, type AppSettings } from './settings-store'

function isSenderAlive(sender: Electron.WebContents): boolean {
  try {
    return !sender.isDestroyed()
  } catch {
    return false
  }
}

function attachSessionListeners(
  id: string,
  session: ReturnType<typeof spawnSession>,
  sender: Electron.WebContents
): void {
  session.process.onData((data) => {
    if (isSenderAlive(sender)) {
      sender.send('pty:data', { id, data })
    }
    hookOnPtyData(id, data)
  })

  session.process.onExit(({ exitCode }) => {
    setTimeout(() => {
      if (isSenderAlive(sender)) {
        sender.send('pty:exit', { id, exitCode })
      }
    }, 200)
  })
}

export function registerIpcHandlers(): void {
  // Spawn a new PTY session
  ipcMain.handle(
    'pty:spawn',
    (event, { cwd, command, args, allowedTools }: { cwd: string; command?: string; args?: string[]; allowedTools?: string[] }) => {
      console.log('[main] pty:spawn', { cwd, command, args, allowedTools })
      const id = randomUUID()

      // Inject --allowedTools for agent sessions
      let finalArgs = args
      if (allowedTools && allowedTools.length > 0 && (command === 'claude' || !command)) {
        finalArgs = [...(args || []), '--allowedTools', ...allowedTools]
      }

      try {
        const session = spawnSession(id, cwd, command, finalArgs)
        console.log('[main] session spawned:', id)
        attachSessionListeners(id, session, event.sender)
        return { id, projectPath: cwd }
      } catch (err) {
        console.error('[main] spawn failed:', err)
        throw err
      }
    }
  )

  // Resume a saved claude session
  ipcMain.handle(
    'pty:resume',
    (event, { claudeSessionId, projectPath }: { claudeSessionId: string; projectPath: string }) => {
      const id = randomUUID()
      const session = spawnSession(id, projectPath, 'claude', ['--resume', claudeSessionId])
      // Pre-set the claude session ID since we already know it
      session.claudeSessionId = claudeSessionId
      attachSessionListeners(id, session, event.sender)
      return { id, projectPath }
    }
  )

  // Write input to a session
  ipcMain.on('pty:write', (_event, { id, data }: { id: string; data: string }) => {
    writeToSession(id, data)
  })

  // Write input to a session once Claude is ready (queued until terminal title is set)
  ipcMain.on('pty:writeWhenReady', (_event, { id, data }: { id: string; data: string }) => {
    writeWhenReady(id, data)
  })

  // Resize a session
  ipcMain.on(
    'pty:resize',
    (_event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
      resizeSession(id, cols, rows)
    }
  )

  // Kill a session
  ipcMain.on('pty:kill', (_event, { id }: { id: string }) => {
    killSession(id)
  })

  // Update session title (so it can be persisted across restarts)
  ipcMain.on('pty:title', (_event, { id, title }: { id: string; title: string }) => {
    updateSessionTitle(id, title)
  })

  // Saved sessions
  ipcMain.handle('sessions:loadSaved', () => {
    return loadSavedSessions()
  })

  ipcMain.handle('sessions:clearSaved', () => {
    clearSavedSessions()
  })

  // Settings
  ipcMain.handle('settings:load', () => {
    return loadSettings()
  })

  ipcMain.handle('settings:save', (_event, settings: AppSettings) => {
    saveSettings(settings)
  })

  // File system operations
  ipcMain.handle('fs:readdir', (_event, path: string) => {
    return readDirectory(path)
  })

  ipcMain.handle('fs:homedir', () => {
    return getHomeDir()
  })

  ipcMain.handle('fs:readFile', (_event, path: string) => {
    return readFile(path)
  })

  ipcMain.handle('fs:isDirectory', (_event, path: string) => {
    return isDirectory(path)
  })

  ipcMain.handle('fs:resourcesPath', () => {
    return app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
  })

  // Get Claude session info for a PTY session (needed for skill restart)
  ipcMain.handle('pty:claudeSessionInfo', (_event, { id }: { id: string }) => {
    const session = getSession(id)
    if (!session) return null
    // A session is resumable if it has a real title (not null/empty/"Claude Code")
    const titleClean = session.terminalTitle?.replace(/[✳*\u2800-\u28FF]\s*/g, '').trim() ?? ''
    const isResumable = !!(session.claudeSessionId && titleClean !== '' && titleClean !== 'Claude Code')
    return {
      claudeSessionId: session.claudeSessionId,
      isResumable
    }
  })

  // Skill commands — install/uninstall Claude Code slash commands
  ipcMain.handle(
    'skill:install',
    (_event, { skillName, content }: { skillName: string; content: string }) => {
      const commandName = installSkillCommand(skillName, content)
      return commandName
    }
  )

  ipcMain.on('skill:uninstall', (_event, { skillName }: { skillName: string }) => {
    uninstallSkillCommand(skillName)
  })

  ipcMain.on('skill:cleanupAll', () => {
    cleanupAllSkillCommands()
  })
}
