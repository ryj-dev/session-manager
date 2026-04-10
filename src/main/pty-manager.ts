import * as pty from 'node-pty'
import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import { homedir } from 'os'

// Electron doesn't inherit the full shell PATH. Resolve it once at startup.
function getShellPath(): string {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
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

export function writeToSession(id: string, data: string): void {
  const session = sessions.get(id)
  if (session) {
    session.hasActivity = true
    // Set a fallback title on first input so the session passes the save gate
    // even if Claude Code never updates the terminal title from the default.
    if (!session.terminalTitle || session.terminalTitle.replace(/[✳*\u2800-\u28FF]\s*/g, '').trim() === 'Claude Code') {
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
    const titleClean = session.terminalTitle?.replace(/[✳*\u2800-\u28FF]\s*/g, '').trim() ?? ''
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

export function writeWhenReady(id: string, data: string): void {
  const session = sessions.get(id)
  if (!session) return

  // If session already has a title, Claude is ready — write immediately
  if (session.terminalTitle) {
    session.hasActivity = true
    session.process.write(data)
  } else {
    // Queue it — will be flushed when title is set
    pendingWrites.set(id, data)
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
    }
  }
}

