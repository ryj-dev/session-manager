import * as pty from 'node-pty'
import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import { homedir } from 'os'

/** Regex to strip Claude Code's activity indicators (spinners, braille dots, etc.) from terminal titles. */
export const TITLE_INDICATOR_RE = /[✳*\u2800-\u28FF]\s*/g

// Known shells that are safe to invoke for PATH resolution
const KNOWN_SHELLS = new Set(['/bin/bash', '/bin/zsh', '/bin/sh', '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/sh', '/usr/local/bin/bash', '/usr/local/bin/zsh', '/opt/homebrew/bin/bash', '/opt/homebrew/bin/zsh'])

// Electron doesn't inherit the full shell PATH. Resolve it once at startup.
function getShellPath(): string {
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
const pendingSubmits = new Set<string>()

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

  const ptyProcess = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: resolvedCwd,
    env: { ...process.env, PATH: shellPath, APP_SESSION_ID: id }
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

/** Raw write to a session's PTY — used for terminal keystrokes.
 *  Does NOT submit. For prompt/message delivery, use submitToSession. */
export function writeToSession(id: string, data: string): void {
  const session = sessions.get(id)
  if (session) {
    session.hasActivity = true
    // Set a fallback title on first input so the session passes the save gate
    // even if Claude Code never updates the terminal title from the default.
    if (!session.terminalTitle || session.terminalTitle.replace(TITLE_INDICATOR_RE, '').trim() === 'Claude Code') {
      session.terminalTitle = 'Claude Session'
    }
    session.process.write(data)
  }
}

/** Write content to a session then send \r after 150ms to submit.
 *  Large writes trigger auto-bracketed paste in the PTY, which swallows
 *  an inline \r. Sending \r as a separate small write ensures submission. */
export function submitToSession(id: string, content: string): void {
  writeToSession(id, content)
  const session = sessions.get(id)
  if (session) {
    setTimeout(() => {
      if (sessions.has(id)) session.process.write('\r')
    }, 150)
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
    pendingSubmits.delete(id)
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
  pendingSubmits.clear()
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
    // Only save sessions that have had real activity AND a non-default title.
    // Empty sessions (just trust prompt + no conversation) have null title or "Claude Code".
    const titleClean = session.terminalTitle?.replace(TITLE_INDICATOR_RE, '').trim() ?? ''
    const hasRealTitle = titleClean !== '' && titleClean !== 'Claude Code'
    if (session.claudeSessionId && session.hasActivity && hasRealTitle) {
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
 *  Used by preload bridge for raw writes — for prompt submission use submitWhenReady. */
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

/** Queue content for submission once Claude is ready (title set).
 *  Sends \r as a separate write after 150ms — large PTY writes trigger
 *  auto-bracketed paste, which swallows an inline \r. */
export function submitWhenReady(id: string, content: string): void {
  const session = sessions.get(id)
  if (!session) return

  if (session.terminalTitle) {
    session.hasActivity = true
    session.process.write(content)
    setTimeout(() => {
      if (sessions.has(id)) session.process.write('\r')
    }, 150)
  } else {
    pendingWrites.set(id, (pendingWrites.get(id) || '') + content)
    pendingSubmits.add(id)
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

    // Flush any pending write now that Claude is ready
    const pending = pendingWrites.get(id)
    if (pending) {
      pendingWrites.delete(id)
      session.hasActivity = true
      session.process.write(pending)
      // If a delayed submit was queued, send \r after content is written
      if (pendingSubmits.has(id)) {
        pendingSubmits.delete(id)
        setTimeout(() => {
          if (sessions.has(id)) session.process.write('\r')
        }, 150)
      }
    }
  }
}

