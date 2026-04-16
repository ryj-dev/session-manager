import * as pty from 'node-pty'
import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import { app } from 'electron'

/** On Windows, node-pty requires a fully-qualified path or an extension to find executables.
 *  Use `where` to resolve bare command names to their actual path. */
function resolveCommand(command: string): string {
  if (process.platform !== 'win32') return command
  // Already has a path separator or extension — leave it alone
  if (command.includes('\\') || command.includes('/') || command.includes('.')) return command
  try {
    const resolved = execSync(`where ${command}`, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0]
    return resolved || command
  } catch {
    return command
  }
}

/** Regex to strip Claude Code's activity indicators (spinners, braille dots, etc.) from terminal titles. */
export const TITLE_INDICATOR_RE = /[✳*\u2800-\u28FF]\s*/g

/** Default terminal titles that indicate an empty/unstarted Claude session.
 *  macOS shows "Claude Code", Windows shows "claude" (the executable name). */
const DEFAULT_TITLES = new Set(['claude code', 'claude'])

/** Returns true if a cleaned title is a default/empty Claude session title. */
export function isDefaultTitle(titleClean: string): boolean {
  if (titleClean === '') return true
  const lower = titleClean.toLowerCase()
  if (DEFAULT_TITLES.has(lower)) return true
  // Windows sets the title to the full executable path (e.g. C:\Users\ry\.local\bin\claude.exe)
  if (lower.endsWith('claude.exe') || lower.endsWith('claude')) return true
  return false
}

// Known shells that are safe to invoke for PATH resolution (macOS/Linux only)
const KNOWN_SHELLS = new Set(['/bin/bash', '/bin/zsh', '/bin/sh', '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/sh', '/usr/local/bin/bash', '/usr/local/bin/zsh', '/opt/homebrew/bin/bash', '/opt/homebrew/bin/zsh'])

// Electron doesn't inherit the full shell PATH. Resolve it once at startup.
function getShellPath(): string {
  // On Windows, the PATH is inherited correctly — no shell invocation needed
  if (process.platform === 'win32') return process.env.PATH || ''
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    if (!KNOWN_SHELLS.has(shell)) return process.env.PATH || ''
    return execSync(`${shell} -ilc 'echo $PATH'`, { encoding: 'utf-8' }).trim()
  } catch {
    return process.env.PATH || ''
  }
}

const shellPath = getShellPath()

export interface PtySession {
  id: string
  process: pty.IPty
  projectPath: string
  claudeSessionId: string | null
  hasActivity: boolean // true once user has sent input — empty sessions can't be resumed
  terminalTitle: string | null
}

const sessions = new Map<string, PtySession>()
const pendingWrites = new Map<string, string>()

export function spawnSession(
  id: string,
  cwd: string,
  command: string = 'claude',
  args: string[] = []
): PtySession {
  // Resolve 'shell' sentinel to the user's actual shell
  if (command === 'shell') {
    command = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh'
  }

  let claudeSessionId: string | null = null

  // For claude sessions, assign a session ID upfront so we can resume later
  if (command === 'claude' && !args.includes('--session-id') && !args.includes('--resume')) {
    claudeSessionId = randomUUID()
    args = ['--session-id', claudeSessionId, ...args]
  }

  // If resuming, the claude session ID is the resume arg
  if (command === 'claude' && args.includes('--resume')) {
    const resumeIdx = args.indexOf('--resume')
    if (resumeIdx >= 0 && args[resumeIdx + 1]) {
      claudeSessionId = args[resumeIdx + 1]
    }
  }

  // Expand ~ to home directory (pty.spawn doesn't do shell expansion)
  const resolvedCwd = cwd.startsWith('~') ? cwd.replace('~', homedir()) : cwd

  // Create inbox file for the monitor-based message bus
  const inboxPath = join(app.getPath('userData'), 'messages', id, 'inbox.txt')
  mkdirSync(dirname(inboxPath), { recursive: true })
  writeFileSync(inboxPath, '', { flag: 'a' }) // create if missing, don't truncate

  command = resolveCommand(command)

  const ptyProcess = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: resolvedCwd,
    env: { ...process.env, PATH: shellPath, APP_SESSION_ID: id, SESSION_MANAGER_INBOX: inboxPath }
  })

  const session: PtySession = {
    id,
    process: ptyProcess,
    projectPath: resolvedCwd,
    claudeSessionId,
    hasActivity: false,
    terminalTitle: null
  }

  sessions.set(id, session)
  return session
}

/** Raw write to a session's PTY — used for terminal keystrokes. */
export function writeToSession(id: string, data: string): void {
  const session = sessions.get(id)
  if (session) {
    session.hasActivity = true
    // Set a fallback title on first input so the session passes the save gate
    // even if Claude Code never updates the terminal title from the default.
    if (!session.terminalTitle || isDefaultTitle(session.terminalTitle.replace(TITLE_INDICATOR_RE, '').trim())) {
      session.terminalTitle = 'Claude Session'
    }
    session.process.write(data)
  }
}

export function resizeSession(id: string, cols: number, rows: number): void {
  const session = sessions.get(id)
  if (session) {
    try {
      session.process.resize(cols, rows)
    } catch {
      // PTY already dead — ignore
    }
  }
}

export function killSession(id: string): void {
  const session = sessions.get(id)
  if (session) {
    session.process.kill()
    sessions.delete(id)
    pendingWrites.delete(id)
  }
}

export function getSession(id: string): PtySession | undefined {
  return sessions.get(id)
}

export function getAllSessions(): PtySession[] {
  return Array.from(sessions.values())
}

export function killAllSessions(): void {
  for (const [id, session] of sessions) {
    session.process.kill()
    sessions.delete(id)
  }
  pendingWrites.clear()
}

export function getActiveSessions(): Array<{
  id: string
  projectPath: string
  claudeSessionId: string | null
  terminalTitle: string | null
  hasActivity: boolean
}> {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    projectPath: s.projectPath,
    claudeSessionId: s.claudeSessionId,
    terminalTitle: s.terminalTitle,
    hasActivity: s.hasActivity
  }))
}

export function getResumableSessions(): Array<{
  id: string
  projectPath: string
  claudeSessionId: string
  terminalTitle: string | null
}> {
  const resumable: Array<{ id: string; projectPath: string; claudeSessionId: string; terminalTitle: string | null }> = []
  for (const session of sessions.values()) {
    // Save sessions that have had real activity (user sent input).
    // hasActivity is the reliable signal — terminal title may stay as the default on Windows.
    if (session.claudeSessionId && session.hasActivity) {
      resumable.push({
        id: session.id,
        projectPath: session.projectPath,
        claudeSessionId: session.claudeSessionId,
        terminalTitle: session.terminalTitle
      })
    }
  }
  return resumable
}

/** Queue content for writing once Claude is ready (title set).
 *  Writes immediately if session already has a title.
 *  Used by preload bridge for raw writes. */
export function writeWhenReady(id: string, data: string): void {
  const session = sessions.get(id)
  if (!session) return

  if (session.terminalTitle) {
    session.hasActivity = true
    session.process.write(data)
  } else {
    pendingWrites.set(id, (pendingWrites.get(id) || '') + data)
  }
}

export function updateClaudeSessionId(id: string, claudeSessionId: string): void {
  const session = sessions.get(id)
  if (session && session.claudeSessionId !== claudeSessionId) {
    console.log(`[pty] session ${id} claude session changed: ${session.claudeSessionId} → ${claudeSessionId}`)
    session.claudeSessionId = claudeSessionId
  }
}

export function updateSessionTitle(id: string, title: string): void {
  const session = sessions.get(id)
  if (session) {
    session.terminalTitle = title

    // Flush any pending raw writes now that Claude is ready
    const pending = pendingWrites.get(id)
    if (pending) {
      pendingWrites.delete(id)
      session.hasActivity = true
      session.process.write(pending)
    }
  }
}

