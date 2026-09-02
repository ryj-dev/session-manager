import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { app, BrowserWindow, clipboard, nativeImage } from 'electron'
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, appendFileSync, mkdirSync, rmSync, copyFileSync, realpathSync } from 'fs'
import { join, dirname, extname } from 'path'
import { homedir } from 'os'
import { URL } from 'url'
import { randomUUID, randomBytes, timingSafeEqual } from 'crypto'
import { spawnSession, writeToSession, getSession, getAllSessions, getActiveSessions, updateClaudeSessionId, killSession } from './pty-manager'
import { installSkillCommand } from './fs-service'
import { atomicWriteSync } from './atomic-write'
import * as notesManager from './notes-manager'
import { loadSettings } from './settings-store'
import * as pipelineStore from './pipeline-store'
import * as gitWorktree from './git-worktree'
import * as scheduleStore from './schedule-store'
import * as canvasStore from './canvas-store'
import { validateCanvasArtifact, scaleAnnotationsToNatural, annotationBoundsError } from './canvas-validate'
import type { CanvasArtifact, CanvasArtifactPayload, CanvasArtifactSource } from './canvas-types'
import { deriveRoleTools, stripOrchestratorOnlyTools, clampToRole } from './pipeline-roles'
import * as registry from './session-registry'
import {
  authorizeSuggestRequest, endCuratorRun, ingestSuggestion, isCuratorSession,
  noteSessionTranscript, readJournal, writeJournal,
} from './observer'
import { MODEL_IDS, resolveModelId, defaultModelForRole, defaultEnvForRole } from './model-tiers'
import { buildMemoryInjection } from './memory-injection'
import * as githubStore from './github-store'
import {
  submitDraft as githubSubmitDraft,
  putDraft as githubPutDraft,
  resolveRepoPath as githubResolveRepoPath,
  fetchPrHeadSha as githubFetchPrHeadSha,
} from './github-actions'
import { markThreadRead as githubMarkThreadRead } from './github-poller'
import { getAuthStatus as githubAuthStatus, getActiveToken as githubActiveToken, apiHeaders as githubApiHeaders } from './github-auth'
import type { GithubAutoMode } from './settings-store'
import * as archiver from './session-archiver'

let server: Server | null = null
let serverPort = 0
// Per-launch shared secret guarding the mutating hook-server endpoints. Rotated
// on every app start; distributed to the MCP server via SECRET_FILE (read fresh
// per call there), so sessions surviving a restart pick up the new secret.
let serverSecret = ''

/** Broadcast the latest pipeline task list to the renderer mirror. */
function broadcastPipeline(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('pipeline:changed', pipelineStore.getPipelineTasks())
  }
}

/** Broadcast the latest schedule list to the renderer's Scheduled Tasks mirror. */
function broadcastSchedules(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('schedules:changed', scheduleStore.getSchedules())
  }
}

/** Broadcast the latest canvas artifact list to the renderer mirror. */
function broadcastCanvas(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('canvas:changed', canvasStore.getArtifacts())
  }
}

/** Store a validated canvas artifact + notify the renderer: full-list mirror
 *  refresh AND a targeted 'canvas:emitted' (drives the auto-open behaviour).
 *  Single emit path shared by /canvas/emit and the user-image auto-display.
 *
 *  Image artifacts get their source file COPIED into canvas-images/ and the
 *  artifact points at the copy — sources often live in ephemeral locations
 *  (Claude Code's ~/.claude/image-cache, /tmp screenshots) that are cleaned
 *  up later, which would otherwise leave a persisted artifact with no pixels.
 *  Copies are app-owned, so the existing GC (prune-unlink + startup sweep)
 *  bounds disk use to the 50-artifact cap. Copy failure falls back to the
 *  original path — no worse than before. */
function emitCanvasArtifact(
  payload: CanvasArtifactPayload,
  meta: { sessionId: string; claudeSessionId: string | null; source: CanvasArtifactSource },
): CanvasArtifact {
  let toStore = payload
  if ('image' in toStore) {
    const src = toStore.image.path
    const ownedDir = canvasStore.canvasImagesDir()
    if (dirname(src) !== ownedDir) {
      try {
        const copyPath = join(ownedDir, `emit-${randomUUID()}${extname(src).toLowerCase()}`)
        copyFileSync(src, copyPath)
        toStore = { ...toStore, image: { ...toStore.image, path: copyPath, originalPath: src } }
      } catch (err) {
        console.error('[canvas] image copy failed, storing original path:', err)
      }
    }
  }
  const stored = canvasStore.addArtifact(toStore, meta)
  broadcastCanvas()
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.send('canvas:emitted', stored)
  return stored
}

/** Close the backing todo (taskId === todo id) when a task reaches Done, and
 *  notify the renderer's notes/backlog mirror. Idempotent (skips if already
 *  done) and safe if the todo was deleted. */
function markBackingTodoDone(taskId: string): void {
  try {
    const todo = notesManager.readTodo(taskId) // throws if the todo was deleted
    if (todo.done) return                       // only fire on the transition INTO done
    notesManager.updateTodo(taskId, { done: true })
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) win.webContents.send('notes:changed')
  } catch (err) {
    console.error('[pipeline] mark backing todo done failed:', err)
  }
}

// Track which sessions are idle (at the prompt) — used for GUI status indicators
const sessionStatus = new Map<string, 'working' | 'idle'>()

/** Last PTY-output timestamp per session — drives the ephemeral idle sweep. */
const lastPtyActivity = new Map<string, number>()

/** Clean up all hook-server state for a session (call on PTY exit/kill). */
export function cleanupSession(appSessionId: string): void {
  // Real teardown, not an archive: drop any archived record / queued messages /
  // waking state so a closed node can't be "resumed" later.
  archiver.forgetSession(appSessionId)
  registry.forget(appSessionId)
  sessionStatus.delete(appSessionId)
  awaitingPermission.delete(appSessionId)
  sessionTranscriptPath.delete(appSessionId)
  lastDigestNote.delete(appSessionId)
  lastPtyActivity.delete(appSessionId)
  lastProjectTodoCount.delete(appSessionId)
  sessionTurnCount.delete(appSessionId)
  lastNudgeTurn.delete(appSessionId)
  // Unresolved clipboard pastes die with the session (files swept on discard)
  for (const entry of pastedImageStash.get(appSessionId) ?? []) {
    try { unlinkSync(entry.path) } catch { /* sweep catches it */ }
  }
  pastedImageStash.delete(appSessionId)
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
  /** UserPromptSubmit only: the submitted prompt text (used to auto-display
   *  user-sent image paths on the canvas). */
  prompt?: string
  /** Path to the session's transcript JSONL — present on every hook event.
   *  Captured for Share Turn (turn reconstruction) and, for observed session
   *  kinds, noted into the observer's digest queue. */
  transcript_path?: string
  /** PreToolUse/PostToolUse: which tool is about to run / just ran. */
  tool_name?: string
  /** PreToolUse: the tool's arguments (used by the archiver's background-work
   *  classifier; the observer no longer records tool use). */
  tool_input?: unknown
}

/** Last transcript path seen per app session — survives /resume id changes
 *  because every hook event carries the current path. */
const sessionTranscriptPath = new Map<string, string>()

/**
 * Feed the observer's digest queue: this session has a transcript at this
 * path. Hook events arrive per tool call, so the SQLite upsert is throttled —
 * re-noted only when the identity (claude id / path) changes or a few minutes
 * have passed (which keeps the queue row's updated_at honest enough).
 *
 * Filtered at the source to observed session kinds (registry) so the curator's
 * own run and drawer previews never enter the queue. Best-effort: must never
 * break status tracking.
 */
const lastDigestNote = new Map<string, { key: string; at: number }>()
const DIGEST_NOTE_THROTTLE_MS = 3 * 60_000

function noteTranscriptForDigest(appSessionId: string, payload: HookPayload): void {
  try {
    if (!payload.transcript_path || !registry.shouldObserveSession(appSessionId)) return
    const session = getSession(appSessionId)
    const claudeSessionId = session?.claudeSessionId ?? payload.session_id
    if (!claudeSessionId) return
    const key = `${claudeSessionId}\n${payload.transcript_path}`
    const prev = lastDigestNote.get(appSessionId)
    const now = Date.now()
    if (prev && prev.key === key && now - prev.at < DIGEST_NOTE_THROTTLE_MS) return
    lastDigestNote.set(appSessionId, { key, at: now })
    noteSessionTranscript({
      sessionId: appSessionId,
      claudeSessionId,
      projectPath: session?.projectPath ?? null,
      transcriptPath: payload.transcript_path,
    })
  } catch (err) {
    console.error('[observer] transcript note failed:', err)
  }
}

export function getTranscriptPath(appSessionId: string): string | null {
  return sessionTranscriptPath.get(appSessionId) ?? null
}

export function getHookServerPort(): number {
  return serverPort
}


/** Called from IPC when PTY outputs data.
 *  Detects permission rejection via terminal output. */
export function onPtyData(appSessionId: string, data: string): void {
  // Record activity first — terminals echo keystrokes, so any user input or
  // Claude output surfaces here. Drives the ephemeral idle sweep below.
  lastPtyActivity.set(appSessionId, Date.now())

  // Archiver gate 2 input: output volume while idle (byte noise floor), plus
  // prompt-ready detection for waking sessions' queued-message flush.
  archiver.noteSessionOutput(appSessionId, data)

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
const SECRET_FILE = join(APP_DATA_DIR, 'hook-server.secret')

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

// mode 0600 is best-effort hardening (it blocks other-user reads) — it is NOT a
// guarantee against a same-user process, which can still read the file. The
// secret's real job is to block all NON-session local processes from the
// mutating endpoints; same-user containment comes from role clamping (F3/F4).
function writeSecretFile(secret: string): void {
  try {
    writeFileSync(SECRET_FILE, secret, { encoding: 'utf-8', mode: 0o600 })
  } catch { /* non-critical */ }
}

function removeSecretFile(): void {
  try {
    if (existsSync(SECRET_FILE)) unlinkSync(SECRET_FILE)
  } catch { /* non-critical */ }
}

/** Constant-time check of the X-Hook-Secret header against the launch secret. */
function isAuthed(req: IncomingMessage): boolean {
  const provided = req.headers['x-hook-secret']
  if (typeof provided !== 'string' || !serverSecret) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(serverSecret)
  if (a.length !== b.length) return false        // timingSafeEqual throws on length mismatch
  try { return timingSafeEqual(a, b) } catch { return false }
}

function denyUnauthed(res: ServerResponse): void {
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'unauthorized: missing or invalid X-Hook-Secret' }))
}

// Mutating / spawning / side-effecting endpoints — gated behind the launch
// secret. Reads (/sessions, /agents, /pipeline/get-*) and the hook pings
// (/hook, /hook-sync) stay open: reads have no side effects, and the installed
// hook curls have no channel to carry the secret (keeps them reinstall-free).
const GUARDED = new Set([
  '/spawn', '/spawn-agent', '/message',
  '/pipeline/start', '/pipeline/set-stage', '/pipeline/emit-milestone',
  '/pipeline/request-approval', '/pipeline/rename-session',
  '/pipeline/merge-worktree', '/pipeline/put-artifact',
  '/schedules/create', '/schedules/update', '/schedules/set-enabled', '/schedules/delete',
  '/canvas/emit', '/canvas/focus', '/canvas/inspect',
  '/observer/suggest', '/observer/journal-read', '/observer/journal-write',
])

export function startHookServer(opts: { skipInstall?: boolean } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1`)

        // ── Auth gate: mutating endpoints require the per-launch secret ──
        if (GUARDED.has(url.pathname) && !isAuthed(req)) { denyUnauthed(res); return }

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

        // ── Agentic pipeline endpoints (called by orchestrator/worker sessions) ──
        if (url.pathname === '/pipeline/start') { handlePipelineStart(body, res); return }
        if (url.pathname === '/pipeline/get-task') { handlePipelineGetTask(body, res); return }
        if (url.pathname === '/pipeline/set-stage') { handlePipelineSetStage(body, res); return }
        if (url.pathname === '/pipeline/emit-milestone') { handlePipelineEmit(body, res); return }
        if (url.pathname === '/pipeline/request-approval') { handlePipelineApproval(body, res); return }
        if (url.pathname === '/pipeline/rename-session') { handlePipelineRename(body, res); return }
        if (url.pathname === '/pipeline/merge-worktree') { handlePipelineMergeWorktree(body, res); return }
        if (url.pathname === '/pipeline/put-artifact') { handlePipelinePutArtifact(body, res); return }
        if (url.pathname === '/pipeline/get-artifact') { handlePipelineGetArtifact(body, res); return }

        // ── Scheduled-task endpoints (called by the scheduled-task MCP tools) ──
        if (url.pathname === '/schedules/list')        { handleSchedulesList(res); return }
        if (url.pathname === '/schedules/get')         { handleScheduleGet(body, res); return }
        if (url.pathname === '/schedules/create')      { handleScheduleCreate(body, res); return }
        if (url.pathname === '/schedules/update')      { handleScheduleUpdate(body, res); return }
        if (url.pathname === '/schedules/set-enabled') { handleScheduleSetEnabled(body, res); return }
        if (url.pathname === '/schedules/delete')      { handleScheduleDelete(body, res); return }

        // ── Canvas endpoints (called by the canvas MCP tools) ──
        // GitHub panel (MCP tools github-inbox / github-get-item /
        // github-respond / github-mark-read).
        if (url.pathname === '/github/inbox')     { handleGithubInbox(body, res); return }
        if (url.pathname === '/github/get-item')  { handleGithubGetItem(body, res); return }
        if (url.pathname === '/github/respond')   { void handleGithubRespond(body, res); return }
        if (url.pathname === '/github/mark-read') { void handleGithubMarkRead(body, res); return }

        if (url.pathname === '/canvas/emit')    { handleCanvasEmit(body, res); return }
        if (url.pathname === '/canvas/focus')   { handleCanvasFocus(body, res); return }
        if (url.pathname === '/canvas/list')    { handleCanvasList(body, res); return }
        if (url.pathname === '/canvas/inspect') { handleCanvasInspect(body, res); return }

        // ── Observer endpoints (called by the curator-only MCP tools) ──
        if (url.pathname === '/observer/suggest') { handleObserverSuggest(req, body, res); return }
        if (url.pathname === '/observer/journal-read') { handleObserverJournal(req, body, res, 'read'); return }
        if (url.pathname === '/observer/journal-write') { handleObserverJournal(req, body, res, 'write'); return }

        // ── Synchronous hook endpoint — may inject additionalContext ──
        if (url.pathname === '/hook-sync') {
          try {
            const appSessionId = url.searchParams.get('sid')
            const payload: HookPayload = JSON.parse(body)
            // User-sent image auto-display: scan the prompt (typed/dragged paths)
            // and resolve any clipboard-paste stash, off the sync path so the
            // hook reply (which Claude blocks on) is never delayed.
            if (appSessionId && payload.hook_event_name === 'UserPromptSubmit' && payload.prompt) {
              const prompt = payload.prompt
              setImmediate(() => {
                scanPromptForUserImages(appSessionId, prompt)
                resolvePastedImageStash(appSessionId, prompt)
              })
            }
            const reply = buildSyncHookResponse(appSessionId, payload)
            // Memory injection is async (embeds the prompt, hard time budget);
            // Claude blocks on this reply, so the response is sent after the
            // race resolves — never later than SEARCH_BUDGET_MS.
            void (async () => {
              let merged = reply
              try {
                merged = await mergeMemoryInjection(appSessionId, payload, reply)
              } catch {
                /* injection must never break the sync reply */
              }
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(merged))
            })()
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
        // Generate + persist the per-launch secret BEFORE installing hooks /
        // resolving, so the first guarded call already has a valid secret to
        // match. Rotated every launch; the MCP server reads it fresh per call.
        serverSecret = randomBytes(32).toString('hex')
        writeSecretFile(serverSecret)
        if (!opts.skipInstall) installHooks(serverPort)
        startEphemeralSweep()
        // Archiving: queued messages to archived sessions flush through the
        // same inbox delivery path as live messages.
        archiver.configureArchiver({ deliver: deliverSessionMessage })
        archiver.startArchiveSweep()
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
  archiver.stopArchiveSweep()
  stopEphemeralSweep()
  removeHooks()
  removePortFile()
  removeSecretFile()
  // Wipe all inbox files on shutdown (may fail on Windows if files are still locked)
  try { rmSync(join(app.getPath('userData'), 'messages'), { recursive: true, force: true }) } catch { /* best-effort */ }
  server?.close()
  server = null
}

interface SpawnRequest {
  prompt: string
  projectPath?: string
  allowedTools?: string[]
  /** Pipeline linkage: register the spawned session into a task's tree. */
  pipelineTaskId?: string
  pipelineRole?: 'orchestrator' | 'plan' | 'implement' | 'review'
  /** Parent node (app session id) to attach under. Usually the spawner. */
  parentSessionId?: string
  pipelineLabel?: string
  fanoutKind?: string
  /** Model for this session: alias "opus"|"sonnet"|"haiku" or a full model id.
   *  Omitted → falls back to the per-role default (or inherits the user default). */
  modelId?: string
  worktreeBranch?: string
  /** Create an isolated git worktree + branch for this worker. Implied when
   *  fanoutKind==='worktrees'. Requires worktreeBranch + a git projectPath. */
  isolate?: boolean
}

function handleSpawnRequest(body: string, res: import('http').ServerResponse): void {
  try {
    const payload: SpawnRequest = JSON.parse(body)
    if (!payload.prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'prompt is required' }))
      return
    }

    // The orchestrator is never spawned via /spawn (it uses
    // spawnPipelineOrchestrator with its own scoped tools). deriveRoleTools
    // returns undefined for 'orchestrator', which on this path would yield an
    // UNRESTRICTED child — strictly worse than any worker scoping. Reject it.
    if (payload.pipelineRole === 'orchestrator') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'orchestrator role cannot be spawned via /spawn' }))
      return
    }

    // F4: a pipeline-linked spawn MUST carry a role. Without one, the child
    // would be both UNRESTRICTED (no role → no --allowedTools) AND a ghost
    // (tree registration below requires both fields). Default-deny the
    // malformed spawn so it surfaces to the caller instead of silently leaking.
    if (payload.pipelineTaskId && !payload.pipelineRole) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'pipelineRole is required when pipelineTaskId is set' }))
      return
    }

    const projectPath = payload.projectPath || process.cwd()
    const id = randomUUID()

    // ── Worktree isolation ──────────────────────────────────────────────────
    // If requested (explicit isolate, or implicitly for worktree fan-out), put
    // this worker in its own git worktree on its own branch so parallel workers
    // can't clobber each other. Falls back to the shared project dir (with a
    // WARNING milestone) if the project isn't a git repo or the worktree fails.
    let cwd = projectPath
    let worktreePath: string | undefined
    let worktreeBranch: string | undefined = payload.worktreeBranch
    let worktreeRepoRoot: string | undefined
    const wantIsolation = (payload.isolate === true || payload.fanoutKind === 'worktrees')
      && !!payload.worktreeBranch && !!payload.pipelineTaskId
    if (wantIsolation) {
      const root = gitWorktree.getRepoRoot(projectPath)
      if (!root) {
        if (payload.pipelineTaskId) {
          pipelineStore.emitMilestone(payload.pipelineTaskId, id, {
            text: `⚠ ${projectPath} is not a git repo — running without worktree isolation.`,
            tone: 'warn', kind: 'blocked',
          })
        }
      } else {
        try {
          const branch = gitWorktree.branchNameFor(payload.pipelineTaskId!, payload.worktreeBranch!)
          const ref = gitWorktree.addWorktree({ repoRoot: root, taskId: payload.pipelineTaskId!, branch })
          cwd = ref.worktreePath
          worktreePath = ref.worktreePath
          worktreeBranch = ref.branch
          worktreeRepoRoot = root
        } catch (err) {
          pipelineStore.emitMilestone(payload.pipelineTaskId!, id, {
            text: `⚠ Worktree isolation failed (${err instanceof Error ? err.message : String(err)}) — running in the shared project dir.`,
            tone: 'warn', kind: 'blocked',
          })
          cwd = projectPath
        }
      }
    }

    // Build args — always auto-allow send-message so child can report back
    const SEND_MESSAGE_TOOL = 'mcp__session-manager__send-message'
    // Explicit allowedTools wins; otherwise derive scoping from pipelineRole
    // (server-side enforcement, not convention). No role + no explicit list ⇒
    // unrestricted, unchanged from prior behavior.
    const hasExplicit = !!(payload.allowedTools && payload.allowedTools.length > 0)
    let effective = hasExplicit ? payload.allowedTools! : deriveRoleTools(payload.pipelineRole)
    // F3: an explicit override may narrow WITHIN the role envelope but never
    // exceed it. Applied ONLY for pipeline roles — non-pipeline explicit lists
    // (no role) stay unrestricted. Dropped tools are logged + surfaced as a
    // milestone, never silently truncated.
    if (hasExplicit && payload.pipelineRole) {
      const clamped = clampToRole(payload.allowedTools!, payload.pipelineRole)
      if (clamped.length !== payload.allowedTools!.length) {
        const dropped = payload.allowedTools!.filter(t => !clamped.includes(t))
        console.warn(`[hook-server] clamped explicit allowedTools for role ${payload.pipelineRole}; dropped: ${dropped.join(', ')}`)
        if (payload.pipelineTaskId) {
          pipelineStore.emitMilestone(payload.pipelineTaskId, id, {
            text: `⚠ Requested tools outside the ${payload.pipelineRole} role envelope were dropped: ${dropped.join(', ')}.`,
            tone: 'warn', kind: 'blocked',
          })
        }
      }
      effective = clamped.length > 0 ? clamped : deriveRoleTools(payload.pipelineRole)
    }
    // Hard invariant: workers never hold pipeline control tools, even when an
    // explicit allowedTools override is supplied (override still wins for all
    // other tools). Applied regardless of how `effective` was derived.
    if (effective) effective = stripOrchestratorOnlyTools(effective)
    let args: string[] = []
    if (effective && effective.length > 0) {
      const tools = effective.includes(SEND_MESSAGE_TOOL)
        ? effective
        : [...effective, SEND_MESSAGE_TOOL]
      args = ['--allowedTools', ...tools]
    }

    if (loadSettings().autoModeForChildSessions) {
      args = ['--permission-mode', 'auto', ...args]
    }

    // Model tier: explicit modelId wins; otherwise fall back to the per-role
    // default keyed on (role, fanoutKind). Prepend so `--model <id>` leads the
    // arg list (CLI arg order is irrelevant; spawnSession prepends --session-id).
    const modelId = resolveModelId(payload.modelId) ?? defaultModelForRole(payload.pipelineRole, payload.fanoutKind)
    if (modelId) args = ['--model', modelId, ...args]
    // Per-role env (e.g. cheap built-in subagent model for plan/implement workers).
    const extraEnv = defaultEnvForRole(payload.pipelineRole, payload.fanoutKind)

    // Pass prompt as CLI positional arg — Claude Code parses it on startup,
    // bypassing the PTY paste/timing issues of writing to the TUI.
    // Use '--' to end option parsing so --allowedTools (variadic) doesn't consume the prompt.
    let session: ReturnType<typeof spawnSession>
    try {
      session = spawnSession(id, cwd, 'claude', [...args, '--', payload.prompt], extraEnv)
    } catch (err) {
      // Don't leak the worktree we just created if the PTY spawn fails.
      if (worktreePath && worktreeBranch && worktreeRepoRoot) {
        try {
          gitWorktree.removeWorktree({ repoRoot: worktreeRepoRoot, worktreePath, branch: worktreeBranch })
        } catch { /* best-effort */ }
      }
      throw err
    }

    // Attach PTY listeners so the renderer can see this session
    if (attachListenersFn) {
      attachListenersFn(id, session)
    }

    // Origin tag. Pipeline-linked spawns carry their task/role; a plain
    // spawn-session child is an ordinary graph session owned by its spawner.
    registry.setOrigin(id, payload.pipelineTaskId
      ? {
          kind: 'pipeline',
          pipelineTaskId: payload.pipelineTaskId,
          pipelineRole: payload.pipelineRole,
          pipelineLabel: payload.pipelineLabel ?? payload.pipelineRole,
          label: payload.pipelineLabel ?? payload.pipelineRole,
          parentSessionId: payload.parentSessionId,
        }
      : { kind: 'user', parentSessionId: payload.parentSessionId })

    // Notify the renderer to add this session to the UI. Pipeline-linked spawns
    // are flagged so the graph view excludes them (they live in the board).
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send('session:spawned', { id, projectPath: cwd, claudeSessionId: session.claudeSessionId ?? null, isPipeline: !!payload.pipelineTaskId })
    }

    // Register into the pipeline tree if this spawn is part of a task.
    if (payload.pipelineTaskId && payload.pipelineRole) {
      pipelineStore.upsertPipelineSession(
        payload.pipelineTaskId,
        {
          id,
          role: payload.pipelineRole,
          label: payload.pipelineLabel ?? payload.pipelineRole,
          status: 'working',
          fanoutKind: payload.fanoutKind,
          modelId,
          claudeSessionId: session.claudeSessionId ?? null,
          cwd,
          worktreeBranch,
          worktreePath,
        },
        payload.parentSessionId,
      )
      broadcastPipeline()
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

// ── Scheduled task spawn ────────────────────────────────────────────────────

// Output markers that mean a scheduled `claude` run couldn't authenticate. When
// not logged in, `claude` never reaches a real session, so NO Stop hook ever
// fires and the run would otherwise stay 'working' forever. We scan a small tail
// of its output for these (ANSI-stripped, lower-cased) to classify the failure.
const LOGIN_FAILURE_MARKERS = [
  'invalid api key',
  'please run /login',
  '/login',
  'not logged in',
  'log in to claude',
  'please log in',
  'login failed',
  'authentication error',
  'oauth token has expired',
  'credit balance is too low',
]

// Per-scheduled-session output scan state: a capped tail buffer + a sticky flag
// set once a login marker is seen. Cleaned up when the PTY exits.
const scheduledOutputScan = new Map<string, { tail: string; loginIssue: boolean }>()
const SCAN_TAIL_LIMIT = 4096

function scanScheduledOutput(sessionId: string, data: string): void {
  const state = scheduledOutputScan.get(sessionId)
  if (!state) return
  const clean = data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  state.tail = (state.tail + clean).slice(-SCAN_TAIL_LIMIT)
  if (!state.loginIssue) {
    const hay = state.tail.toLowerCase()
    if (LOGIN_FAILURE_MARKERS.some((m) => hay.includes(m))) state.loginIssue = true
  }
}

// Spawns a scheduled task as a normal PTY `claude` session (flagged isScheduled
// so the renderer can route it to the Scheduled Tasks panel, not the graph).
// Records a 'working' run on the schedule; the Stop hook later marks it done and
// tears the PTY down (keeping claudeSessionId so the run is resumable).
// Returns the new app/PTY session id.
export function runScheduledTask(schedule: scheduleStore.ScheduledTask): string {
  const id = randomUUID()
  const cwd = schedule.projectPath || process.cwd()

  // Build args. Auto-allow send-message so the run can report back, matching the
  // generic spawn path; if allowedTools is set, restrict to it (+ send-message).
  const SEND_MESSAGE_TOOL = 'mcp__session-manager__send-message'
  let args: string[] = []
  if (schedule.allowedTools && schedule.allowedTools.length > 0) {
    const tools = schedule.allowedTools.includes(SEND_MESSAGE_TOOL)
      ? schedule.allowedTools
      : [...schedule.allowedTools, SEND_MESSAGE_TOOL]
    args = ['--allowedTools', ...tools]
  }
  // autoApprove → run unattended with auto permission mode (prepended).
  if (schedule.autoApprove) {
    args = ['--permission-mode', 'auto', ...args]
  }
  // Explicit model (alias or full id) overrides the user's current default.
  const modelId = resolveModelId(schedule.model)
  if (modelId) args = ['--model', modelId, ...args]

  // Prompt passed as positional after `--` (same rationale as handleSpawnRequest:
  // bypasses PTY paste/timing, and `--` stops --allowedTools consuming it).
  const session = spawnSession(id, cwd, 'claude', [...args, '--', schedule.prompt])

  // Attach PTY listeners so the renderer can see this session.
  if (attachListenersFn) attachListenersFn(id, session)

  // Notify the renderer; isScheduled routes it to the Scheduled Tasks panel and
  // (see below) the origin tag routes it to the overview's schedules section.
  // (like isPipeline) keeps it out of the graph view.
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('session:spawned', {
      id,
      projectPath: cwd,
      claudeSessionId: session.claudeSessionId ?? null,
      isScheduled: true,
    })
  }

  // Record the started run. spawnSession assigns claudeSessionId upfront for
  // `claude` spawns (pty-manager:88-90), so it is available synchronously here.
  const run: scheduleStore.ScheduleRun = {
    id: randomUUID(),
    sessionId: id,
    claudeSessionId: session.claudeSessionId ?? null,
    startedAt: new Date().toISOString(),
    status: 'working',
  }
  scheduleStore.recordRunStarted(schedule.id, run)
  registry.setOrigin(id, {
    kind: 'scheduled',
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    scheduleRunId: run.id,
    label: schedule.name,
  })
  broadcastSchedules()

  // Failure detection. A logged-out run never reaches a Claude session, so the
  // Stop hook (which marks 'done') never fires and the run would stay 'working'
  // forever. Scan output for login markers, and on PTY exit mark the run 'error'
  // IF it is still working (markRunErrored guards against racing a Stop 'done').
  // node-pty allows multiple listeners, so these coexist with attachListenersFn's.
  scheduledOutputScan.set(id, { tail: '', loginIssue: false })
  session.process.onData((data) => scanScheduledOutput(id, data))
  session.process.onExit(({ exitCode }) => {
    const scan = scheduledOutputScan.get(id)
    scheduledOutputScan.delete(id)
    const reason = scan?.loginIssue
      ? 'Not logged in — open this run and sign in (/login), or log in and restart.'
      : exitCode !== 0
        ? `Run exited (code ${exitCode}) before completing.`
        : 'Run ended before completing.'
    if (scheduleStore.markRunErrored(schedule.id, run.id, new Date().toISOString(), reason)) {
      console.log(`[hook-server] scheduled run ${run.id} errored: ${reason}`)
      broadcastSchedules()
    }
  })

  console.log(`[hook-server] ran scheduled task ${schedule.id} as session ${id} in ${cwd}`)
  return id
}

// ── GitHub agent spawn (manual buttons + poller auto-start) ─────────────────

// One active agent per GitHub item: a second trigger while a session is still
// alive is skipped (the running agent will see the newer activity itself).
const githubItemSessions = new Map<string, string>()

// Agent sessions that have delivered their github-respond, keyed by session id
// → item id. When such a session's Stop hook fires, its PTY is torn down (same
// path as scheduled runs) so finished review agents don't linger on the graph;
// the conversation stays resumable via the item's agentClaudeSessionId.
const githubRespondedSessions = new Map<string, string>()

// ── GitHub agent lifecycle: watching, adoption, focus-aware teardown ─────────
//
// Every live, un-adopted agent: session id → item id. Drives adoption (a real
// user prompt graduates the agent to a normal graph session) and teardown.
const githubAgentBySession = new Map<string, string>()
// The spawn prompt is delivered as a CLI arg, which still fires one
// UserPromptSubmit — swallow it so it doesn't count as the user engaging.
const githubInitialPromptPending = new Set<string>()
// Finished while the user was WATCHING (focused on the terminal): kept open so
// they can start talking. Torn down when focus leaves and the session is idle.
const githubDeferredTeardowns = new Map<string, string>()

// The renderer reports which session's terminal the user is actually looking
// at (focused/split view; null on the graph). "Watching" is exactly this.
let uiFocusedSessionId: string | null = null
export function setUiFocusedSession(id: string | null): void {
  uiFocusedSessionId = id
  finalizeDeferredGithubTeardowns()
}

function broadcastGithubItems(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.send('github:changed', githubStore.getItems())
}

/** Final PTY teardown for a finished agent: capture the (possibly updated)
 *  conversation id, drop the live marker, and reclaim the PTY. */
function finalizeGithubTeardown(sessionId: string, itemId: string): void {
  githubAgentBySession.delete(sessionId)
  githubInitialPromptPending.delete(sessionId)
  const live = getSession(sessionId)
  if (live?.claudeSessionId) githubStore.setAgentSession(itemId, live.claudeSessionId, live.projectPath)
  githubStore.setAgentLive(itemId, null)
  broadcastGithubItems()
  scheduleSessionTeardown(sessionId)
}

/** Tear down deferred (finished-while-watched) agents once the user has moved
 *  away AND the session is idle. A session the user engaged with never gets
 *  here — engagement adopts it (removed from the deferred map). */
function finalizeDeferredGithubTeardowns(): void {
  for (const [sessionId, itemId] of [...githubDeferredTeardowns]) {
    if (sessionId === uiFocusedSessionId) continue
    if (!getSession(sessionId)) {
      githubDeferredTeardowns.delete(sessionId)
      githubStore.setAgentLive(itemId, null)
      continue
    }
    if (sessionStatus.get(sessionId) !== 'idle') continue
    githubDeferredTeardowns.delete(sessionId)
    finalizeGithubTeardown(sessionId, itemId)
  }
}

/** The user sent a real prompt to an agent — it's theirs now. Un-hide it on
 *  the graph (renderer clears isGithub via 'github:agentAdopted'), retag its
 *  registry origin, and remove it from every teardown path. */
function adoptGithubAgent(sessionId: string, itemId: string): void {
  githubAgentBySession.delete(sessionId)
  githubInitialPromptPending.delete(sessionId)
  githubRespondedSessions.delete(sessionId)
  githubDeferredTeardowns.delete(sessionId)
  githubItemSessions.delete(itemId)
  const live = getSession(sessionId)
  if (live) githubStore.setAgentSession(itemId, live.claudeSessionId ?? null, live.projectPath)
  githubStore.setAgentLive(itemId, null)
  const item = githubStore.getItem(itemId)
  registry.setOrigin(sessionId, {
    kind: 'user',
    label: item ? `GitHub · ${item.repo}#${item.prNumber}` : undefined,
  })
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.send('github:agentAdopted', { sessionId })
  broadcastGithubItems()
  console.log(`[hook-server] github agent ${sessionId} adopted by user`)
}

/** The kind-specific brief. Both kinds respond through the github-respond MCP
 *  tool — the draft-gate is enforced by the app (github-actions), so the agent
 *  is TOLD it cannot post directly and gh is for reading only. */
function githubAgentPrompt(item: githubStore.GithubItem, repoPath: string): string {
  const respondRules =
    `When your response is ready, call the \`mcp__session-manager__github-respond\` MCP tool with itemId "${item.id}". ` +
    `The app decides whether it is stored as a draft for the user to approve or submitted immediately — that is not your choice. ` +
    `NEVER post reviews, comments, or pushes to GitHub yourself (no \`gh pr review\`, no \`gh api\` writes, no \`git push\`) — ` +
    `the \`gh\` CLI is for READING only. ` +
    `You MUST call github-respond exactly once, EVEN IF the answer is "nothing to do" — in that case pass type "none" with ` +
    `a one-line \`body\` saying why (e.g. "Linear bot comment, nothing actionable", "colleague discussion, not addressed to me"). ` +
    `Deciding not to respond is a valid outcome; ending your turn without calling the tool is not, and leaves the item stuck. ` +
    `This session closes automatically when you finish (the user can re-open the conversation from the GitHub panel to discuss), ` +
    `so end your turn after calling the tool — do not wait for user input.`

  if (item.kind === 'my-pr-activity') {
    return (
      `PR #${item.prNumber} in ${item.repo} ("${item.title}") is my PR and has new review comments/feedback.\n\n` +
      `1. Read the feedback: \`gh pr view ${item.prNumber} --repo ${item.repo} --comments\` and the review threads via \`gh api repos/${item.repo}/pulls/${item.prNumber}/comments\` (note each comment's numeric id).\n` +
      `2. If the feedback needs code changes: check out the PR branch (\`gh pr checkout ${item.prNumber} --repo ${item.repo}\`; stop and report if the working tree is dirty), implement the fixes, and COMMIT LOCALLY — do NOT push.\n` +
      `3. Call github-respond with type "reply-with-fixes": per-thread \`replies\` (commentId + body), \`commitsReady: true\` and \`repoPath: "${repoPath}"\` if you committed, or just a \`body\` comment if no code change was needed.\n\n` +
      respondRules
    )
  }
  const kindLine = item.kind === 'review-request' ? 'My review was requested on' : 'I was mentioned on'
  return (
    `${kindLine} PR #${item.prNumber} in ${item.repo} ("${item.title}" by ${item.author}).\n\n` +
    `1. Read the PR: \`gh pr view ${item.prNumber} --repo ${item.repo} --comments\` and \`gh pr diff ${item.prNumber} --repo ${item.repo}\`.\n` +
    `2. Review the diff for correctness, bugs, security, architecture and tests — read surrounding code in this checkout wherever the diff alone is ambiguous.\n` +
    `3. Call github-respond with type "review": a \`verdict\` (approve | request-changes | comment), a \`body\` summary, and \`comments\` [{path, line, body}] for line-anchored findings.\n\n` +
    respondRules
  )
}

/** True when the newest activity on the thread was authored by the connected
 *  login — an echo of something we (or the user) just posted. Best-effort:
 *  unknown shapes return false (don't suppress). */
async function isSelfEcho(item: githubStore.GithubItem): Promise<boolean> {
  if (!item.latestCommentUrl) return false
  try {
    const auth = await githubActiveToken()
    if (!auth) return false
    const status = await githubAuthStatus()
    if (!status.login) return false
    const res = await fetch(item.latestCommentUrl, { headers: githubApiHeaders(auth.token) })
    if (!res.ok) return false
    const comment = (await res.json()) as { user?: { login?: string } }
    return comment.user?.login === status.login
  } catch {
    return false
  }
}

/** Spawn the review/fix agent for a GitHub item. Shared by the panel buttons
 *  (mode-agnostic — the draft/auto decision happens at respond time) and the
 *  poller's auto-start (which checks the rules first). Returns the session id,
 *  or null when skipped (no checkout, agent already running, self-echo). */
export async function runGithubAgent(
  itemId: string,
  opts: { skipSelfEcho?: boolean } = {},
): Promise<{ sessionId: string } | { skipped: string }> {
  const item = githubStore.getItem(itemId)
  if (!item) throw new Error(`Unknown GitHub item ${itemId}`)

  const existing = githubItemSessions.get(itemId)
  if (existing && getSession(existing)) return { skipped: 'an agent session for this item is still running' }

  if (opts.skipSelfEcho && (await isSelfEcho(item))) {
    return { skipped: 'latest activity is our own submission (self-echo)' }
  }

  const cwd = githubResolveRepoPath(item.repo)
  if (!cwd) {
    return { skipped: `no local checkout of ${item.repo} under the base projects folder` }
  }

  const id = randomUUID()
  const prompt = githubAgentPrompt(item, cwd)
  // Settings-chosen model (alias or full id); empty = inherit the user default.
  const modelId = resolveModelId(loadSettings().githubReviewModel)
  const modelArgs = modelId ? ['--model', modelId] : []
  const session = spawnSession(id, cwd, 'claude', [...modelArgs, '--permission-mode', 'auto', '--', prompt])
  if (attachListenersFn) attachListenersFn(id, session)

  // isGithub keeps it OFF the graph — it runs in the background like scheduled
  // runs; the GitHub panel (drafts + Discuss) is its home UI.
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('session:spawned', {
      id,
      projectPath: cwd,
      claudeSessionId: session.claudeSessionId ?? null,
      isGithub: true,
    })
  }
  registry.setOrigin(id, {
    kind: 'github',
    label: `GitHub · ${item.repo}#${item.prNumber}`,
  })
  githubItemSessions.set(itemId, id)
  githubAgentBySession.set(id, itemId)
  githubInitialPromptPending.add(id)
  // Live marker → the panel card shows "Watch live" while it runs.
  githubStore.setAgentLive(itemId, id)
  broadcastGithubItems()
  // Spawning the agent means the item is being handled — clear unread on
  // GitHub (read back, GitHub stays the source of truth).
  void githubMarkThreadRead(itemId)
  console.log(`[hook-server] spawned github agent for ${item.repo}#${item.prNumber} as session ${id}`)
  return { sessionId: id }
}

/** Look up the auto-review mode for an item kind from settings. */
export function githubAutoModeFor(kind: githubStore.GithubItemKind): GithubAutoMode {
  const rules = loadSettings().githubAutoReview
  if (!rules) return 'off'
  if (kind === 'review-request') return rules.reviewRequest
  if (kind === 'mention') return rules.mention
  return rules.myPrActivity
}

// ── GitHub HTTP handlers (MCP tool backends) ────────────────────────────────

function githubCounts(): { unreadByKind: Record<string, number>; unreadTotal: number; activeTotal: number; draftsPending: number } {
  const items = githubStore.getItems()
  const unreadByKind: Record<string, number> = { 'review-request': 0, mention: 0, 'my-pr-activity': 0 }
  let unreadTotal = 0
  let activeTotal = 0
  let draftsPending = 0
  for (const i of items) {
    if (i.unread) { unreadByKind[i.kind] += 1; unreadTotal += 1 }
    if (i.prState === 'open' || i.prState === 'draft') activeTotal += 1
    if (i.draft) draftsPending += 1
  }
  return { unreadByKind, unreadTotal, activeTotal, draftsPending }
}

function handleGithubInbox(body: string, res: ServerResponse): void {
  try {
    const filters = readJson<{
      kind?: githubStore.GithubItemKind
      unread?: boolean
      prState?: githubStore.GithubItem['prState']
      repo?: string
      since?: string
    }>(body || '{}')
    let items = githubStore.getItems()
    if (filters.kind) items = items.filter((i) => i.kind === filters.kind)
    if (filters.unread !== undefined) items = items.filter((i) => i.unread === filters.unread)
    if (filters.prState) items = items.filter((i) => i.prState === filters.prState)
    if (filters.repo) items = items.filter((i) => i.repo.toLowerCase() === filters.repo!.toLowerCase())
    if (filters.since) items = items.filter((i) => i.updatedAt >= filters.since!)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ counts: githubCounts(), items }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

function handleGithubGetItem(body: string, res: ServerResponse): void {
  try {
    const { itemId } = readJson<{ itemId: string }>(body)
    const item = githubStore.getItem(itemId)
    res.writeHead(item ? 200 : 404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(item ?? { error: `GitHub item ${itemId} not found` }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

async function handleGithubRespond(body: string, res: ServerResponse): Promise<void> {
  try {
    const payload = readJson<{
      itemId: string
      type: 'review' | 'reply-with-fixes' | 'none'
      verdict?: 'approve' | 'request-changes' | 'comment'
      body: string
      comments?: { path: string; line: number; body: string }[]
      replies?: { commentId: number; body: string }[]
      commitsReady?: boolean
      repoPath?: string
      sessionId?: string
    }>(body)
    const item = githubStore.getItem(payload.itemId)
    if (!item) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `GitHub item ${payload.itemId} not found` }))
      return
    }
    // Capture the agent's conversation for the panel's "Discuss" button, and
    // flag the session for teardown on its Stop hook — finished review agents
    // don't linger on the graph; the conversation stays resumable. Applies to
    // EVERY outcome including 'none': deciding not to respond is still a
    // finished run, and the user may well want to ask why.
    if (payload.sessionId) {
      const live = getSession(payload.sessionId)
      if (live) {
        githubStore.setAgentSession(payload.itemId, live.claudeSessionId ?? null, live.projectPath)
        githubRespondedSessions.set(payload.sessionId, payload.itemId)
      }
    }

    // 'none' — the agent read the activity and judged that no response is
    // warranted (a bot comment, colleague chatter, nothing actionable). Record
    // the decision and clear the thread. This exists because the alternative
    // (end the turn without calling the tool) is indistinguishable from a crash:
    // the item keeps its per-item guard and its "Watch live" marker forever, so
    // it can neither finish nor re-trigger. Nothing is posted to GitHub.
    if (payload.type === 'none') {
      const reason = payload.body?.trim() || 'No response needed'
      // Stamp the head SHA the dismissal covers, exactly as a submission does —
      // "nothing to do here" must gate the next poll the same way a review does.
      githubStore.markDismissed(payload.itemId, reason, await githubFetchPrHeadSha(item.repo, item.prNumber))
      broadcastGithubItems()
      void githubMarkThreadRead(payload.itemId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'dismissed',
        summary: `Recorded "no response needed" — ${reason}. Nothing was posted to GitHub; the thread is marked read. End your turn.`,
      }))
      return
    }

    const draft: githubStore.GithubDraft = {
      type: payload.type,
      verdict: payload.verdict,
      body: payload.body,
      comments: payload.comments,
      replies: payload.replies,
      commitsReady: payload.commitsReady,
      repoPath: payload.repoPath,
      sessionId: payload.sessionId ?? null,
      createdAt: new Date().toISOString(),
    }
    githubPutDraft(payload.itemId, draft)

    // The MODE decides what happens next — the calling agent does not.
    // 'auto' → submit right now; 'draft' and 'off' → stored, user approves.
    // No native notifications here — the amber drafts pill on the graph (and
    // the panel itself) is the surfacing mechanism.
    const mode = githubAutoModeFor(item.kind)
    if (mode === 'auto') {
      const summary = await githubSubmitDraft(payload.itemId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'submitted', summary }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'draft-stored',
      summary: 'Draft stored on the item — the user will review and submit it from the GitHub panel. Do not attempt to post it another way.',
    }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

async function handleGithubMarkRead(body: string, res: ServerResponse): Promise<void> {
  try {
    const { itemId } = readJson<{ itemId: string }>(body)
    await githubMarkThreadRead(itemId)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

// ── Pipeline orchestrator spawn ─────────────────────────────────────────────

/** Tools the orchestrator is allowed to use. It coordinates only — it cannot
 *  edit code itself (workers do that), so no Write/Edit/Bash. */
const ORCHESTRATOR_TOOLS = [
  'mcp__session-manager__emit-milestone',
  'mcp__session-manager__spawn-session',
  'mcp__session-manager__pipeline-set-stage',
  'mcp__session-manager__pipeline-request-approval',
  'mcp__session-manager__pipeline-rename-session',
  'mcp__session-manager__pipeline-get-task',
  'mcp__session-manager__pipeline-put-artifact',
  'mcp__session-manager__pipeline-get-artifact',
  'mcp__session-manager__merge-worktree',
  'mcp__session-manager__send-message',
  'mcp__session-manager__list-sessions',
  'Read', 'Grep', 'Glob',
]

function buildOrchestratorPrompt(
  task: pipelineStore.PipelineTask,
  isolated: boolean,
  reopenedFrom?: pipelineStore.PipelineStage,
): string {
  const reopenNotice = reopenedFrom
    ? `⚠ This task was REOPENED at the ${reopenedFrom} stage. Any prior "task complete" conclusion is VOID — do NOT assume earlier work is final. If reopened at the implement or review stage, SKIP planning and resume from the ${reopenedFrom} stage; otherwise re-plan from the start.\n\n`
    : ''
  const tagLine = task.tags.length ? `\n- tags: ${task.tags.join(', ')}` : ''
  const bodyBlock = task.body && task.body.trim()
    ? `\n\nTASK DETAILS (the user's full intent, from the todo body — follow it closely and relay the relevant parts to the planner/implementers):\n"""\n${task.body.trim()}\n"""`
    : ''
  const isolationLine = isolated
    ? `\n\nISOLATION: You and ALL your stage sessions run in a dedicated git worktree on a per-task branch, so other tasks running concurrently can't collide with you. Your branch is merged back into the integration branch automatically when the task reaches Done — do not merge to the main branch yourself.`
    : `\n\nNOTE: This task is NOT running in an isolated worktree (the project isn't a git repo, or worktree creation failed). Avoid parallel file-editing fan-out; work sequentially.`
  return `${reopenNotice}You are the ORCHESTRATOR for an agentic-pipeline task in the Session Manager app. You own this task end-to-end and drive it through the pipeline by coordinating SEPARATE Claude sessions — you do not write code yourself.

TASK
- taskId: ${task.id}
- title: ${task.title}
- autonomy: ${task.autonomy}   (manual = pause at every hand-off · gated = pause at gates · auto = run unattended)${tagLine}${bodyBlock}${isolationLine}

PIPELINE: Plan → Implement → Review (review⇄implement loop) → Done.

YOUR TOOLS (session-manager MCP):
- emit-milestone({ taskId, text, status?, badge?, tone?, kind? }) — narrate to the board. Call it at EVERY notable step; the user watches this feed. Set kind to colour-code the feed: 'plan-ready' | 'fanout' | 'review-verdict' | 'blocked' | 'done' | 'error' | 'info'.
- spawn-session({ prompt, pipelineTaskId, pipelineRole, pipelineLabel?, fanoutKind?, modelId?, reportBack }) — spawn a stage session or fan-out worker. ALWAYS pass pipelineTaskId="${task.id}". Pass modelId to pick the model for that session (see MODEL SELECTION). Children report back to you automatically.
- pipeline-set-stage({ taskId, stage }) — advance the board (plan|implement|review|done).
- pipeline-request-approval({ taskId, gate, detail }) — pause for the user. Under autonomy=auto it auto-approves and advances; under gated/manual it returns "pending" and you MUST STOP and wait for an approval message before continuing.
- pipeline-get-task({ taskId }) — re-read full state (use this first if you are resuming).
- pipeline-get-artifact({ taskId, kind }) — read a stored hand-off artifact ('plan'|'diff'|'review'). Use this to read review verdicts when deciding the review loop, instead of relaying big content through chat.

MODEL SELECTION — pass modelId on EVERY spawn-session. Defaults (override per task when justified): planner/architect → "opus"; plan research probes (fanoutKind:"research") → "haiku"; implementers → "opus"; per-dimension reviewers → "sonnet"; the final full-diff verification reviewer → "opus". You (the orchestrator) already run on Sonnet — you coordinate only, you do not pick your own model. PER-TASK OVERRIDE: for trivial/mechanical tasks you MAY drop implementers to "sonnet"; for high-stakes or complex changes you MAY escalate per-dimension reviewers to "opus". Spend tokens where code quality is born (planning, implementation, final verification); save where verification breadth or context-gathering dominates (research probes, routine per-dimension review). If you omit modelId, the server applies these same role defaults — but set it explicitly so the choice is visible on the board.

WORKFLOW
1. emit-milestone "Task accepted — planning."
2. Spawn a PLANNER: spawn-session({ pipelineTaskId:"${task.id}", pipelineRole:"plan", pipelineLabel:"Architect", modelId:"opus", reportBack:"true", prompt:"<gather context for: ${task.title}, then produce a concrete implementation plan. You MAY fan out research probes via spawn-session with pipelineTaskId='${task.id}', pipelineRole='plan', fanoutKind='research', modelId:'haiku' (research probes only read/look up — keep them on Haiku). Store the FULL plan with pipeline-put-artifact({ taskId:'${task.id}', kind:'plan', content:<full plan> }), then report back only a 1-2 line summary — do NOT paste the whole plan into chat.>" }).
3. When the planner reports its plan: emit-milestone "Plan ready", then pipeline-request-approval({ gate:"Begin implementation", detail:"<one-line plan summary>" }). If pending → STOP and wait. When approved/auto-approved → continue.
4. pipeline-set-stage "implement". Spawn an IMPLEMENTER (pipelineRole:"implement", modelId:"opus" — this is where code quality is born; only drop to "sonnet" for a trivial/mechanical task). Instruct it to FIRST call pipeline-get-artifact({ taskId:"${task.id}", kind:"plan" }) to fetch the full approved plan, implement it, and when done call pipeline-put-artifact({ taskId:"${task.id}", kind:"diff", content:<short summary of what changed> }) before reporting back a 1-2 line summary. Wait for it to report completion.
   PARALLEL WORKTREE FAN-OUT (when the work splits cleanly into independent pieces): spawn each worker with modelId:"opus" (unless trivial), isolate:true, a UNIQUE worktreeBranch (a short descriptive label, e.g. "csv-export", "auth-guard"), fanoutKind:"worktrees", and a descriptive pipelineLabel. Each worker builds in its OWN isolated git worktree+branch, so they can't clobber each other. When a worker reports it has FINISHED, call merge-worktree({ taskId:"${task.id}", sessionId:<that worker's id> }): on success the branch is merged, its worktree removed, and the node goes read-only; on "MERGE CONFLICT" send-message that worker to resolve the conflict in its (still-present) worktree and then re-call merge-worktree, OR spawn a fix worker for it. Only advance to review once ALL workers are merged. NOTE: if the project is not a git repo, isolation is skipped automatically (a warning milestone is emitted) and workers run in the shared dir — in that case do NOT fan out into parallel worktrees; run sequentially instead.
5. pipeline-set-stage "review". Spawn ONE reviewer session per RELEVANT dimension below (pipelineRole:"review", fanoutKind:"topics", pipelineLabel:<dimension>, modelId:"sonnet" — verification fans out N×, so keep per-dimension review cheap; escalate a single dimension to "opus" only when the change is high-stakes for that concern). Give each reviewer a SPECIFIC, contextual prompt scoped to THIS change — name the exact files/areas to inspect and what to check (e.g. "Inspect the auth changes in src/x.ts and verify the new token check can't be bypassed"). Do NOT spawn generic "security reviewer" sessions; write the concern into the prompt. Skip dimensions that don't apply to this change.
   Review dimensions to consider:
   - Correctness/logic — does it match the plan; edge cases handled
   - Bugs/runtime safety — null/undefined, async, error handling, regressions
   - Security — input validation, authz, secrets, unsafe calls (only if the change touches these)
   - Architecture/design — fits existing patterns, coupling, abstractions
   - Tests — coverage present and passing
   - Performance — only if the change touches hot paths
   Each reviewer should FIRST call pipeline-get-artifact({ taskId:"${task.id}", kind:"plan" }) (and kind:"diff") for context, then store its verdict with pipeline-put-artifact({ taskId:"${task.id}", kind:"review", content:<verdict + specifics> }) and report back only a 1-2 line summary. (For per-dimension verdicts use a kind like "review:security" so they don't overwrite each other.) Read the full verdicts via pipeline-get-artifact kind:"review" to decide the loop. Collect all verdicts and emit-milestone a one-line summary each round. If any request changes, spawn an implementer (pipelineRole:"implement", modelId:"opus") to fix, then RE-REVIEW — re-run only the dimensions that failed. LOOP until all relevant reviewers pass.
5b. FINAL VERIFICATION (Opus) — after ALL per-dimension reviewers pass and BEFORE any "Merge to Done" gate, spawn ONE final reviewer: spawn-session({ pipelineTaskId:"${task.id}", pipelineRole:"review", modelId:"opus", pipelineLabel:"Final verification", fanoutKind:"topics", reportBack:"true", prompt:"<FIRST call pipeline-get-artifact({ taskId:'${task.id}', kind:'diff' }) and ({ kind:'plan' }). Verify the FULL assembled change end-to-end against this rubric = the task's full intent (the todo body / TASK DETAILS above). Check the change is complete, correct, internally consistent, and free of regressions the per-dimension reviewers may have missed. Store your verdict with pipeline-put-artifact({ taskId:'${task.id}', kind:'review:final', content:<PASS/CHANGES-REQUESTED + specifics> }), then report back a 1-2 line summary.>" }). This guarantees a weaker (Sonnet) reviewer never has the last word over Opus-written code. If final verification REQUESTS CHANGES → spawn an implementer (pipelineRole:"implement", modelId:"opus") to fix → re-run the affected per-dimension reviewers → re-run final verification. Only when final verification PASSES → proceed to step 6.
6. pipeline-request-approval({ gate:"Merge to Done" }). When approved/auto → pipeline-set-stage "done". The set-stage response includes an "integration" result: only when integration.ok is true is the task actually Done (emit-milestone "Done."). If integration.ok is false there was a MERGE CONFLICT integrating your task branch into the integration branch — the card is held in Review (NOT Done), the worktree is kept, and integration.conflicts lists the conflicting files. In that case do NOT report success: emit-milestone a 'blocked'/'error' note, then spawn an implementer (pipelineRole:"implement") in the task worktree to merge the integration branch in and resolve the conflicts (or raise a gate for the user), and re-call pipeline-set-stage "done" to re-attempt integration. Loop until integration.ok is true.

RULES
- Pass pipelineTaskId="${task.id}" on every spawn so sessions slot into this task's tree.
- Give every session you spawn a DESCRIPTIVE pipelineLabel so the user can tell them apart on the board, e.g. "Architect", "Implement · CSV serializer", "Security review · auth token check". You can relabel any child later with pipeline-rename-session({ taskId:"${task.id}", sessionId, label }).
- Respect autonomy: under manual/gated, request approval at gates and WAIT; under auto, proceed.
- When a spawned session reports it has FINISHED, mark it done so it can be cleaned up (frees resources): emit-milestone({ taskId:"${task.id}", sessionId:<that session's id>, status:"done", text:"<short>" }). All sessions are torn down automatically when the task reaches Done.
- You coordinate only — never edit code or run builds yourself; delegate to spawned sessions.
- CONTEXT HYGIENE: keep worker prompts TIGHT — give each session only the context it needs and point it at artifacts (pipeline-get-artifact) rather than pasting large content into prompts. Tell long-running workers (e.g. a big implementer) that they MAY run /compact if their own context balloons. Keep your own coordination chatter lean so this Sonnet conversation stays cheap over the life of the task.

Begin now.`
}

/** Resolve the working directory for a task's orchestrator + stage sessions,
 *  creating or reusing its isolated git worktree. Per-task isolation runs the
 *  whole task in its OWN worktree on a per-task branch so concurrent tasks can't
 *  collide. Reuse the existing worktree when it is still on disk (preserves WIP
 *  on a reopen); recreate it if it was merged+removed; fall back to the shared
 *  dir if the project isn't a git repo. */
function ensureTaskWorktree(task: pipelineStore.PipelineTask): { cwd: string; isolated: boolean } {
  const baseDir = task.projectPath || loadSettings().baseProjectsDir || app.getPath('home')
  // Reuse an existing on-disk worktree (e.g. a reopened, not-yet-merged task).
  if (task.repoRoot && task.worktreePath && task.worktreeBranch && existsSync(task.worktreePath)) {
    return { cwd: task.worktreePath, isolated: true }
  }
  const repoRoot = gitWorktree.getRepoRoot(baseDir)
  if (repoRoot) {
    try {
      const branch = gitWorktree.branchNameFor(task.id, 'task')
      const ref = gitWorktree.addWorktree({ repoRoot, taskId: task.id, branch })
      pipelineStore.setTaskWorktree(task.id, { repoRoot, worktreePath: ref.worktreePath, worktreeBranch: ref.branch })
      return { cwd: ref.worktreePath, isolated: true }
    } catch (err) {
      console.error('[hook-server] per-task worktree creation failed; running in shared dir:', err)
    }
  }
  return { cwd: baseDir, isolated: false }
}

/** Resolve the working directory for a SEND-TO-REVIEW task. Unlike
 *  ensureTaskWorktree, working-tree mode NEVER gets a worktree — a fresh
 *  worktree is a clean checkout and can't see the uncommitted edits we're here
 *  to review, so the orchestrator + fixers must run in the real project dir. */
function ensureReviewWorkdir(task: pipelineStore.PipelineTask): { cwd: string; isolated: boolean; repoRoot: string | null } {
  const baseDir = task.projectPath || loadSettings().baseProjectsDir || app.getPath('home')
  const repoRoot = gitWorktree.getRepoRoot(baseDir)
  const ds = task.diffSource ?? { kind: 'working-tree' as const }
  if (ds.kind === 'working-tree') {
    // MUST run in the real project dir — that's where the uncommitted edits live.
    return { cwd: baseDir, isolated: false, repoRoot }
  }
  // range: `git diff base...target` needs no checkout, so v1 reviews read-only
  // from the repo root (shared dir) and lets fixers commit to `target`. FUTURE:
  // for isolation, create a worktree on `target` lazily only when a fix is
  // required (via gitWorktree.addWorktree + setTaskWorktree so
  // finalizeTaskCompletion cleans it up). Not built in v1.
  return { cwd: baseDir, isolated: false, repoRoot }
}

/** Build the orchestrator prompt for a SEND-TO-REVIEW task. The work already
 *  exists (written outside the pipeline); the orchestrator does NOT plan or
 *  implement from scratch — it reviews the given diff against the rubric (the
 *  todo body) and drives a fix loop until clean. Reuses ORCHESTRATOR_TOOLS. */
function buildReviewOrchestratorPrompt(
  task: pipelineStore.PipelineTask,
  diff: gitWorktree.DiffResult,
): string {
  const tagLine = task.tags.length ? `\n- tags: ${task.tags.join(', ')}` : ''
  const rubricBlock = task.body && task.body.trim()
    ? `\n- RUBRIC (the user's intent / acceptance criteria — what the change MUST achieve):\n  """\n${task.body.trim()}\n  """`
    : `\n- RUBRIC: (no todo body provided — judge the diff on correctness/safety and infer intent from the title)`
  const ds = task.diffSource ?? { kind: 'working-tree' as const }
  const sourceLine = ds.kind === 'working-tree'
    ? `working-tree (uncommitted changes in the project dir)`
    : `range ${ds.base}...${ds.target} (committed work)`
  const isolationLine = ds.kind === 'working-tree'
    ? `running IN PLACE in the shared project dir, NOT a worktree — fixers edit files directly; do NOT fan out into parallel worktrees`
    : `reviewing a committed range read-only from the repo root; if a fix is needed, fixers commit to ${ds.target}`
  const diffNote = !diff.ok
    ? `\n\n⚠ DIFF UNAVAILABLE: ${diff.error}. There is nothing concrete to review. Emit a 'blocked' milestone and raise a gate (gated/manual) or mark done with a note (auto) — do NOT fabricate a diff.`
    : diff.empty
      ? `\n\n⚠ EMPTY DIFF: the selected diff source has no changes. Emit a 'blocked'/warn milestone and raise a gate or mark done with a note — there is nothing to review.`
      : diff.truncated
        ? `\n\nNOTE: the diff is large and was TRUNCATED in storage. Reviewers should still read the 'diff' artifact, but be aware the tail may be cut.`
        : ``
  return `You are the ORCHESTRATOR for a SEND-TO-REVIEW pipeline task in the Session Manager app. Existing work — written OUTSIDE the pipeline — must be reviewed against the user's intent. You do NOT plan or implement from scratch; you review a given diff and drive a fix loop until it's clean. You do not write code yourself — you coordinate SEPARATE Claude sessions.

TASK
- taskId: ${task.id}
- title: ${task.title}
- autonomy: ${task.autonomy}   (manual = pause at every hand-off · gated = pause at gates · auto = run unattended)${tagLine}${rubricBlock}
- DIFF SOURCE: ${sourceLine}
- ISOLATION: ${isolationLine}

The full git DIFF is stored as the 'diff' artifact and the RUBRIC as the 'rubric' artifact. Reviewers read those via pipeline-get-artifact rather than getting them pasted into chat.${diffNote}

YOUR TOOLS (session-manager MCP):
- emit-milestone({ taskId, text, status?, badge?, tone?, kind? }) — narrate to the board at EVERY notable step. kind: 'fanout' | 'review-verdict' | 'blocked' | 'done' | 'error' | 'info'.
- spawn-session({ prompt, pipelineTaskId, pipelineRole, pipelineLabel?, fanoutKind?, reportBack }) — spawn a reviewer or fixer. ALWAYS pass pipelineTaskId="${task.id}".
- pipeline-set-stage({ taskId, stage }) — advance the board (you are already at 'review'; the only move is to 'done').
- pipeline-request-approval({ taskId, gate, detail }) — pause for the user. Under autonomy=auto it auto-approves; under gated/manual it returns "pending" and you MUST STOP and wait for an approval message.
- pipeline-get-task({ taskId }) — re-read full state (use first if resuming).
- pipeline-get-artifact({ taskId, kind }) — read 'diff', 'rubric', or a 'review:<dimension>' verdict.

WORKFLOW
1. emit-milestone "Reviewing existing work." (kind:'info'). You are already at the 'review' stage — there is NO plan/implement stage.
2. Fan out ONE reviewer per RELEVANT dimension (pipelineRole:"review", fanoutKind:"topics", pipelineLabel:<dimension>). Each reviewer FIRST calls pipeline-get-artifact({ taskId:"${task.id}", kind:"diff" }) and kind:"rubric", then judges whether the diff (a) is correct/safe AND (b) actually satisfies the rubric — catching both bugs AND "doesn't do what was asked". Store its verdict via pipeline-put-artifact({ taskId:"${task.id}", kind:"review:<dimension>", content:<verdict + specifics> }) and report back only a 1-2 line summary. Give each a SPECIFIC prompt naming the exact files/areas to inspect; skip dimensions that don't apply.
   Dimensions to consider: Correctness vs rubric · Bugs/runtime safety · Security (if touched) · Architecture/design · Tests · Performance (if hot paths).
3. Read the verdicts via pipeline-get-artifact. Collect them and emit-milestone a one-line summary each round (kind:'review-verdict'). If any reviewer requests changes → spawn a FIXER (pipelineRole:"implement") to apply the fixes IN THE REVIEW WORKDIR (${ds.kind === 'working-tree' ? 'the shared project dir — run fixers SEQUENTIALLY, no parallel worktrees' : `committing to ${ds.target}`}), then RE-REVIEW only the dimensions that failed. LOOP until all relevant reviewers pass.
4. pipeline-request-approval({ gate:"Mark reviewed / Done", detail:"<one-line summary>" }). If pending → STOP and wait. On approval/auto → pipeline-set-stage "done", then emit-milestone "Done." (kind:'done').

RULES
- Pass pipelineTaskId="${task.id}" on every spawn so sessions slot into this task's tree.
- Give every session a DESCRIPTIVE pipelineLabel (e.g. "Security review · auth token check", "Fix · null guard").
- Respect autonomy: under manual/gated, request approval at gates and WAIT; under auto, proceed.
- When a spawned session reports it has FINISHED, mark it done: emit-milestone({ taskId:"${task.id}", sessionId:<that session's id>, status:"done", text:"<short>" }).
- You coordinate only — never edit code or run builds yourself; delegate to spawned sessions.

Begin now.`
}

/** Spawn the orchestrator session for a task and register it as the tree root.
 *  Called from the renderer's pipeline:start IPC. When `reopenedFrom` is set the
 *  orchestrator prompt is annotated that this is a REOPENED task (a prior
 *  completion is void). */
export function spawnPipelineOrchestrator(
  task: pipelineStore.PipelineTask,
  opts: { reopenedFrom?: pipelineStore.PipelineStage } = {},
): { id: string } {
  let cwd: string
  let isolated: boolean
  let prompt: string
  // For review tasks, the resolved diff so we can emit board milestones AFTER the
  // orchestrator node is registered (emitting before upsert would create a phantom
  // root node keyed to task.id and break the orchestrator-is-root invariant).
  let reviewDiff: gitWorktree.DiffResult | null = null
  if (task.startStage === 'review') {
    // SEND-TO-REVIEW: resolve the diff, store rubric + diff artifacts BEFORE
    // building the prompt (the task already exists in the store). Board
    // milestones for non-git / empty / truncated cases are emitted later (after
    // upsertPipelineSession) so they land on the real orchestrator's feed.
    const wd = ensureReviewWorkdir(task)
    cwd = wd.cwd; isolated = wd.isolated
    const source = task.diffSource ?? { kind: 'working-tree' as const }
    const diff: gitWorktree.DiffResult = wd.repoRoot
      ? gitWorktree.resolveDiff(source, { workdir: cwd, repoRoot: wd.repoRoot })
      : { ok: false, empty: true, diff: '', files: [], error: 'not a git repository' }
    if (task.body?.trim()) pipelineStore.putArtifact(task.id, 'rubric', task.body.trim())
    pipelineStore.putArtifact(task.id, 'diff', diff.ok ? diff.diff : `(diff unavailable: ${diff.error})`)
    reviewDiff = diff
    prompt = buildReviewOrchestratorPrompt(task, diff)
  } else {
    const r = ensureTaskWorktree(task)
    cwd = r.cwd; isolated = r.isolated
    prompt = buildOrchestratorPrompt(task, isolated, opts.reopenedFrom)
  }
  const id = randomUUID()
  // Auto permission mode so it can call its (scoped) tools without prompts.
  // The orchestrator runs on Sonnet — it coordinates only and never edits code,
  // so the long-lived token sink stays on the cheaper tier.
  const args = ['--model', MODEL_IDS.sonnet, '--permission-mode', 'auto', '--allowedTools', ...ORCHESTRATOR_TOOLS, '--', prompt]
  const session = spawnSession(id, cwd, 'claude', args)

  if (attachListenersFn) attachListenersFn(id, session)

  registry.setOrigin(id, {
    kind: 'pipeline',
    pipelineTaskId: task.id,
    pipelineRole: 'orchestrator',
    pipelineLabel: 'Orchestrator',
    label: `Orchestrator · ${task.title}`,
  })

  pipelineStore.upsertPipelineSession(task.id, {
    id,
    role: 'orchestrator',
    label: 'Orchestrator',
    status: 'working',
    badge: 'starting',
    tone: 'active',
    modelId: MODEL_IDS.sonnet,
    claudeSessionId: session.claudeSessionId ?? null,
    cwd,
  })

  // Surface non-git / empty / truncated review cases on the orchestrator's own
  // feed — emitted AFTER upsert so the orchestrator node is the registered root
  // (keying to `id`, the real orchestrator UUID, not task.id).
  if (reviewDiff) {
    if (!reviewDiff.ok) {
      pipelineStore.emitMilestone(task.id, id, { text: `⚠ ${reviewDiff.error} — nothing to review.`, tone: 'fail', kind: 'blocked' })
    } else if (reviewDiff.empty) {
      pipelineStore.emitMilestone(task.id, id, { text: 'No changes found for the selected diff source.', tone: 'warn', kind: 'blocked' })
    } else if (reviewDiff.truncated) {
      pipelineStore.emitMilestone(task.id, id, { text: 'Diff is large — stored copy was truncated for review.', tone: 'warn', kind: 'info' })
    }
  }

  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('session:spawned', { id, projectPath: cwd, claudeSessionId: session.claudeSessionId ?? null, isPipeline: true })
  }
  broadcastPipeline()

  console.log(`[hook-server] spawned orchestrator ${id} for task ${task.id} in ${cwd}`)
  return { id }
}

// ── Pipeline orchestrator auto-resume on app relaunch ───────────────────────

/** Short continuation nudge for a resumed orchestrator (NOT the full task brief —
 *  it recovers that via pipeline-get-task). Executed immediately on resume. The
 *  paused branch tells the orchestrator it was deliberately stopped (not crashed)
 *  so it re-establishes any fan-out workers the current stage needs rather than
 *  assuming they're still live. */
function buildOrchestratorResumePrompt(task: pipelineStore.PipelineTask): string {
  const lead = task.paused
    ? `You are RESUMING after a deliberate PAUSE. Your previous run was gracefully stopped; any in-flight worker sessions were torn down, but the task worktree and your conversation are intact. Re-spawn whatever workers the current stage needs.`
    : `You are RESUMING after an app restart. Your previous run was interrupted mid-task.`
  return [
    lead,
    `Call pipeline-get-task({ taskId: "${task.id}" }) to reload the current stage, session tree,`,
    `and any hand-off artifacts (pipeline-get-artifact), then CONTINUE the pipeline from where it`,
    `left off. The current stage is "${task.stage}". Do NOT redo already-completed stages.`,
    `Always pass pipelineTaskId="${task.id}" on every spawn/milestone so work slots into this tree.`,
  ].join(' ')
}

/** Grace window for best-effort resume-failure detection. A successfully resumed
 *  orchestrator runs far longer than this; an exit within it means the resume
 *  never really took (transcript gone, or it exited without continuing). */
const RESUME_GRACE_MS = 10_000

/** Best-effort live resume of a task's orchestrator on relaunch. Spawns
 *  `claude --resume <claudeSessionId>` in the node's recorded cwd, re-keys the
 *  orchestrator node onto the fresh PTY id, and nudges it to recover context.
 *  Returns 'resumed' | 'skipped-live' | 'failed'. */
export function resumePipelineOrchestrator(
  task: pipelineStore.PipelineTask,
): 'resumed' | 'skipped-live' | 'failed' {
  const node = task.orchestrator
  const cid = node?.claudeSessionId
  const cwd = node?.cwd
  if (!node || !cid) return 'failed'

  // EDGE: orchestrator already running (renderer-crash reload, or double trigger) → skip.
  const alreadyLive = getActiveSessions().some(
    (s) => s.claudeSessionId === cid || s.id === node.id,
  )
  if (alreadyLive) return 'skipped-live'

  // EDGE: working dir gone (worktree removed) → can't resume → read-only.
  if (!cwd || !existsSync(cwd)) {
    pipelineStore.markSessionResumeFailed(task.id, node.id)
    broadcastPipeline()
    return 'failed'
  }

  const id = randomUUID()
  const resumeStartedAt = Date.now()
  const prompt = buildOrchestratorResumePrompt(task)
  // Re-pass scoped tools + auto perms (they don't persist across CLI invocations).
  // Re-pass --model sonnet too: this keeps the resumed conversation on the SAME
  // tier the orchestrator already ran on (not a model switch). Harmless if the
  // CLI ignores --model alongside --resume.
  // Positional `-- prompt` executes immediately on resume (mirrors the fresh-spawn path).
  const args = ['--model', MODEL_IDS.sonnet, '--permission-mode', 'auto', '--allowedTools', ...ORCHESTRATOR_TOOLS, '--resume', cid, '--', prompt]
  let session: ReturnType<typeof spawnSession>
  try {
    session = spawnSession(id, cwd, 'claude', args)
  } catch (err) {
    console.error('[hook-server] orchestrator resume spawn failed:', err)
    pipelineStore.markSessionResumeFailed(task.id, node.id)
    broadcastPipeline()
    return 'failed'
  }
  if (attachListenersFn) attachListenersFn(id, session)

  // Re-key the node onto the fresh PTY id BEFORE the resumed process emits anything,
  // so emitMilestone/upsertPipelineSession (keyed by id) hit the existing node
  // instead of forking a duplicate root/child.
  const oldId = node.id
  registry.rekeyOrigin(oldId, id)
  pipelineStore.rekeyPipelineSession(task.id, oldId, {
    id,
    claudeSessionId: session.claudeSessionId ?? cid,
    cwd,
  })

  // Best-effort failure detection via a TIME-BASED grace window. A healthy
  // resumed orchestrator keeps running far longer than the grace window, whereas
  // a transcript-gone failure (`claude --resume` on a missing/bad session file)
  // exits within a second or two — usually AFTER the TUI has already painted a
  // frame, so the old `!alive` gate almost never fired. Instead, treat any exit
  // INSIDE the grace window as a non-continued resume, regardless of output:
  //   • non-zero exit  → transcript gone → mark the (re-keyed) node read-only;
  //   • clean exit (0) → did no work     → drop the 'resuming' badge + settle to
  //                                          idle so the node isn't stuck showing
  //                                          "resuming" forever this session.
  // An exit AFTER the window is a normal long-lived teardown and is left alone.
  // node-pty allows multiple onExit listeners, so this coexists with
  // attachSessionListeners' own onExit. markSessionResumeFailed/emitMilestone are
  // keyed by `id`, so if the node was re-keyed away or torn down they no-op —
  // and `handled` guards against acting twice.
  let handled = false
  session.process.onExit(({ exitCode }) => {
    if (handled) return
    if (Date.now() - resumeStartedAt >= RESUME_GRACE_MS) return
    // A deliberate pause kills the orchestrator PTY inside the grace window, which
    // would otherwise look like a crashed/failed resume. If the task is paused at
    // exit time the exit was intentional — skip the failure marking + milestone so
    // pausePipelineTask's own idle/'paused' settle (already applied) stands and the
    // node stays resumable (not flipped read-only).
    if (pipelineStore.getPipelineTask(task.id)?.paused) return
    handled = true
    if (exitCode !== 0) {
      pipelineStore.markSessionResumeFailed(task.id, id)
      pipelineStore.emitMilestone(task.id, id, {
        text: 'Live resume failed — transcript unavailable. Node is read-only.',
        kind: 'error', tone: 'fail', status: 'idle',
      })
    } else {
      pipelineStore.emitMilestone(task.id, id, {
        text: 'Resumed process exited early without continuing the task. Node is idle until the next relaunch.',
        kind: 'info', tone: 'neutral', status: 'idle', badge: '',
      })
    }
    broadcastPipeline()
  })

  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('session:spawned', { id, projectPath: cwd, claudeSessionId: session.claudeSessionId ?? cid, isPipeline: true })
  }
  // Refresh badge/tone on the already-re-keyed node (its id now matches).
  pipelineStore.upsertPipelineSession(task.id, {
    id,
    role: 'orchestrator',
    label: node.label,
    status: 'working',
    badge: 'resuming',
    tone: 'active',
    modelId: MODEL_IDS.sonnet,
    claudeSessionId: session.claudeSessionId ?? cid,
    cwd,
  })
  broadcastPipeline()
  console.log(`[hook-server] resumed orchestrator ${oldId}→${id} for task ${task.id} (claude ${cid})`)
  return 'resumed'
}

/** On a true app relaunch, resume every in-flight `auto` task's orchestrator.
 *  Gated/manual tasks are intentionally skipped (on-demand drawer resume only).
 *  Best-effort and independent per task. Returns a summary for logging. */
export function autoResumeInflightOrchestrators(): { resumed: number; skipped: number; failed: number } {
  const tasks = pipelineStore.getInflightAutoTasks()
  let resumed = 0, skipped = 0, failed = 0
  for (const task of tasks) {
    try {
      const r = resumePipelineOrchestrator(task)
      if (r === 'resumed') resumed++
      else if (r === 'skipped-live') skipped++
      else failed++
    } catch (err) {
      console.error('[hook-server] pipeline orchestrator auto-resume failed for task', task.id, err)
      failed++
    }
  }
  // NB: this counts in-flight auto-pipeline ORCHESTRATORS only — not regular
  // terminal sessions (those restore via the renderer's saved-sessions path).
  // total:0 simply means there were no running auto-pipelines to resume.
  console.log('[hook-server] pipeline orchestrator auto-resume summary:', { pipelineTasks: tasks.length, resumed, skipped, failed })
  return { resumed, skipped, failed }
}

export interface StartPipelineResult {
  ok: boolean
  alreadyRunning: boolean
  taskId: string
  orchestratorSessionId: string | null
  tasks: pipelineStore.PipelineTask[]
}

/** Shared backlog→pipeline start path used by BOTH the renderer IPC
 *  (pipeline:start) and the pipeline-start MCP tool. Reads the todo, creates the
 *  PipelineTask, spawns the orchestrator (per-task worktree isolation), and
 *  broadcasts pipeline:changed. Idempotent: if the todo is already a running task
 *  it returns alreadyRunning:true without re-spawning. Throws if the todo does
 *  not exist (notesManager.readTodo throws "Todo not found: <id>"). */
export function startPipelineTaskFlow(opts: {
  todoId: string
  defaultAutonomy?: pipelineStore.AutonomyLevel
  projectPath?: string
  startStage?: pipelineStore.PipelineStage
  diffSource?: pipelineStore.DiffSource
}): StartPipelineResult {
  // Double-start guard: a todo already on the board is a no-op (mirrors the UI
  // hiding started todos from the backlog). Report it instead of re-spawning.
  const existing = pipelineStore.getPipelineTask(opts.todoId)
  if (existing) {
    return {
      ok: true,
      alreadyRunning: true,
      taskId: existing.id,
      orchestratorSessionId: existing.orchestrator?.id ?? null,
      tasks: pipelineStore.getPipelineTasks(),
    }
  }
  // Pull the full todo (title/tags/body) so the orchestrator gets the user's
  // detailed intent, not just the title. Throws if the todo is gone.
  const todo = notesManager.readTodo(opts.todoId)
  // Honour a per-todo autonomy choice persisted from the backlog card (the
  // `autonomy:<level>` tag) over the global default; fall back to today's default.
  const tagged = todo.tags.find((t) => t.startsWith('autonomy:'))?.slice('autonomy:'.length)
  const fromTag = (tagged === 'manual' || tagged === 'gated' || tagged === 'auto') ? tagged : undefined
  const autonomy = fromTag ?? opts.defaultAutonomy ?? 'gated'
  // Derive projectPath: explicit param → baseProjectsDir/<project-tag-name> →
  // baseProjectsDir. Final fallback to home happens in ensureTaskWorktree.
  let projectPath = opts.projectPath
  if (!projectPath) {
    const baseDir = loadSettings().baseProjectsDir
    const projectTag = todo.tags.find((t) => t.startsWith('project:'))
    const name = projectTag?.slice('project:'.length)
    projectPath = baseDir ? (name ? `${baseDir}/${name}` : baseDir) : undefined
  }
  pipelineStore.startPipelineTask(
    { id: todo.id, title: todo.title, tags: todo.tags, body: todo.body },
    autonomy,
    projectPath,
    { startStage: opts.startStage, diffSource: opts.diffSource },
  )
  // Spawn the real orchestrator session for newly-started tasks.
  const task = pipelineStore.getPipelineTask(todo.id)
  let orchestratorSessionId: string | null = task?.orchestrator?.id ?? null
  if (task && !task.orchestrator) {
    try { orchestratorSessionId = spawnPipelineOrchestrator(task).id }
    catch (err) { console.error('[pipeline] orchestrator spawn failed:', err) }
  }
  broadcastPipeline()
  return {
    ok: true,
    alreadyRunning: false,
    taskId: todo.id,
    orchestratorSessionId,
    tasks: pipelineStore.getPipelineTasks(),
  }
}

// ── Pipeline session teardown ───────────────────────────────────────────────
// Finished pipeline sessions are killed to free resources (each idle session is
// a live `claude` process + a WebGL terminal context). Their pointer + milestone
// feed live on in pipeline.json, and the transcript on disk, so they can be
// resumed on demand later. A short grace period avoids cutting off a session
// that just emitted its final milestone.

const teardownTimers = new Map<string, ReturnType<typeof setTimeout>>()
const TEARDOWN_GRACE_MS = 6000

function scheduleSessionTeardown(appSessionId: string): void {
  if (teardownTimers.has(appSessionId)) return
  const timer = setTimeout(() => {
    teardownTimers.delete(appSessionId)
    try {
      killSession(appSessionId)
      cleanupSession(appSessionId)
      console.log(`[hook-server] tore down finished pipeline session ${appSessionId}`)
    } catch (err) {
      console.error('[hook-server] pipeline teardown failed:', err)
    }
  }, TEARDOWN_GRACE_MS)
  teardownTimers.set(appSessionId, timer)
}

// ── Ephemeral idle reclaim ──────────────────────────────────────────────────
// Drawer "view-resume" PTYs are spawned ephemeral and torn down when the drawer
// closes. If the app crashes mid-view, that `claude` process is orphaned until
// quit. This backstop sweeps idle ephemeral sessions and reclaims them, reusing
// the teardownTimers + grace + killSession/cleanupSession machinery above.

const IDLE_REAP_MS = 120_000      // 2 min
const SWEEP_INTERVAL_MS = 30_000  // poll every 30s
let ephemeralSweepTimer: ReturnType<typeof setInterval> | null = null

// Re-validating reap: shares teardownTimers + TEARDOWN_GRACE_MS + killSession +
// cleanupSession, but re-checks idle/ephemeral AT FIRE TIME so a drawer that
// re-adopts + re-activates this PTY inside the grace window is NOT killed.
function scheduleEphemeralReap(id: string): void {
  if (teardownTimers.has(id)) return
  const timer = setTimeout(() => {
    teardownTimers.delete(id)
    const s = getSession(id)
    const last = lastPtyActivity.get(id) ?? 0
    if (!s?.ephemeral || Date.now() - last < IDLE_REAP_MS) return  // re-adopted / active again
    try {
      killSession(id)
      cleanupSession(id)
      console.log(`[hook-server] reaped idle ephemeral session ${id}`)
    } catch (err) {
      console.error('[hook-server] ephemeral reap failed:', err)
    }
  }, TEARDOWN_GRACE_MS)
  teardownTimers.set(id, timer)
}

function sweepIdleEphemeralSessions(): void {
  const now = Date.now()
  for (const s of getAllSessions()) {
    if (!s.ephemeral || teardownTimers.has(s.id)) continue
    const last = lastPtyActivity.get(s.id)
    if (last == null) { lastPtyActivity.set(s.id, now); continue }  // just-resumed grace window
    if (now - last >= IDLE_REAP_MS) scheduleEphemeralReap(s.id)
  }
}

function startEphemeralSweep(): void {
  if (ephemeralSweepTimer) return
  ephemeralSweepTimer = setInterval(sweepIdleEphemeralSessions, SWEEP_INTERVAL_MS)
  ephemeralSweepTimer.unref?.()
}

function stopEphemeralSweep(): void {
  if (ephemeralSweepTimer) {
    clearInterval(ephemeralSweepTimer)
    ephemeralSweepTimer = null
  }
}

// ── Pipeline endpoint handlers ──────────────────────────────────────────────

function readJson<T>(body: string): T {
  return JSON.parse(body) as T
}

/** Launch a backlog todo into the pipeline (shared by the renderer IPC and the
 *  pipeline-start MCP tool, both via startPipelineTaskFlow). A missing todo maps
 *  to 404 (readTodo throws "Todo not found"); other failures are 500. */
function handlePipelineStart(body: string, res: import('http').ServerResponse): void {
  try {
    const { todoId, defaultAutonomy, projectPath, startStage, diffSource } =
      readJson<{
        todoId: string
        defaultAutonomy?: pipelineStore.AutonomyLevel
        projectPath?: string
        startStage?: pipelineStore.PipelineStage
        diffSource?: pipelineStore.DiffSource
      }>(body)
    if (!todoId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'todoId required' }))
      return
    }
    const result = startPipelineTaskFlow({ todoId, defaultAutonomy, projectPath, startStage, diffSource })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: result.ok,
      alreadyRunning: result.alreadyRunning,
      taskId: result.taskId,
      orchestratorSessionId: result.orchestratorSessionId,
    }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const notFound = /not found/i.test(msg)
    res.writeHead(notFound ? 404 : 500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: msg, todoNotFound: notFound }))
  }
}

function handlePipelineGetTask(body: string, res: import('http').ServerResponse): void {
  try {
    const { taskId } = readJson<{ taskId: string }>(body)
    const task = pipelineStore.getPipelineTask(taskId)
    res.writeHead(task ? 200 : 404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(task ?? { error: `Pipeline task ${taskId} not found` }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

function handlePipelineSetStage(body: string, res: import('http').ServerResponse): void {
  void (async (): Promise<void> => {
    try {
      const { taskId, stage } = readJson<{ taskId: string; stage: pipelineStore.PipelineStage }>(body)
      if (stage === 'done') {
        // Done is contingent on a clean merge: integrate FIRST, advance only on
        // success. On conflict the card is HELD in Review (not Done) with a
        // visible conflict badge + the worktree kept — see finalizeTaskCompletion.
        const integ = await finalizeTaskCompletion(taskId)
        const current = pipelineStore.getPipelineTask(taskId)?.stage ?? stage
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: integ.ok, stage: current, integration: integ }))
        return
      }
      pipelineStore.setPipelineStage(taskId, stage)
      broadcastPipeline()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, stage }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    }
  })()
}

function handlePipelineEmit(body: string, res: import('http').ServerResponse): void {
  try {
    const { taskId, sessionId, ...patch } = readJson<{ taskId: string; sessionId: string } & pipelineStore.MilestonePatch>(body)
    const { found } = pipelineStore.emitMilestone(taskId, sessionId, patch)
    if (!found) {
      // The task is no longer on the board — emitting was a silent no-op before,
      // which masked a dropped task. Surface it so the orchestrator notices.
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Pipeline task ${taskId} not found`, unknownTask: true }))
      return
    }
    broadcastPipeline()
    // A finished worker → tear it down (keep its pointer + feed for resume).
    if (patch.status === 'done') scheduleSessionTeardown(sessionId)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

function handlePipelineApproval(body: string, res: import('http').ServerResponse): void {
  void (async (): Promise<void> => {
    try {
      const { taskId, gate, detail } = readJson<{ taskId: string; gate: string; detail?: string }>(body)
      const result = pipelineStore.requestApproval(taskId, gate, detail ?? '')
      broadcastPipeline()
      // Under `auto`, requestApproval optimistically advances the stage — if that
      // lands on Done, the per-task branch must still integrate cleanly. Re-run
      // the gated completion so a conflict holds the card in Review (not Done).
      if (result.decision === 'auto-approved' && result.stage === 'done') {
        const integ = await finalizeTaskCompletion(taskId)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ...result, stage: pipelineStore.getPipelineTask(taskId)?.stage ?? result.stage, integration: integ }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    }
  })()
}

function handlePipelineRename(body: string, res: import('http').ServerResponse): void {
  try {
    const { taskId, sessionId, label } = readJson<{ taskId: string; sessionId: string; label: string }>(body)
    pipelineStore.renamePipelineSession(taskId, sessionId, label)
    broadcastPipeline()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

/** Store a hand-off artifact (plan/diff/review). No broadcast — artifacts live
 *  off the board, so they never touch the renderer mirror. */
function handlePipelinePutArtifact(body: string, res: import('http').ServerResponse): void {
  try {
    const { taskId, kind, content, sessionId } = readJson<{ taskId: string; kind: string; content: string; sessionId?: string }>(body)
    if (!taskId || !kind || typeof content !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'taskId, kind, content required' }))
      return
    }
    const found = pipelineStore.putArtifact(taskId, kind, content, sessionId)
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Pipeline task ${taskId} not found`, unknownTask: true }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, kind, bytes: content.length }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

/** Read a hand-off artifact. A missing artifact is a NORMAL state (found:false,
 *  200) — not an error — so downstream stages can probe without failing. */
function handlePipelineGetArtifact(body: string, res: import('http').ServerResponse): void {
  try {
    const { taskId, kind } = readJson<{ taskId: string; kind: string }>(body)
    const a = pipelineStore.getArtifact(taskId, kind)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ taskId, kind, found: !!a, content: a?.content ?? null, updatedAt: a?.updatedAt ?? null }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

// ── Scheduled-task endpoint handlers ────────────────────────────────────────
// Thin wrappers over scheduleStore (the source of truth), mirroring the IPC
// handlers in ipc.ts: every mutation re-broadcasts so the renderer's Scheduled
// Tasks panel updates live. The MCP scheduled-task tools call these over HTTP
// because the MCP server runs out-of-process and can't touch scheduleStore.

function handleSchedulesList(res: import('http').ServerResponse): void {
  try {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ schedules: scheduleStore.getSchedules() }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

function handleScheduleGet(body: string, res: import('http').ServerResponse): void {
  try {
    const { id } = readJson<{ id: string }>(body)
    const s = scheduleStore.getSchedule(id)
    res.writeHead(s ? 200 : 404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(s ?? { error: `Scheduled task ${id} not found` }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

function handleScheduleCreate(body: string, res: import('http').ServerResponse): void {
  try {
    const data = readJson<Omit<scheduleStore.ScheduledTask, 'id' | 'createdAt' | 'runs' | 'lastRunAt'>>(body)
    if (!data?.name || !data?.prompt || !data?.projectPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'name, prompt, projectPath required' }))
      return
    }
    const task = scheduleStore.createSchedule(data)
    broadcastSchedules()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(task))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

function handleScheduleUpdate(body: string, res: import('http').ServerResponse): void {
  try {
    const { id, patch } = readJson<{
      id: string
      patch: Partial<Omit<scheduleStore.ScheduledTask, 'id' | 'createdAt' | 'runs'>>
    }>(body)
    if (!scheduleStore.getSchedule(id)) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Scheduled task ${id} not found` }))
      return
    }
    scheduleStore.updateSchedule(id, patch ?? {})
    broadcastSchedules()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(scheduleStore.getSchedule(id)))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

function handleScheduleSetEnabled(body: string, res: import('http').ServerResponse): void {
  try {
    const { id, enabled } = readJson<{ id: string; enabled: boolean }>(body)
    if (!scheduleStore.getSchedule(id)) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Scheduled task ${id} not found` }))
      return
    }
    scheduleStore.setScheduleEnabled(id, enabled)
    broadcastSchedules()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(scheduleStore.getSchedule(id)))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

function handleScheduleDelete(body: string, res: import('http').ServerResponse): void {
  try {
    const { id } = readJson<{ id: string }>(body)
    const existed = !!scheduleStore.getSchedule(id)
    scheduleStore.deleteSchedule(id)
    if (existed) broadcastSchedules()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, deleted: existed }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

// ── Canvas handlers ──────────────────────────────────────────────────────────

/** Bodies past this are rejected before JSON.parse — a 2,000-row table of
 *  1,000-char cells can't get near it, so anything bigger is malformed. */
const CANVAS_MAX_BODY_BYTES = 1_048_576

/** Re-emits of identical content within this window are collapsed into a
 *  canvas-focus of the existing artifact instead of storing a twin. Agents
 *  sometimes repeat an already-successful canvas-show (observed: identical
 *  table emitted twice, 11s apart) — and "show identical content again" IS
 *  focus semantics, so this is correct even for deliberate re-emits. */
const CANVAS_DEDUPE_WINDOW_MS = 120_000

/** Content-identity key for an artifact payload or stored artifact. Images
 *  compare by their ORIGINAL path — at storage time the path is rewritten to
 *  the app-owned copy, so the incoming payload's path must be matched against
 *  the stored artifact's originalPath. */
function canvasEmitKey(p: {
  component: string
  title?: string
  table?: unknown
  markdown?: string
  image?: { path: string; originalPath?: string; alt?: string }
  annotations?: unknown
}): string {
  switch (p.component) {
    case 'result-table': return JSON.stringify(['t', p.title ?? null, p.table])
    case 'markdown': return JSON.stringify(['m', p.title ?? null, p.markdown])
    default:
      return JSON.stringify([
        'i',
        p.title ?? null,
        p.image ? (p.image.originalPath ?? p.image.path) : null,
        p.image?.alt ?? null,
        p.annotations ?? null,
      ])
  }
}

function handleCanvasEmit(body: string, res: import('http').ServerResponse): void {
  try {
    if (Buffer.byteLength(body) > CANVAS_MAX_BODY_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'artifact payload exceeds 1 MiB' }))
      return
    }
    const { sessionId, artifact } = readJson<{ sessionId: string; artifact: unknown }>(body)
    const session = getSession(sessionId)
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Session ${sessionId} not found`, unknownSession: true }))
      return
    }
    const result = validateCanvasArtifact(artifact)
    if (!result.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: result.error }))
      return
    }
    let value = result.value
    let dims: { width: number; height: number } | null = null
    if ('image' in value) {
      if (!existsSync(value.image.path)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `image path does not exist or is unreadable: ${value.image.path}` }))
        return
      }
      // Dimensions read HERE, deterministically — the agent never needs to
      // measure the file. Drives relative→natural conversion, bounds checks,
      // and the dims echoed back in the success payload.
      dims = readImageDims(value.image.path)
      if (!dims) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `could not decode image (corrupt or unsupported): ${value.image.path}` }))
        return
      }
      if (value.component === 'annotated-image') {
        const annotations = result.coordSpace === 'relative'
          ? scaleAnnotationsToNatural(value.annotations, dims.width, dims.height)
          : value.annotations
        const boundsError = annotationBoundsError(annotations, dims.width, dims.height)
        if (boundsError) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: boundsError }))
          return
        }
        value = { ...value, annotations }
      }
    }
    // Dedupe: identical content emitted for this session moments ago →
    // focus the existing artifact instead of storing a twin.
    const key = canvasEmitKey(value)
    const now = Date.now()
    const dup = canvasStore
      .getArtifactsForSession(sessionId, session.claudeSessionId ?? null)
      .find((a) => now - a.createdAt < CANVAS_DEDUPE_WINDOW_MS && canvasEmitKey(a) === key)
    if (dup) {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) {
        win.webContents.send('canvas:focus', { sessionId, artifactId: dup.id })
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        artifactId: dup.id,
        duplicate: true,
        ...(dims ? { imageWidth: dims.width, imageHeight: dims.height } : {}),
      }))
      return
    }

    const stored = emitCanvasArtifact(value, {
      sessionId,
      claudeSessionId: session.claudeSessionId ?? null,
      source: 'agent',
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      artifactId: stored.id,
      ...(dims ? { imageWidth: dims.width, imageHeight: dims.height } : {}),
    }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

/** Decode an image's natural pixel size. Returns null when unreadable. */
function readImageDims(path: string): { width: number; height: number } | null {
  try {
    const size = nativeImage.createFromPath(path).getSize()
    return size.width > 0 && size.height > 0 ? size : null
  } catch {
    return null
  }
}

/** Longest side below this gets an upscaled inspection copy — small images are
 *  hard to localize on; a single pre-made zoom replaces the sips-resize dance. */
const INSPECT_UPSCALE_THRESHOLD = 600
const INSPECT_MAX_SIDE = 2048

/** canvas-inspect-image: one call returns the pixel dimensions and, for small
 *  images, a pre-upscaled copy the agent can Read for precise localization —
 *  replacing the measure → Read → resize → Read tool-call chain. */
function handleCanvasInspect(body: string, res: import('http').ServerResponse): void {
  try {
    const { path } = readJson<{ path: string }>(body)
    if (typeof path !== 'string' || !path.startsWith('/')) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'path must be an absolute path to an image file' }))
      return
    }
    if (!existsSync(path)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `image path does not exist: ${path}` }))
      return
    }
    const img = nativeImage.createFromPath(path)
    const size = img.getSize()
    if (size.width <= 0 || size.height <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `could not decode image (corrupt or unsupported): ${path}` }))
      return
    }

    let upscaledPath: string | undefined
    let upscaleFactor: number | undefined
    const longest = Math.max(size.width, size.height)
    if (longest < INSPECT_UPSCALE_THRESHOLD) {
      upscaleFactor = Math.min(4, Math.floor(INSPECT_MAX_SIDE / longest))
      if (upscaleFactor >= 2) {
        const resized = img.resize({ width: size.width * upscaleFactor, quality: 'best' })
        upscaledPath = join(canvasStore.canvasImagesDir(), `inspect-${randomUUID()}.png`)
        writeFileSync(upscaledPath, resized.toPNG())
      } else {
        upscaleFactor = undefined
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ width: size.width, height: size.height, upscaledPath, upscaleFactor }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

/** Re-open the dock on an EXISTING artifact (no store mutation) — lets an agent
 *  bring back "that table from earlier" without re-emitting it. */
function handleCanvasFocus(body: string, res: import('http').ServerResponse): void {
  try {
    const { sessionId, artifactId } = readJson<{ sessionId: string; artifactId: string }>(body)
    const artifact = canvasStore.getArtifactById(artifactId)
    if (!artifact) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Canvas artifact ${artifactId} not found — use canvas-list-artifacts to see what exists`, unknownArtifact: true }))
      return
    }
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      // Focus in the CALLING session's dock — persisted artifacts from a prior
      // app run carry a dead sessionId, so the live caller wins.
      win.webContents.send('canvas:focus', { sessionId, artifactId })
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

/** One-line summary per artifact for canvas-list-artifacts (keeps huge table
 *  payloads out of the agent's context). */
function summarizeCanvasArtifact(a: CanvasArtifact): string {
  switch (a.component) {
    case 'result-table': return `table · ${a.table.rows.length} rows × ${a.table.columns.length} cols`
    case 'markdown': return `markdown · ${(a.markdown.length / 1000).toFixed(1)}k chars`
    case 'image': return `image · ${a.image.originalPath ?? a.image.path}`
    case 'annotated-image': return `annotated image · ${a.annotations.length} annotations · ${a.image.originalPath ?? a.image.path}`
  }
}

function handleCanvasList(body: string, res: import('http').ServerResponse): void {
  try {
    const { sessionId } = readJson<{ sessionId: string }>(body)
    const session = getSession(sessionId)
    const artifacts = canvasStore
      .getArtifactsForSession(sessionId, session?.claudeSessionId ?? null)
      .map((a) => ({
        id: a.id,
        component: a.component,
        title: a.title,
        source: a.source,
        createdAt: new Date(a.createdAt).toISOString(),
        summary: summarizeCanvasArtifact(a),
      }))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ artifacts }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

// ── Clipboard-pasted images (send-time display) ──────────────────────────────
//
// Claude Code's image paste is Ctrl+V: the keystroke goes into the PTY and the
// CLI reads the OS clipboard itself, inserting an "[Image #N]" placeholder into
// the prompt — no image bytes ever pass anywhere we can see them at submit
// time. So the renderer's Terminal notifies us on the paste combo, we snapshot
// the clipboard image into canvas-images/ as a silent STASH, and the next
// UserPromptSubmit resolves it: placeholder present → the paste was actually
// sent → emit user-source artifacts (display at SEND time, never at paste
// time); no placeholder → the user deleted it or pasted text → discard.

interface StashedPaste {
  path: string
  ts: number
}

/** Per-session unresolved clipboard pastes. In-memory only — a stash that
 *  never resolves (app quit mid-prompt) leaves orphaned files that
 *  sweepOrphanedImages() clears on next launch. */
const pastedImageStash = new Map<string, StashedPaste[]>()

/** Pastes older than this at resolution time are discarded, not displayed. */
const PASTE_STASH_TTL_MS = 15 * 60_000

/** Max unresolved pastes kept per session (oldest dropped + file deleted). */
const PASTE_STASH_CAP = 6

/** Claude Code's pasted-image placeholder in a submitted prompt. */
const PASTED_PLACEHOLDER_RE = /\[Image #\d+\]/

/** Snapshot the clipboard image (if any) into the stash for a session. Called
 *  via IPC when the renderer sees a paste combo in that session's terminal.
 *  Silent: nothing is displayed until the next submit confirms it was sent. */
export function stashClipboardImage(appSessionId: string): { stashed: boolean } {
  try {
    if (loadSettings().canvasAutoShowUserImages === false) return { stashed: false }
    if (!getSession(appSessionId)) return { stashed: false }
    const image = clipboard.readImage()
    if (image.isEmpty()) return { stashed: false }
    const png = image.toPNG()
    if (png.length === 0 || png.length > 10 * 1024 * 1024) return { stashed: false }

    const path = join(canvasStore.canvasImagesDir(), `paste-${randomUUID()}.png`)
    writeFileSync(path, png)

    const stash = pastedImageStash.get(appSessionId) ?? []
    stash.push({ path, ts: Date.now() })
    while (stash.length > PASTE_STASH_CAP) {
      const dropped = stash.shift()
      if (dropped) { try { unlinkSync(dropped.path) } catch { /* sweep catches it */ } }
    }
    pastedImageStash.set(appSessionId, stash)
    return { stashed: true }
  } catch (err) {
    console.error('[canvas] clipboard stash failed:', err)
    return { stashed: false }
  }
}

/** Resolve a session's paste stash against the just-submitted prompt. Every
 *  submit resolves the whole stash one way or the other — display or discard —
 *  so stale pastes can't leak into a later, unrelated message. */
function resolvePastedImageStash(appSessionId: string, prompt: string): void {
  const stash = pastedImageStash.get(appSessionId)
  if (!stash?.length) return
  pastedImageStash.delete(appSessionId)

  const session = getSession(appSessionId)
  const confirmed =
    !!session &&
    loadSettings().canvasAutoShowUserImages !== false &&
    PASTED_PLACEHOLDER_RE.test(prompt)

  for (const entry of stash) {
    const fresh = Date.now() - entry.ts < PASTE_STASH_TTL_MS
    if (confirmed && fresh && existsSync(entry.path)) {
      emitCanvasArtifact(
        { component: 'image', title: 'Pasted image', image: { path: entry.path } },
        { sessionId: appSessionId, claudeSessionId: session!.claudeSessionId ?? null, source: 'user' },
      )
    } else {
      try { unlinkSync(entry.path) } catch { /* sweep catches it */ }
    }
  }
}

/** Cap on auto-displayed images per submitted message. */
const USER_IMAGES_PER_MESSAGE = 6

/** Image file paths in a prompt: quoted ('…' or "…", may contain spaces) or
 *  bare absolute/~ paths ending in an allowed image extension. Deliberately
 *  does NOT match Claude Code's clipboard-paste placeholder ([Image #1] — no
 *  path, no extension); clipboard capture is a future renderer-side feature. */
const USER_IMAGE_PATH_RE =
  /(['"])((?:\/|~\/)[^'"\n]+?\.(?:png|jpe?g|gif|webp))\1|((?:\/|~\/)[^\s'"()]+?\.(?:png|jpe?g|gif|webp))\b/gi

/** Auto-display images the user sent in their prompt (drag-drop / typed paths).
 *  Runs off the sync-hook path; silently skips misses — a false-positive path
 *  match must never surface an error to the user. Gated by the
 *  canvasAutoShowUserImages setting (read per event so toggling applies live). */
function scanPromptForUserImages(appSessionId: string, prompt: string): void {
  try {
    if (loadSettings().canvasAutoShowUserImages === false) return
    const session = getSession(appSessionId)
    if (!session) return

    const seen = new Set<string>()
    for (const m of prompt.matchAll(USER_IMAGE_PATH_RE)) {
      if (seen.size >= USER_IMAGES_PER_MESSAGE) break
      const raw = m[2] ?? m[3]
      if (!raw) continue
      let path = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
      if (!existsSync(path)) continue
      // Canonicalize so aliased forms of one file dedupe (macOS /tmp is a
      // symlink to /private/tmp — a prompt citing both produced two artifacts).
      try { path = realpathSync(path) } catch { /* keep as-is */ }
      if (seen.has(path)) continue
      seen.add(path)
      const basename = path.split('/').pop() ?? path
      emitCanvasArtifact(
        { component: 'image', title: basename.slice(0, 120), image: { path } },
        { sessionId: appSessionId, claudeSessionId: session.claudeSessionId ?? null, source: 'user' },
      )
    }
  } catch (err) {
    console.error('[canvas] user-image scan failed:', err)
  }
}

/** Find a node in a task's tree by app session id. */
function findTaskNode(taskId: string, sessionId: string): pipelineStore.PipelineSession | null {
  const walk = (n?: pipelineStore.PipelineSession): pipelineStore.PipelineSession | null => {
    if (!n) return null
    if (n.id === sessionId) return n
    for (const c of n.children ?? []) {
      const found = walk(c)
      if (found) return found
    }
    return null
  }
  return walk(pipelineStore.getPipelineTask(taskId)?.orchestrator)
}

/** Merge a worktree worker's branch back into the integration branch. On success
 *  the worktree is removed, the node is marked read-only (Option B) and the
 *  (now-stale) session is torn down so it can't keep editing merged code. On a
 *  conflict the worktree + session are kept alive for a fix worker to resolve. */
function handlePipelineMergeWorktree(body: string, res: import('http').ServerResponse): void {
  void (async (): Promise<void> => {
    try {
      const { taskId, sessionId } = readJson<{ taskId: string; sessionId: string }>(body)
      const task = pipelineStore.getPipelineTask(taskId)
      const node = findTaskNode(taskId, sessionId)
      if (!task || !node) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Task ${taskId} / session ${sessionId} not found` }))
        return
      }
      if (node.worktreeRemoved) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ merged: true, alreadyMerged: true }))
        return
      }
      if (!node.worktreePath || !node.worktreeBranch) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Session ${sessionId} has no worktree to merge` }))
        return
      }
      // Integration target for a fan-out worker: the TASK's own worktree (its
      // per-task branch) when the task is isolated — so a worker's work lands on
      // the task branch, not main (main integration happens once, at Done).
      // Fall back to the MAIN repo root for non-isolated tasks. NEVER the
      // worker's own worktree (merging into itself = no-op + force-delete = data
      // loss — exactly the blocker this guards against).
      const root = task.worktreePath || gitWorktree.getMainWorktreeRoot(task.projectPath || node.cwd || process.cwd())
      if (!root || root === node.worktreePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: !root ? 'No git integration root for this task' : 'Refusing to merge a worktree into itself' }))
        return
      }

      const result = await gitWorktree.mergeWorktree({
        repoRoot: root,
        branch: node.worktreeBranch,
        worktreePath: node.worktreePath,
      })

      if (result.merged) {
        try {
          gitWorktree.removeWorktree({ repoRoot: root, worktreePath: node.worktreePath, branch: node.worktreeBranch })
        } catch (err) {
          console.error('[hook-server] worktree remove after merge failed:', err)
        }
        pipelineStore.markWorktreeRemoved(taskId, sessionId)
        pipelineStore.emitMilestone(taskId, sessionId, {
          text: `Merged ${node.worktreeBranch} → integration branch; worktree removed (read-only).`,
          status: 'done',
          badge: 'merged',
          tone: 'pass',
          kind: 'done',
        })
        scheduleSessionTeardown(sessionId)
        broadcastPipeline()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ merged: true, branch: node.worktreeBranch }))
      } else {
        pipelineStore.emitMilestone(taskId, sessionId, {
          text: `Merge conflict in: ${result.conflicts.join(', ')} — worktree kept for resolution.`,
          badge: 'conflict',
          tone: 'fail',
          kind: 'error',
        })
        broadcastPipeline()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ merged: false, conflicts: result.conflicts }))
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    }
  })()
}

/** Best-effort removal of the fan-out WORKER worktrees in a task's tree, leaving
 *  the task-level worktree intact. Reads the LIVE session tree, so call it before
 *  any state reset that clears `orchestrator`. Used on its own by the restart
 *  path (clean abandoned workers, keep the task worktree's WIP) and as the first
 *  step of cleanupTaskWorktrees. */
export function cleanupWorkerWorktrees(taskId: string): void {
  const task = pipelineStore.getPipelineTask(taskId)
  for (const node of pipelineStore.getWorktreeNodes(taskId)) {
    // Worker worktrees live off the TASK worktree (or main if not isolated).
    const root = task?.worktreePath || gitWorktree.getMainWorktreeRoot(task?.projectPath || node.cwd || process.cwd())
    if (!root || !node.worktreePath || !node.worktreeBranch) continue
    try {
      gitWorktree.removeWorktree({ repoRoot: root, worktreePath: node.worktreePath, branch: node.worktreeBranch })
      pipelineStore.markWorktreeRemoved(taskId, node.id)
    } catch (err) {
      console.error('[hook-server] worker worktree cleanup failed:', err)
    }
  }
}

/** Best-effort removal of any live worktrees in a task's tree — called on
 *  terminal states (Done / task removed) to clean up crashed/abandoned workers. */
export function cleanupTaskWorktrees(taskId: string): void {
  const task = pipelineStore.getPipelineTask(taskId)
  // Session-level fan-out worker worktrees.
  cleanupWorkerWorktrees(taskId)
  // Task-level worktree (discard path). On the Done path the integrate step has
  // already removed it after a successful merge — best-effort no-op then; on
  // remove/discard this throws the work away.
  if (task?.repoRoot && task.worktreePath && task.worktreeBranch) {
    try {
      gitWorktree.removeWorktree({ repoRoot: task.repoRoot, worktreePath: task.worktreePath, branch: task.worktreeBranch })
    } catch (err) {
      console.error('[hook-server] task-level worktree cleanup failed:', err)
    }
  }
}

/** Restart a task from an earlier stage with a FRESH orchestrator (backward
 *  drag on the board). Old orchestrator + all child sessions are killed, the
 *  abandoned fan-out worker worktrees are cleaned up (the task worktree's WIP is
 *  kept if it's still on disk, recreated otherwise), transient run state is
 *  reset, and a fresh orchestrator is spawned with a REOPENED notice. */
export function restartPipelineOrchestrator(taskId: string, fromStage: pipelineStore.PipelineStage): void {
  // 1. Tear down the whole live session tree (orchestrator + children) — mirror
  //    pipeline:remove's teardown so no PTY keeps running/editing/burning tokens.
  for (const sid of pipelineStore.getPipelineSessionIds(taskId)) {
    try { killSession(sid); cleanupSession(sid) } catch (err) { console.error('[hook-server] session teardown on restart failed:', err) }
  }
  // 2. Clean abandoned fan-out workers BEFORE the reset — it reads the live tree.
  //    The task-level worktree is deliberately left intact (preserves WIP).
  try { cleanupWorkerWorktrees(taskId) } catch (err) { console.error('[hook-server] worker worktree cleanup on restart failed:', err) }
  // 3. Reset transient state and set the target stage. Guarded for symmetry with
  //    the other best-effort steps — a throw here must not leave a half-reset
  //    (tree already killed, no respawn).
  try { pipelineStore.reopenPipelineTask(taskId, fromStage) } catch (err) { console.error('[hook-server] task state reset on restart failed:', err) }
  // 4. Spawn a fresh orchestrator (ensureTaskWorktree reuses or recreates the
  //    task worktree, registers the fresh root, and broadcasts).
  const fresh = pipelineStore.getPipelineTask(taskId)
  if (fresh) {
    try { spawnPipelineOrchestrator(fresh, { reopenedFrom: fromStage }) } catch (err) { console.error('[hook-server] orchestrator respawn on restart failed:', err) }
  }
  broadcastPipeline()
}

/** PAUSE a task: hold new work and gracefully stop the live session tree while
 *  PRESERVING the task worktree + each node's claudeSessionId for resume. This is
 *  precisely pipeline:remove's teardown MINUS the task-worktree cleanup MINUS
 *  task removal, plus a `paused` flag. Killing the PTYs loses only the current
 *  in-flight turn; the conversation resumes cleanly from claudeSessionId (same as
 *  relaunch auto-resume). In-flight fan-out workers are discarded (their isolated
 *  worktrees removed) — mirrors restart; the re-woken orchestrator re-spawns
 *  whatever the current stage needs. Distinct from Done (merge + cleanup) and
 *  drag-to-backlog (discard worktree + remove task). */
export function pausePipelineTask(taskId: string): void {
  // 1. Gracefully stop the whole live session tree (orchestrator + workers).
  for (const sid of pipelineStore.getPipelineSessionIds(taskId)) {
    try { killSession(sid); cleanupSession(sid) }
    catch (err) { console.error('[hook-server] pause session teardown failed:', err) }
  }
  // 2. Clean ABANDONED fan-out worker worktrees only (reads the live tree, so do
  //    it before any state reset). The TASK-level worktree is left intact.
  try { cleanupWorkerWorktrees(taskId) }
  catch (err) { console.error('[hook-server] pause worker-worktree cleanup failed:', err) }
  // 3. Mark paused and settle the lingering orchestrator node to idle + a
  //    'paused' badge so the board reads as paused rather than stalled.
  pipelineStore.setPipelineTaskPaused(taskId, true)
  const orch = pipelineStore.getPipelineTask(taskId)?.orchestrator
  if (orch) {
    pipelineStore.upsertPipelineSession(taskId, {
      id: orch.id, role: 'orchestrator', label: orch.label,
      status: 'idle', badge: 'paused', tone: 'neutral',
      claudeSessionId: orch.claudeSessionId ?? null, cwd: orch.cwd,
    })
    pipelineStore.emitMilestone(taskId, orch.id, {
      text: 'Task paused — sessions stopped, worktree preserved. Resume to continue.',
      kind: 'info', tone: 'neutral', status: 'idle',
    })
  }
  broadcastPipeline()
}

/** RESUME a paused task: clear the flag and re-wake the orchestrator from its
 *  saved claudeSessionId via the existing resume path (which re-attaches the
 *  worktree, re-keys the node, and handles already-live / worktree-gone edges).
 *  On failure (worktree/transcript gone) the task is re-marked paused so the card
 *  stays in a coherent — now read-only — state rather than silently dead-unpaused. */
export function resumePipelineTask(taskId: string): 'resumed' | 'skipped-live' | 'failed' {
  const task = pipelineStore.getPipelineTask(taskId)
  if (!task) return 'failed'
  // Clear the flag in the STORE first so resumePipelineOrchestrator's broadcasts
  // render unpaused — but pass the captured (still-paused) task object so the
  // resume PROMPT keeps its pause-aware framing.
  pipelineStore.setPipelineTaskPaused(taskId, false)
  const r = resumePipelineOrchestrator(task)
  if (r === 'failed') {
    pipelineStore.setPipelineTaskPaused(taskId, true)
    broadcastPipeline()
  }
  return r
}

/** On task completion, merge the per-task branch into the integration (main)
 *  branch and remove the task worktree. SAFE ORDERING: the worktree is removed
 *  ONLY after a successful merge, so unmerged work is never lost. On conflict
 *  the worktree is kept and a milestone is emitted for resolution. No-op for
 *  non-isolated tasks. */
export async function integrateTaskWorktree(
  taskId: string,
): Promise<{ ok: boolean; conflicts?: string[]; noWorktree?: boolean }> {
  const task = pipelineStore.getPipelineTask(taskId)
  if (!task?.repoRoot || !task.worktreePath || !task.worktreeBranch) return { ok: true, noWorktree: true }
  // Idempotency fast-path: a prior completion already integrated this task. Re-running
  // completion (e.g. `auto` mode: approval auto-advance merges, then the orchestrator's
  // explicit set-stage 'done' fires again) must be a no-op success — never a second
  // merge attempt against the now-pruned branch, which would be misreported as conflict.
  if (task.integrationStatus === 'merged') return { ok: true }
  const feedId = task.orchestrator?.id ?? taskId
  try {
    const result = await gitWorktree.mergeWorktree({
      repoRoot: task.repoRoot,
      branch: task.worktreeBranch,
      worktreePath: task.worktreePath,
    })
    if (!result.merged) {
      pipelineStore.emitMilestone(taskId, feedId, {
        text: `⚠ Task branch ${task.worktreeBranch} conflicts with the integration branch (${result.conflicts.join(', ')}). Worktree kept — resolve and re-complete.`,
        tone: 'fail', badge: 'merge conflict', kind: 'error',
      })
      broadcastPipeline()
      return { ok: false, conflicts: result.conflicts }
    }
    gitWorktree.removeWorktree({ repoRoot: task.repoRoot, worktreePath: task.worktreePath, branch: task.worktreeBranch })
    pipelineStore.emitMilestone(taskId, feedId, {
      text: `Merged task branch ${task.worktreeBranch} → integration branch; task worktree removed.`,
      tone: 'pass', badge: 'integrated', kind: 'done',
    })
    broadcastPipeline()
    return { ok: true }
  } catch (err) {
    pipelineStore.emitMilestone(taskId, feedId, {
      text: `⚠ Task integration failed: ${err instanceof Error ? err.message : String(err)}. Worktree kept.`,
      tone: 'fail', kind: 'error',
    })
    broadcastPipeline()
    return { ok: false }
  }
}

/** Move a task into Done ONLY if its per-task branch integrates cleanly. Run on
 *  every path that would complete a task (orchestrator set-stage, UI force-advance,
 *  gate approval). SAFE ORDERING: integrate first, advance second.
 *   - success → stage=done (+ completedAt), integrationStatus='merged', worktrees
 *     cleaned up, sessions torn down.
 *   - conflict → the card is HELD OUT of Done (reverted to Review), the worktree is
 *     kept, integrationStatus='conflict' (+ conflicting files) so the board shows a
 *     red "not merged" badge for the user / orchestrator to resolve.
 *  Non-isolated tasks (no worktree) complete unconditionally. */
export async function finalizeTaskCompletion(
  taskId: string,
): Promise<{ ok: boolean; conflicts?: string[]; noWorktree?: boolean }> {
  const integ = await integrateTaskWorktree(taskId)
  if (integ.ok) {
    pipelineStore.setPipelineStage(taskId, 'done')
    // Only flag 'merged' when there was an actual branch to merge; non-isolated
    // tasks keep integrationStatus undefined (they render as a plain ✓ complete).
    if (!integ.noWorktree) pipelineStore.setIntegrationStatus(taskId, 'merged')
    markBackingTodoDone(taskId)
    cleanupTaskWorktrees(taskId)
    for (const sid of pipelineStore.getPipelineSessionIds(taskId)) scheduleSessionTeardown(sid)
  } else {
    pipelineStore.setIntegrationStatus(taskId, 'conflict', integ.conflicts)
    // Hold the card out of Done — revert to Review (the stage the merge gate sits
    // after) so the board never shows "complete" for unmerged work.
    if (pipelineStore.getPipelineTask(taskId)?.stage === 'done') {
      pipelineStore.setPipelineStage(taskId, 'review')
    }
  }
  broadcastPipeline()
  return integ
}

function handleListSessions(res: import('http').ServerResponse): void {
  try {
    const sessions: Array<{
      id: string; projectPath: string; claudeSessionId: string | null
      status: string; title: string | null
    }> = getAllSessions().map((s) => ({
      id: s.id,
      projectPath: s.projectPath,
      claudeSessionId: s.claudeSessionId,
      // A resumed-but-not-yet-ready session reads 'waking', not its stale
      // pre-archive hook status.
      status: archiver.isWaking(s.id) ? 'waking' : sessionStatus.get(s.id) ?? 'unknown',
      title: s.terminalTitle,
    }))
    // Archived sessions have no live PTY but keep their node + conversation —
    // list them flagged 'archived'. Messaging one auto-wakes it.
    for (const r of archiver.listArchivedSessions()) {
      sessions.push({
        id: r.id,
        projectPath: r.projectPath,
        claudeSessionId: r.claudeSessionId,
        status: 'archived',
        title: r.terminalTitle,
      })
    }

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
  // Archived target → queue server-side and trigger a silent resume; the queue
  // flushes into this same function once the session is ready. Waking target
  // (PTY alive, plugin monitor possibly not yet) → queue without re-resuming.
  // Queued rather than appended now: an archived session has no monitor running,
  // and the inbox is truncated when the resumed PTY spawns, so an append made
  // before the resume would be thrown away. The 10-line replay a fresh `tail -f`
  // does covers the reverse race (flush landing just before the monitor is up).
  if (archiver.isArchived(targetSessionId) || archiver.isWaking(targetSessionId)) {
    return archiver.queueMessageForArchived(targetSessionId, message, fromSessionId)
  }
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
    const { agentName, prompt, projectPath, modelId: modelIdRaw } = JSON.parse(body) as {
      agentName: string; prompt: string; projectPath?: string; modelId?: string
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
    let args = loadSettings().autoModeForChildSessions
      ? ['--permission-mode', 'auto', ...baseArgs]
      : baseArgs
    // Honor an explicit model override (no role default on the agent path).
    const modelId = resolveModelId(modelIdRaw)
    if (modelId) args = ['--model', modelId, ...args]
    const session = spawnSession(id, cwd, 'claude', args)

    if (attachListenersFn) {
      attachListenersFn(id, session)
    }

    registry.setOrigin(id, {
      kind: 'agent',
      agentName: agent.name,
      label: agent.name,
      parentSessionId: process.env.APP_SESSION_ID || undefined,
    })

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

/** UserPromptSubmit count per session (used to throttle the ambient nudge). */
const sessionTurnCount = new Map<string, number>()

/** Turn number at which the ambient nudge last fired for each session. */
const lastNudgeTurn = new Map<string, number>()

/** Turns between ambient todo nudges. */
const NUDGE_INTERVAL = 8

interface SyncHookReply {
  hookSpecificOutput?: {
    hookEventName: string
    additionalContext?: string
  }
  /** Shown to the user in the session transcript by Claude Code. */
  systemMessage?: string
}

/**
 * Prompt-time memory injection (opt-in, Settings → Memory injection).
 * Merges matched memory notes into the sync reply's additionalContext and
 * announces them in the transcript via systemMessage; the renderer is told
 * which notes landed so the announcement titles become clickable in xterm.
 */
async function mergeMemoryInjection(
  appSessionId: string | null,
  payload: HookPayload,
  reply: SyncHookReply
): Promise<SyncHookReply> {
  if (!appSessionId || payload.hook_event_name !== 'UserPromptSubmit' || !payload.prompt) return reply
  const settings = loadSettings()
  if (settings.memoryInjectionMode === 'off') return reply
  // The curator run is tool-restricted housekeeping — injecting user memory
  // into it would only skew its judgements.
  if (isCuratorSession(appSessionId)) return reply

  const trackKey = payload.session_id || appSessionId
  const injection = await buildMemoryInjection(trackKey, payload.prompt, {
    mode: settings.memoryInjectionMode,
    sessionCap: settings.memoryInjectionSessionCap,
    threshold: settings.memoryInjectionThreshold,
  })
  if (!injection) return reply

  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('memory:injected', {
      sessionId: appSessionId,
      entries: injection.entries,
    })
  }

  const existing = reply.hookSpecificOutput?.additionalContext
  return {
    ...reply,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: existing
        ? `${existing}\n\n${injection.additionalContext}`
        : injection.additionalContext,
    },
    systemMessage: injection.systemMessage,
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

    const turn = (sessionTurnCount.get(trackKey) ?? 0) + 1
    sessionTurnCount.set(trackKey, turn)

    if (count === 0) return {}

    const countChanged = prev !== count

    if (countChanged) {
      const delta = prev === -1 ? count : (count - prev)
      const deltaText = prev === -1
        ? `first check of this session`
        : delta > 0
          ? `${delta} new since last message`
          : `${-delta} closed since last message`

      const context = `You have ${count} open todo${count === 1 ? '' : 's'} tagged \`${projectTag}\` (${deltaText}). `
        + `Use the list-todos MCP tool with tags=["${projectTag}"], done=false to see them.`

      return {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: context,
        },
      }
    }

    // Ambient nudge: throttled, opt-in, only when count is unchanged this turn.
    if (!loadSettings().ambientTodoNudge) return {}
    const lastNudge = lastNudgeTurn.get(trackKey) ?? -Infinity
    if (turn - lastNudge < NUDGE_INTERVAL) return {}
    lastNudgeTurn.set(trackKey, turn)

    const nudge = `This project still has ${count} unfinished todo${count === 1 ? '' : 's'} tagged \`${projectTag}\`. `
      + `If you're at a natural stopping point in this reply (and not mid-task on something unrelated), `
      + `add a soft closing line inviting the user to pick one up — e.g. "by the way, there are still N todos open for this project, want me to list them or send them to the agentic pipeline?". `
      + `Do not pivot, do not list them unprompted, and skip the nudge if it would feel forced.`

    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: nudge,
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
  if (payload.transcript_path) {
    sessionTranscriptPath.set(appSessionId, payload.transcript_path)
    noteTranscriptForDigest(appSessionId, payload)
  }

  // Archiver: any hook traffic from a waking session proves the resumed
  // process is up → flush its queued messages.
  archiver.noteSessionHookEvent(appSessionId)

  const event = payload.hook_event_name

  if (event === 'Notification') {
    switch (payload.notification_type) {
      case 'permission_prompt':
        awaitingPermission.add(appSessionId)
        sessionStatus.set(appSessionId, 'idle')
        // Mid-turn wait for the user — never archivable (gate 1).
        archiver.noteSessionHookStatus(appSessionId, 'permission')
        registry.setStatus(appSessionId, 'permission')
        win.webContents.send('claude:status', { id: appSessionId, status: 'permission' })
        break
    }
  } else if (event === 'Stop') {
    awaitingPermission.delete(appSessionId)
    sessionStatus.set(appSessionId, 'idle')
    archiver.noteSessionHookStatus(appSessionId, 'idle')
    registry.setStatus(appSessionId, 'idle')
    win.webContents.send('claude:status', { id: appSessionId, status: 'finished' })

    // Scheduled-task completion: if this session is an in-flight scheduled run,
    // mark it done, persist the (possibly /resume-updated) claudeSessionId, then
    // tear the PTY down — keeping claudeSessionId on disk so the run is resumable.
    const scheduled = scheduleStore.getScheduleRunBySessionId(appSessionId)
    if (scheduled && scheduled.run.status === 'working') {
      const live = getSession(appSessionId)
      const claudeSessionId = live?.claudeSessionId ?? scheduled.run.claudeSessionId
      scheduleStore.recordRunFinished(
        scheduled.scheduleId,
        scheduled.run.id,
        'done',
        new Date().toISOString(),
        claudeSessionId,
      )
      broadcastSchedules()
      scheduleSessionTeardown(appSessionId)
    }

    // GitHub agent completion. If the user is WATCHING the terminal right now,
    // keep it open (deferred teardown — they may start talking, which adopts
    // it); otherwise tear the PTY down (same path as scheduled runs). The
    // conversation id was captured at respond time and is re-read in the
    // finalizer, so the panel's "Discuss" can always re-open it.
    // The fallback to githubAgentBySession matters: an agent that ends WITHOUT
    // calling github-respond (crash, confusion, or a model that just stops)
    // used to leave the item wedged forever — PTY unreclaimed, "Watch live"
    // pulsing, and the per-item guard permanently reporting "still running" so
    // it could never re-trigger either. Any finished github agent gets torn
    // down now. Safe against a mid-work Stop: if the user is watching, the
    // deferred path below keeps the terminal open for them anyway.
    const githubItemId = githubRespondedSessions.get(appSessionId) ?? githubAgentBySession.get(appSessionId)
    if (githubItemId) {
      githubRespondedSessions.delete(appSessionId)
      githubItemSessions.delete(githubItemId)
      if (uiFocusedSessionId === appSessionId) {
        githubDeferredTeardowns.set(appSessionId, githubItemId)
      } else {
        finalizeGithubTeardown(appSessionId, githubItemId)
      }
    }

    // Observer-run completion (curator or housekeeping). The run is an
    // interactive `claude` (no -p), so when it finishes it just sits at its
    // prompt forever: without this it leaks one process per launch, and —
    // worse — `activeSessionId` never clears,
    // so every later curator run is skipped as "already in flight" AFTER its
    // debt was zeroed. Same teardown path as a scheduled run; the run token and
    // in-flight marker are burned here rather than waiting on process exit.
    if (isCuratorSession(appSessionId)) {
      endCuratorRun(appSessionId)
      registry.forget(appSessionId)
      scheduleSessionTeardown(appSessionId)
    }
  } else if (event === 'PreToolUse' || event === 'PostToolUse' || event === 'UserPromptSubmit') {
    awaitingPermission.delete(appSessionId)
    sessionStatus.set(appSessionId, 'working')
    // Archiver gates: working resets the quiet clock; a turn-ending wakeup tool
    // in PostToolUse flags pending background work; a user prompt clears it.
    archiver.noteSessionHookStatus(appSessionId, 'working')
    if (event === 'PostToolUse') archiver.noteSessionPostToolUse(appSessionId, payload.tool_name)
    if (event === 'UserPromptSubmit') {
      archiver.noteSessionUserPrompt(appSessionId)
      // A real user prompt to a GitHub agent adopts it (the spawn prompt is
      // delivered as a CLI arg but still fires this event once — swallowed).
      const ghItemId = githubAgentBySession.get(appSessionId)
      if (ghItemId) {
        if (githubInitialPromptPending.has(appSessionId)) {
          githubInitialPromptPending.delete(appSessionId)
        } else {
          adoptGithubAgent(appSessionId, ghItemId)
        }
      }
    }
    registry.setStatus(appSessionId, 'working')
    registry.markActivity()
    win.webContents.send('claude:status', { id: appSessionId, status: 'working' })
  }
}

// ── Observer endpoint handlers ──────────────────────────────────────────────

/**
 * The curator's write path back into the insights inbox.
 *
 * X-Hook-Secret (the GUARDED gate above) only proves the caller is one of the
 * app's own sessions — every session gets the same secret, so on its own it
 * would let any of them inject suggestions into the user's inbox. The
 * per-run X-Curator-Token proves the caller is *the curator run currently in
 * flight*: it is minted per run, delivered only through that PTY's env, and
 * burned when the run ends, so a missing token, another session's curl, and a
 * replay from a finished run all fail the same way.
 *
 * Payload validation lives in ingestSuggestion; a rejected payload returns 400
 * with the reason so the curator can correct itself rather than silently
 * producing nothing.
 */
function handleObserverSuggest(
  req: IncomingMessage,
  body: string,
  res: import('http').ServerResponse,
): void {
  const auth = authorizeSuggestRequest(req.headers)
  if (!auth.ok) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(auth))
    return
  }
  try {
    const payload = readJson<Parameters<typeof ingestSuggestion>[0]>(body)
    const result = ingestSuggestion(payload)
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
  }
}

/**
 * The curator's private journal, over the SAME token boundary as
 * observer-suggest: only the in-flight run can read or replace it. The journal
 * is curator memory, not a user surface — the user views it read-only from the
 * insights inbox (IPC, not this endpoint).
 */
function handleObserverJournal(
  req: IncomingMessage,
  body: string,
  res: import('http').ServerResponse,
  mode: 'read' | 'write',
): void {
  const auth = authorizeSuggestRequest(req.headers)
  if (!auth.ok) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(auth))
    return
  }
  try {
    if (mode === 'read') {
      const journal = readJournal()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, content: journal.content, chars: journal.chars }))
      return
    }
    const payload = readJson<{ content?: unknown }>(body)
    const result = writeJournal(payload.content)
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err) }))
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
  // Swallow curl exit 7 (couldn't connect) so shutdown races don't surface as hook errors;
  // other failures still propagate.
  return `curl -sf "http://127.0.0.1:${port}/hook?sid=$APP_SESSION_ID" -H 'Content-Type: application/json' -d @- > /dev/null 2>&1; c=$?; [ $c -eq 7 ] && exit 0 || exit $c # ${HOOK_MARKER}`
}

/** Synchronous hook command — outputs the server's JSON response to stdout so Claude can consume it. */
function makeSyncHookCommand(port: number): string {
  return `curl -sf "http://127.0.0.1:${port}/hook-sync?sid=$APP_SESSION_ID" -H 'Content-Type: application/json' -d @- 2>/dev/null; c=$?; [ $c -eq 7 ] && exit 0 || exit $c # ${HOOK_MARKER}`
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
