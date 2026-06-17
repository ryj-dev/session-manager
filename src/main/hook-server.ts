import { createServer, type Server } from 'http'
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, appendFileSync, mkdirSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { URL } from 'url'
import { randomUUID } from 'crypto'
import { spawnSession, writeToSession, getSession, getAllSessions, updateClaudeSessionId, killSession } from './pty-manager'
import { installSkillCommand } from './fs-service'
import { atomicWriteSync } from './atomic-write'
import * as notesManager from './notes-manager'
import { loadSettings } from './settings-store'
import * as pipelineStore from './pipeline-store'
import * as gitWorktree from './git-worktree'

let server: Server | null = null
let serverPort = 0

/** Broadcast the latest pipeline task list to the renderer mirror. */
function broadcastPipeline(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('pipeline:changed', pipelineStore.getPipelineTasks())
  }
}

// Track which sessions are idle (at the prompt) — used for GUI status indicators
const sessionStatus = new Map<string, 'working' | 'idle'>()

/** Clean up all hook-server state for a session (call on PTY exit/kill). */
export function cleanupSession(appSessionId: string): void {
  sessionStatus.delete(appSessionId)
  awaitingPermission.delete(appSessionId)
  lastProjectTodoCount.delete(appSessionId)
  sessionTurnCount.delete(appSessionId)
  lastNudgeTurn.delete(appSessionId)
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

        // ── Agentic pipeline endpoints (called by orchestrator/worker sessions) ──
        if (url.pathname === '/pipeline/get-task') { handlePipelineGetTask(body, res); return }
        if (url.pathname === '/pipeline/set-stage') { handlePipelineSetStage(body, res); return }
        if (url.pathname === '/pipeline/emit-milestone') { handlePipelineEmit(body, res); return }
        if (url.pathname === '/pipeline/request-approval') { handlePipelineApproval(body, res); return }
        if (url.pathname === '/pipeline/rename-session') { handlePipelineRename(body, res); return }
        if (url.pathname === '/pipeline/merge-worktree') { handlePipelineMergeWorktree(body, res); return }

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
  /** Pipeline linkage: register the spawned session into a task's tree. */
  pipelineTaskId?: string
  pipelineRole?: 'orchestrator' | 'plan' | 'implement' | 'review'
  /** Parent node (app session id) to attach under. Usually the spawner. */
  parentSessionId?: string
  pipelineLabel?: string
  fanoutKind?: string
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
    let session: ReturnType<typeof spawnSession>
    try {
      session = spawnSession(id, cwd, 'claude', [...args, '--', payload.prompt])
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
  'mcp__session-manager__merge-worktree',
  'mcp__session-manager__send-message',
  'mcp__session-manager__list-sessions',
  'Read', 'Grep', 'Glob',
]

function buildOrchestratorPrompt(task: pipelineStore.PipelineTask, isolated: boolean): string {
  const tagLine = task.tags.length ? `\n- tags: ${task.tags.join(', ')}` : ''
  const bodyBlock = task.body && task.body.trim()
    ? `\n\nTASK DETAILS (the user's full intent, from the todo body — follow it closely and relay the relevant parts to the planner/implementers):\n"""\n${task.body.trim()}\n"""`
    : ''
  const isolationLine = isolated
    ? `\n\nISOLATION: You and ALL your stage sessions run in a dedicated git worktree on a per-task branch, so other tasks running concurrently can't collide with you. Your branch is merged back into the integration branch automatically when the task reaches Done — do not merge to the main branch yourself.`
    : `\n\nNOTE: This task is NOT running in an isolated worktree (the project isn't a git repo, or worktree creation failed). Avoid parallel file-editing fan-out; work sequentially.`
  return `You are the ORCHESTRATOR for an agentic-pipeline task in the Session Manager app. You own this task end-to-end and drive it through the pipeline by coordinating SEPARATE Claude sessions — you do not write code yourself.

TASK
- taskId: ${task.id}
- title: ${task.title}
- autonomy: ${task.autonomy}   (manual = pause at every hand-off · gated = pause at gates · auto = run unattended)${tagLine}${bodyBlock}${isolationLine}

PIPELINE: Plan → Implement → Review (review⇄implement loop) → Done.

YOUR TOOLS (session-manager MCP):
- emit-milestone({ taskId, text, status?, badge?, tone?, kind? }) — narrate to the board. Call it at EVERY notable step; the user watches this feed. Set kind to colour-code the feed: 'plan-ready' | 'fanout' | 'review-verdict' | 'blocked' | 'done' | 'error' | 'info'.
- spawn-session({ prompt, pipelineTaskId, pipelineRole, pipelineLabel?, fanoutKind?, reportBack }) — spawn a stage session or fan-out worker. ALWAYS pass pipelineTaskId="${task.id}". Children report back to you automatically.
- pipeline-set-stage({ taskId, stage }) — advance the board (plan|implement|review|done).
- pipeline-request-approval({ taskId, gate, detail }) — pause for the user. Under autonomy=auto it auto-approves and advances; under gated/manual it returns "pending" and you MUST STOP and wait for an approval message before continuing.
- pipeline-get-task({ taskId }) — re-read full state (use this first if you are resuming).

WORKFLOW
1. emit-milestone "Task accepted — planning."
2. Spawn a PLANNER: spawn-session({ pipelineTaskId:"${task.id}", pipelineRole:"plan", pipelineLabel:"Architect", reportBack:"true", prompt:"<gather context for: ${task.title}, then produce a concrete implementation plan. You MAY fan out research probes via spawn-session with pipelineTaskId='${task.id}', pipelineRole='plan', fanoutKind='research'. Report the final plan back.>" }).
3. When the planner reports its plan: emit-milestone "Plan ready", then pipeline-request-approval({ gate:"Begin implementation", detail:"<one-line plan summary>" }). If pending → STOP and wait. When approved/auto-approved → continue.
4. pipeline-set-stage "implement". Spawn an IMPLEMENTER (pipelineRole:"implement"). Wait for it to report completion.
   PARALLEL WORKTREE FAN-OUT (when the work splits cleanly into independent pieces): spawn each worker with isolate:true, a UNIQUE worktreeBranch (a short descriptive label, e.g. "csv-export", "auth-guard"), fanoutKind:"worktrees", and a descriptive pipelineLabel. Each worker builds in its OWN isolated git worktree+branch, so they can't clobber each other. When a worker reports it has FINISHED, call merge-worktree({ taskId:"${task.id}", sessionId:<that worker's id> }): on success the branch is merged, its worktree removed, and the node goes read-only; on "MERGE CONFLICT" send-message that worker to resolve the conflict in its (still-present) worktree and then re-call merge-worktree, OR spawn a fix worker for it. Only advance to review once ALL workers are merged. NOTE: if the project is not a git repo, isolation is skipped automatically (a warning milestone is emitted) and workers run in the shared dir — in that case do NOT fan out into parallel worktrees; run sequentially instead.
5. pipeline-set-stage "review". Spawn ONE reviewer session per RELEVANT dimension below (pipelineRole:"review", fanoutKind:"topics", pipelineLabel:<dimension>). Give each reviewer a SPECIFIC, contextual prompt scoped to THIS change — name the exact files/areas to inspect and what to check (e.g. "Inspect the auth changes in src/x.ts and verify the new token check can't be bypassed"). Do NOT spawn generic "security reviewer" sessions; write the concern into the prompt. Skip dimensions that don't apply to this change.
   Review dimensions to consider:
   - Correctness/logic — does it match the plan; edge cases handled
   - Bugs/runtime safety — null/undefined, async, error handling, regressions
   - Security — input validation, authz, secrets, unsafe calls (only if the change touches these)
   - Architecture/design — fits existing patterns, coupling, abstractions
   - Tests — coverage present and passing
   - Performance — only if the change touches hot paths
   Each reviewer reports a verdict back to you (pass, or changes-requested with specifics). Collect all verdicts and emit-milestone a summary each round. If any request changes, spawn an implementer (pipelineRole:"implement") to fix, then RE-REVIEW — re-run only the dimensions that failed. LOOP until all relevant reviewers pass.
6. pipeline-request-approval({ gate:"Merge to Done" }). When approved/auto → pipeline-set-stage "done". The set-stage response includes an "integration" result: only when integration.ok is true is the task actually Done (emit-milestone "Done."). If integration.ok is false there was a MERGE CONFLICT integrating your task branch into the integration branch — the card is held in Review (NOT Done), the worktree is kept, and integration.conflicts lists the conflicting files. In that case do NOT report success: emit-milestone a 'blocked'/'error' note, then spawn an implementer (pipelineRole:"implement") in the task worktree to merge the integration branch in and resolve the conflicts (or raise a gate for the user), and re-call pipeline-set-stage "done" to re-attempt integration. Loop until integration.ok is true.

RULES
- Pass pipelineTaskId="${task.id}" on every spawn so sessions slot into this task's tree.
- Give every session you spawn a DESCRIPTIVE pipelineLabel so the user can tell them apart on the board, e.g. "Architect", "Implement · CSV serializer", "Security review · auth token check". You can relabel any child later with pipeline-rename-session({ taskId:"${task.id}", sessionId, label }).
- Respect autonomy: under manual/gated, request approval at gates and WAIT; under auto, proceed.
- When a spawned session reports it has FINISHED, mark it done so it can be cleaned up (frees resources): emit-milestone({ taskId:"${task.id}", sessionId:<that session's id>, status:"done", text:"<short>" }). All sessions are torn down automatically when the task reaches Done.
- You coordinate only — never edit code or run builds yourself; delegate to spawned sessions.

Begin now.`
}

/** Spawn the orchestrator session for a task and register it as the tree root.
 *  Called from the renderer's pipeline:start IPC. */
export function spawnPipelineOrchestrator(task: pipelineStore.PipelineTask): { id: string } {
  const baseDir = task.projectPath || loadSettings().baseProjectsDir || app.getPath('home')
  // Per-task isolation: run the whole task (orchestrator + every stage session,
  // which inherit this cwd) in its OWN git worktree on a per-task branch, so
  // concurrent tasks can't collide in the shared working tree. Integrated back
  // into the main branch when the task reaches Done. Falls back to the shared
  // dir if the project isn't a git repo.
  let cwd = baseDir
  let isolated = false
  const repoRoot = gitWorktree.getRepoRoot(baseDir)
  if (repoRoot) {
    try {
      const branch = gitWorktree.branchNameFor(task.id, 'task')
      const ref = gitWorktree.addWorktree({ repoRoot, taskId: task.id, branch })
      cwd = ref.worktreePath
      isolated = true
      pipelineStore.setTaskWorktree(task.id, { repoRoot, worktreePath: ref.worktreePath, worktreeBranch: ref.branch })
    } catch (err) {
      console.error('[hook-server] per-task worktree creation failed; running in shared dir:', err)
    }
  }
  const id = randomUUID()
  const prompt = buildOrchestratorPrompt(task, isolated)
  // Auto permission mode so it can call its (scoped) tools without prompts.
  const args = ['--permission-mode', 'auto', '--allowedTools', ...ORCHESTRATOR_TOOLS, '--', prompt]
  const session = spawnSession(id, cwd, 'claude', args)

  if (attachListenersFn) attachListenersFn(id, session)

  pipelineStore.upsertPipelineSession(task.id, {
    id,
    role: 'orchestrator',
    label: 'Orchestrator',
    status: 'working',
    badge: 'starting',
    tone: 'active',
    claudeSessionId: session.claudeSessionId ?? null,
    cwd,
  })

  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('session:spawned', { id, projectPath: cwd, claudeSessionId: session.claudeSessionId ?? null, isPipeline: true })
  }
  broadcastPipeline()

  console.log(`[hook-server] spawned orchestrator ${id} for task ${task.id} in ${cwd}`)
  return { id }
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

// ── Pipeline endpoint handlers ──────────────────────────────────────────────

function readJson<T>(body: string): T {
  return JSON.parse(body) as T
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

/** Best-effort removal of any live worktrees in a task's tree — called on
 *  terminal states (Done / task removed) to clean up crashed/abandoned workers. */
export function cleanupTaskWorktrees(taskId: string): void {
  const task = pipelineStore.getPipelineTask(taskId)
  // Session-level fan-out worker worktrees.
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
