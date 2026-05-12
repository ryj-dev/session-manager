import { createServer, type Server } from 'http'
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, appendFileSync, mkdirSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { URL } from 'url'
import { randomUUID } from 'crypto'
import { spawnSession, writeToSession, getSession, getAllSessions, updateClaudeSessionId } from './pty-manager'
import { installSkillCommand } from './fs-service'
import { atomicWriteSync } from './atomic-write'
import * as notesManager from './notes-manager'
import { loadSettings } from './settings-store'

let server: Server | null = null
let serverPort = 0

// Track which sessions are idle (at the prompt) — used for GUI status indicators
const sessionStatus = new Map<string, 'working' | 'idle'>()

/** Clean up all hook-server state for a session (call on PTY exit/kill). */
export function cleanupSession(appSessionId: string): void {
  sessionStatus.delete(appSessionId)
  awaitingPermission.delete(appSessionId)
  // Clean up the session's inbox directory (may fail on Windows if files are still locked by exiting PTY)
  try {
    rmSync(join(app.getPath('userData'), 'messages', appSessionId), { recursive: true, force: true })
  } catch { /* best-effort cleanup — leftover dirs are cleared on app quit */ }
}

// Callback for attaching PTY listeners — set by ipc.ts to avoid circular deps
let attachListenersFn: ((id: string, session: ReturnType<typeof spawnSession>) => void) | null = null

export function setAttachListeners(fn: (id: string, session: ReturnType<typeof spawnSession>) => void): void {
  attachListenersFn = fn
}

// Track sessions showing a permission prompt so we can detect rejection
// via PTY output ("Interrupted") since no hook fires for manual rejection.
const awaitingPermission = new Set<string>()

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')
// Marker in hook commands so we can find and remove our hooks on cleanup
const HOOK_MARKER = 'session-manager-hook'

interface HookPayload {
  session_id?: string
  hook_event_name?: string
  notification_type?: string
}

export function getHookServerPort(): number {
  return serverPort
}


/** Called from IPC when PTY outputs data.
 *  Detects permission rejection via terminal output. */
export function onPtyData(appSessionId: string, data: string): void {
  // Permission rejection detection
  if (!awaitingPermission.has(appSessionId)) return

  const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
  if (!clean.includes('What should Claude do instead')) return

  awaitingPermission.delete(appSessionId)
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('claude:status', { id: appSessionId, status: 'finished' })
  }
}

const APP_DATA_DIR = join(app.getPath('userData'))
const PORT_FILE = join(APP_DATA_DIR, 'hook-server.port')

function writePortFile(port: number): void {
  try {
    writeFileSync(PORT_FILE, String(port), 'utf-8')
  } catch { /* non-critical */ }
}

function removePortFile(): void {
  try {
    if (existsSync(PORT_FILE)) unlinkSync(PORT_FILE)
  } catch { /* non-critical */ }
}

export function startHookServer(opts: { skipInstall?: boolean } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1`)

        // ── Spawn session endpoint ──
        if (url.pathname === '/spawn') {
          handleSpawnRequest(body, res)
          return
        }

        // ── List sessions endpoint ──
        if (url.pathname === '/sessions') {
          handleListSessions(res)
          return
        }

        // ── Send message endpoint ──
        if (url.pathname === '/message') {
          handleSendMessage(body, res)
          return
        }

        // ── List agents endpoint ──
        if (url.pathname === '/agents') {
          handleListAgents(res)
          return
        }

        // ── Spawn agent endpoint ──
        if (url.pathname === '/spawn-agent') {
          handleSpawnAgent(body, res)
          return
        }

        // ── Synchronous hook endpoint — may inject additionalContext ──
        if (url.pathname === '/hook-sync') {
          try {
            const appSessionId = url.searchParams.get('sid')
            const payload: HookPayload = JSON.parse(body)
            const reply = buildSyncHookResponse(appSessionId, payload)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(reply))
          } catch {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{}')
          }
          return
        }

        // ── Hook event endpoint ──
        res.writeHead(200)
        res.end('ok')

        try {
          const appSessionId = url.searchParams.get('sid')
          if (!appSessionId) return

          const payload: HookPayload = JSON.parse(body)
          console.log(`[hook-server ${new Date().toISOString().slice(11, 23)}] event: ${payload.hook_event_name}`, payload.notification_type ? `(${payload.notification_type})` : '', `sid: ${appSessionId}`)
          handleHookEvent(appSessionId, payload)
        } catch (err) {
          console.error('[hook-server] parse error:', err)
        }
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      if (addr && typeof addr === 'object') {
        serverPort = addr.port
        console.log(`[hook-server] listening on port ${serverPort}`)
        writePortFile(serverPort)
        if (!opts.skipInstall) installHooks(serverPort)
        resolve(serverPort)
      } else {
        reject(new Error('Failed to bind hook server'))
      }
    })

    server.on('error', reject)
  })
}

export function reinstallHooks(): void {
  if (serverPort > 0) installHooks(serverPort)
}

export function stopHookServer(): void {
  removeHooks()
  removePortFile()
  // Wipe all inbox files on shutdown (may fail on Windows if files are still locked)
  try { rmSync(join(app.getPath('userData'), 'messages'), { recursive: true, force: true }) } catch { /* best-effort */ }
  server?.close()
  server = null
}

interface SpawnRequest {
  prompt: string
  projectPath?: string
  allowedTools?: string[]
}

function handleSpawnRequest(body: string, res: import('http').ServerResponse): void {
  try {
    const payload: SpawnRequest = JSON.parse(body)
    if (!payload.prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'prompt is required' }))
      return
    }

    const cwd = payload.projectPath || process.cwd()
    const id = randomUUID()

    // Build args — always auto-allow send-message so child can report back
    const SEND_MESSAGE_TOOL = 'mcp__session-manager__send-message'
    let args: string[] = []
    if (payload.allowedTools && payload.allowedTools.length > 0) {
      const tools = payload.allowedTools.includes(SEND_MESSAGE_TOOL)
        ? payload.allowedTools
        : [...payload.allowedTools, SEND_MESSAGE_TOOL]
      args = ['--allowedTools', ...tools]
    }

    if (loadSettings().autoModeForChildSessions) {
      args = ['--permission-mode', 'auto', ...args]
    }

    // Pass prompt as CLI positional arg — Claude Code parses it on startup,
    // bypassing the PTY paste/timing issues of writing to the TUI.
    // Use '--' to end option parsing so --allowedTools (variadic) doesn't consume the prompt.
    const session = spawnSession(id, cwd, 'claude', [...args, '--', payload.prompt])

    // Attach PTY listeners so the renderer can see this session
    if (attachListenersFn) {
      attachListenersFn(id, session)
    }

    // Notify the renderer to add this session to the UI
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send('session:spawned', { id, projectPath: cwd, claudeSessionId: session.claudeSessionId ?? null })
    }

    console.log(`[hook-server] spawned session ${id} in ${cwd}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id, projectPath: cwd }))
  } catch (err) {
    console.error('[hook-server] spawn error:', err)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

function handleListSessions(res: import('http').ServerResponse): void {
  try {
    const sessions = getAllSessions().map((s) => ({
      id: s.id,
      projectPath: s.projectPath,
      claudeSessionId: s.claudeSessionId,
      status: sessionStatus.get(s.id) ?? 'unknown',
      title: s.terminalTitle,
    }))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ sessions }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

export function deliverSessionMessage(
  targetSessionId: string,
  message: string,
  fromSessionId: string | null,
): { ok: true } | { ok: false; error: string; status: number } {
  const session = getSession(targetSessionId)
  if (!session) return { ok: false, error: `Session ${targetSessionId} not found`, status: 404 }

  const fromLabel = fromSessionId ? `Message from session ${fromSessionId}` : 'Message from another session'
  const msgDir = join(app.getPath('userData'), 'messages', targetSessionId)
  mkdirSync(msgDir, { recursive: true })
  const inboxPath = join(msgDir, 'inbox.txt')

  const MAX_INLINE_LENGTH = 400
  const escaped = message.replace(/\n/g, '\\n')
  let line: string
  if (escaped.length <= MAX_INLINE_LENGTH) {
    line = `${fromLabel}: ${escaped}\n`
  } else {
    const msgFile = join(msgDir, `msg-${randomUUID()}.md`)
    writeFileSync(msgFile, message)
    line = `${fromLabel} — full message saved to file (too long for inline delivery). Read it with: ${msgFile}\n`
  }
  appendFileSync(inboxPath, line)

  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('session:message-received', { targetSessionId, fromSessionId: fromSessionId ?? null, message })
  }

  console.log(`[hook-server ${new Date().toISOString().slice(11, 23)}] delivered message to ${targetSessionId}`)
  return { ok: true }
}

function handleSendMessage(body: string, res: import('http').ServerResponse): void {
  try {
    const { targetSessionId, message, fromSessionId } = JSON.parse(body) as {
      targetSessionId: string; message: string; fromSessionId?: string
    }

    if (!targetSessionId || !message) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'targetSessionId and message are required' }))
      return
    }

    const result = deliverSessionMessage(targetSessionId, message, fromSessionId ?? null)
    if (!result.ok) {
      res.writeHead(result.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: result.error }))
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ delivered: true }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

interface AgentDef {
  name: string
  description: string
  tools: string[]
  content: string
}

// Agent definition cache — avoids reading from disk on every HTTP request
let cachedAgents: AgentDef[] | null = null
let agentsCachedAt = 0
const AGENTS_CACHE_TTL = 30_000

function loadAgents(): AgentDef[] {
  if (cachedAgents && Date.now() - agentsCachedAt < AGENTS_CACHE_TTL) return cachedAgents

  const resourcesBase = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
  const agentsDir = join(resourcesBase, 'agents')

  try {
    const files = readdirSync(agentsDir).filter((f) => f.endsWith('.md'))
    cachedAgents = files.map((f) => {
      const raw = readFileSync(join(agentsDir, f), 'utf-8')
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/)
      const fm: Record<string, string> = {}
      if (fmMatch) {
        for (const line of fmMatch[1].split('\n')) {
          const [key, ...rest] = line.split(':')
          if (key && rest.length) fm[key.trim()] = rest.join(':').trim().replace(/^["']|["']$/g, '')
        }
      }
      const tools = fm.tools ? fm.tools.split(',').map((t) => t.trim()).filter(Boolean) : []
      return {
        name: fm.name || f.replace(/\.md$/, ''),
        description: fm.description || '',
        tools,
        content: raw,
      }
    })
    agentsCachedAt = Date.now()
    return cachedAgents
  } catch {
    return []
  }
}

function handleListAgents(res: import('http').ServerResponse): void {
  const agents = loadAgents().map(({ name, description, tools }) => ({ name, description, tools }))
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ agents }))
}

function handleSpawnAgent(body: string, res: import('http').ServerResponse): void {
  try {
    const { agentName, prompt, projectPath } = JSON.parse(body) as {
      agentName: string; prompt: string; projectPath?: string
    }

    if (!agentName || !prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'agentName and prompt are required' }))
      return
    }

    const agents = loadAgents()
    const agent = agents.find((a) => a.name === agentName)
    if (!agent) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Agent "${agentName}" not found. Available: ${agents.map((a) => a.name).join(', ')}` }))
      return
    }

    const cwd = projectPath || process.cwd()
    const id = randomUUID()

    // Install the slash command
    const commandName = installSkillCommand(agent.name, agent.content)

    // Build allowedTools — agent's tools + send-message auto-allowed
    const SEND_MSG = 'mcp__session-manager__send-message'
    const allowedTools = agent.tools.includes(SEND_MSG) ? agent.tools : [...agent.tools, SEND_MSG]

    // Pass slash command + prompt as CLI positional arg — Claude Code parses
    // skill commands from CLI args, bypassing PTY paste/timing issues.
    // Use '--' to end option parsing so --allowedTools (variadic) doesn't consume the prompt.
    const baseArgs = ['--allowedTools', ...allowedTools, '--', `/${commandName} ${prompt}`]
    const args = loadSettings().autoModeForChildSessions
      ? ['--permission-mode', 'auto', ...baseArgs]
      : baseArgs
    const session = spawnSession(id, cwd, 'claude', args)

    if (attachListenersFn) {
      attachListenersFn(id, session)
    }

    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send('session:spawned', { id, projectPath: cwd, claudeSessionId: session.claudeSessionId ?? null })
    }

    console.log(`[hook-server] spawned agent "${agent.name}" session ${id} in ${cwd}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id, projectPath: cwd, agent: agent.name }))
  } catch (err) {
    console.error('[hook-server] spawn-agent error:', err)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

// ── Ambient awareness (UserPromptSubmit → inject project-todo count) ───────

/** Last observed project-open-todo count per session, for change-detection. */
const lastProjectTodoCount = new Map<string, number>()

interface SyncHookReply {
  hookSpecificOutput?: {
    hookEventName: string
    additionalContext?: string
  }
}

function buildSyncHookResponse(appSessionId: string | null, payload: HookPayload): SyncHookReply {
  if (!appSessionId || payload.hook_event_name !== 'UserPromptSubmit') return {}

  try {
    const session = getSession(appSessionId)
    if (!session?.projectPath) return {}

    const projectTag = notesManager.projectTagFromCwd(session.projectPath)
    const open = notesManager.listTodosSummary({ tags: [projectTag], done: false })
    const count = open.length

    const claudeId = payload.session_id || null
    const trackKey = claudeId ?? appSessionId
    const prev = lastProjectTodoCount.get(trackKey) ?? -1
    lastProjectTodoCount.set(trackKey, count)

    if (count === 0) return {}
    if (prev === count) return {}

    const delta = prev === -1 ? count : (count - prev)
    const deltaText = prev === -1
      ? `first check of this session`
      : delta > 0
        ? `${delta} new since last message`
        : delta < 0
          ? `${-delta} closed since last message`
          : 'unchanged'

    const context = `You have ${count} open todo${count === 1 ? '' : 's'} tagged \`${projectTag}\` (${deltaText}). `
      + `Use the list-todos MCP tool with tags=["${projectTag}"], done=false to see them.`

    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context,
      },
    }
  } catch {
    return {}
  }
}

function handleHookEvent(appSessionId: string, payload: HookPayload): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return

  // Detect session ID changes (e.g. user did /resume inside the session)
  if (payload.session_id) {
    updateClaudeSessionId(appSessionId, payload.session_id)
  }

  const event = payload.hook_event_name

  if (event === 'Notification') {
    switch (payload.notification_type) {
      case 'permission_prompt':
        awaitingPermission.add(appSessionId)
        sessionStatus.set(appSessionId, 'idle')
        win.webContents.send('claude:status', { id: appSessionId, status: 'permission' })
        break
    }
  } else if (event === 'Stop') {
    awaitingPermission.delete(appSessionId)
    sessionStatus.set(appSessionId, 'idle')
    win.webContents.send('claude:status', { id: appSessionId, status: 'finished' })
  } else if (event === 'PreToolUse' || event === 'PostToolUse' || event === 'UserPromptSubmit') {
    awaitingPermission.delete(appSessionId)
    sessionStatus.set(appSessionId, 'working')
    win.webContents.send('claude:status', { id: appSessionId, status: 'working' })
  }
}

// ── Settings.json hook management ──────────────────────────────────────

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function writeSettings(settings: Record<string, unknown>): void {
  atomicWriteSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n')
}

function makeHookCommand(port: number): string {
  // Reads Claude's JSON payload from stdin, posts to our server with the app session ID.
  // The APP_SESSION_ID env var is injected when we spawn the PTY process.
  return `curl -sf "http://127.0.0.1:${port}/hook?sid=$APP_SESSION_ID" -H 'Content-Type: application/json' -d @- > /dev/null 2>&1 # ${HOOK_MARKER}`
}

/** Synchronous hook command — outputs the server's JSON response to stdout so Claude can consume it. */
function makeSyncHookCommand(port: number): string {
  return `curl -sf "http://127.0.0.1:${port}/hook-sync?sid=$APP_SESSION_ID" -H 'Content-Type: application/json' -d @- 2>/dev/null # ${HOOK_MARKER}`
}

function installHooks(port: number): void {
  const settings = readSettings()
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>

  const cmd = makeHookCommand(port)
  const syncCmd = makeSyncHookCommand(port)
  const hookEntry = {
    type: 'command',
    command: cmd,
    timeout: 5
  }
  const syncHookEntry = {
    type: 'command',
    command: syncCmd,
    timeout: 3
  }

  // Remove any existing session-manager hooks from all event types first
  const filterOurs = (arr: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
    arr.filter((entry) => {
      const entryHooks = entry.hooks as Array<Record<string, unknown>> | undefined
      return !entryHooks?.some((h) => typeof h.command === 'string' && h.command.includes(HOOK_MARKER))
    })

  for (const eventName of Object.keys(hooks)) {
    hooks[eventName] = filterOurs(hooks[eventName] as Array<Record<string, unknown>>)
    if ((hooks[eventName] as unknown[]).length === 0) delete hooks[eventName]
  }

  // Notification — permission prompt detection
  hooks.Notification = [
    ...((hooks.Notification ?? []) as Array<Record<string, unknown>>),
    { matcher: 'permission_prompt', hooks: [hookEntry] },
  ]

  // Stop — Claude finished responding
  hooks.Stop = [
    ...((hooks.Stop ?? []) as Array<Record<string, unknown>>),
    { hooks: [{ ...hookEntry, async: true }] }
  ]

  // PreToolUse — Claude is actively working (about to use a tool)
  hooks.PreToolUse = [
    ...((hooks.PreToolUse ?? []) as Array<Record<string, unknown>>),
    { hooks: [{ ...hookEntry, async: true }] }
  ]

  // PostToolUse — Tool completed (bridges permission-grant → next PreToolUse gap)
  hooks.PostToolUse = [
    ...((hooks.PostToolUse ?? []) as Array<Record<string, unknown>>),
    { hooks: [{ ...hookEntry, async: true }] }
  ]

  // UserPromptSubmit — fire the async tracker hook plus a sync hook that can inject
  // a system-reminder about open todos for this session's project.
  hooks.UserPromptSubmit = [
    ...((hooks.UserPromptSubmit ?? []) as Array<Record<string, unknown>>),
    { hooks: [{ ...hookEntry, async: true }] },
    { hooks: [syncHookEntry] },
  ]

  settings.hooks = hooks
  writeSettings(settings)
  console.log('[hook-server] installed hooks in', SETTINGS_PATH)
}

export function removeHooks(): void {
  try {
    const settings = readSettings()
    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>

    for (const eventName of Object.keys(hooks)) {
      const entries = hooks[eventName] as Array<Record<string, unknown>>
      hooks[eventName] = entries.filter((entry) => {
        const entryHooks = entry.hooks as Array<Record<string, unknown>> | undefined
        return !entryHooks?.some((h) => typeof h.command === 'string' && h.command.includes(HOOK_MARKER))
      })
      // Remove the key entirely if empty
      if ((hooks[eventName] as unknown[]).length === 0) {
        delete hooks[eventName]
      }
    }

    // Remove hooks key entirely if empty
    if (Object.keys(hooks).length === 0) {
      delete settings.hooks
    } else {
      settings.hooks = hooks
    }

    writeSettings(settings)
    console.log('[hook-server] removed hooks from', SETTINGS_PATH)
  } catch (err) {
    console.error('[hook-server] failed to remove hooks:', err)
  }
}
