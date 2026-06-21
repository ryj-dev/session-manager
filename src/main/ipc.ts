import { ipcMain, BrowserWindow, app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, rmSync, statSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  spawnSession,
  writeToSession,
  writeWhenReady,
  resizeSession,
  killSession,
  getSession,
  getAllSessions,
  getActiveSessions,
  updateSessionTitle,
  onClaudeSessionIdChange,
  TITLE_INDICATOR_RE,
  isDefaultTitle
} from './pty-manager'
import { readDirectory, readFile, getHomeDir, isDirectory, installSkillCommand, uninstallSkillCommand, cleanupAllSkillCommands } from './fs-service'
import { onPtyData as hookOnPtyData, setAttachListeners, cleanupSession as hookCleanupSession, deliverSessionMessage, removeHooks, reinstallHooks, startPipelineTaskFlow, cleanupTaskWorktrees, finalizeTaskCompletion, restartPipelineOrchestrator, autoResumeInflightOrchestrators, pausePipelineTask, resumePipelineTask } from './hook-server'
import { loadSavedSessions, clearSavedSessions, type SavedSession } from './session-store'
import { loadSplitGroups, saveSplitGroups, type SavedSplitGroup } from './split-groups-store'
import { loadSettings, saveSettings, setDisabledIntegration, type AppSettings } from './settings-store'
import { unregisterMcpServer } from './mcp-launcher'
import { uninstallPlugin, installPlugin } from './plugin-manager'
import {
  readNote,
  writeNote,
  deleteNoteFile,
  extractWikilinks,
  buildRawBody,
  type MemoryNote
} from './memory/store'
import {
  getIndex,
  invalidate,
  searchNotes,
  getGraphData,
  resolveWikilink,
  beginBatch,
  endBatch
} from './memory/index'
import { syncBacklinks, getInboundLinks, cleanupRefsBeforeDelete, addToRelatedSection, filenameToWikilink } from './memory/backlinks'
import { validateNote, slugify, generateNote, touchModified, appendToSection, replaceSectionContent, prependToSection } from './memory/core'
import * as notesManager from './notes-manager'
import type { TodoFilter } from './notes-manager'
import * as pipelineStore from './pipeline-store'
import type { PipelineStage, AutonomyLevel, DiffSource } from './pipeline-store'

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

// Track which sessions already have listeners attached (prevent double-attach on reconnect)
const attachedSessions = new Set<string>()

function attachSessionListeners(
  id: string,
  session: ReturnType<typeof spawnSession>
): void {
  if (attachedSessions.has(id)) return
  attachedSessions.add(id)

  // Always use sendToRenderer — never capture a specific sender reference.
  // This ensures data flows to whatever renderer is currently alive,
  // surviving renderer crashes/reloads (e.g. from GPU process death on screen lock).
  session.process.onData((data) => {
    sendToRenderer(`pty:data:${id}`, data)
    sendToRenderer('pty:activity', id)
    hookOnPtyData(id, data)
  })

  session.process.onExit(({ exitCode }) => {
    attachedSessions.delete(id)
    setTimeout(() => {
      sendToRenderer('pty:exit', { id, exitCode })
    }, 200)
  })
}

export function registerIpcHandlers(opts: { reinstallMcp: () => void }): void {
  // Register the attach-listeners callback for hook-server spawned sessions
  setAttachListeners((id, session) => attachSessionListeners(id, session))

  // Broadcast Claude session ID changes to the renderer so the store can update.
  onClaudeSessionIdChange((id, claudeSessionId) => {
    sendToRenderer('session:claudeId', { id, claudeSessionId })
    // Persist the id into the owning pipeline node so a later relaunch resumes the
    // current conversation, not a stale fork (claudeSessionId can drift on resume).
    for (const t of pipelineStore.getPipelineTasks()) {
      if (pipelineStore.getPipelineSessionIds(t.id).includes(id)) {
        pipelineStore.setSessionClaudeId(t.id, id, claudeSessionId)
        break
      }
    }
  })

  // Spawn a new PTY session
  ipcMain.handle(
    'pty:spawn',
    (event, { cwd, command, args, allowedTools, autoMode }: { cwd: string; command?: string; args?: string[]; allowedTools?: string[]; autoMode?: boolean }) => {
      console.log('[main] pty:spawn', { cwd, command, args, allowedTools, autoMode })
      const id = randomUUID()

      const isClaude = command === 'claude' || !command

      // Inject --allowedTools for agent sessions
      let finalArgs = args
      if (allowedTools && allowedTools.length > 0 && isClaude) {
        finalArgs = [...(args || []), '--allowedTools', ...allowedTools]
      }

      // Inject --permission-mode auto when requested by the caller, or fall
      // back to the manual-session setting for callers that don't pass an
      // explicit value (preserves legacy behavior).
      const useAuto = isClaude && (autoMode ?? loadSettings().autoModeForManualSessions)
      if (useAuto) {
        finalArgs = ['--permission-mode', 'auto', ...(finalArgs || [])]
      }

      try {
        const session = spawnSession(id, cwd, command, finalArgs)
        console.log('[main] session spawned:', id)
        attachSessionListeners(id, session)
        return { id, projectPath: cwd, claudeSessionId: session.claudeSessionId ?? null }
      } catch (err) {
        console.error('[main] spawn failed:', err)
        throw err
      }
    }
  )

  // Resume a saved claude session
  ipcMain.handle(
    'pty:resume',
    (event, { claudeSessionId, projectPath, autoMode, ephemeral }: { claudeSessionId: string; projectPath: string; autoMode?: boolean; ephemeral?: boolean }) => {
      const id = randomUUID()
      const resumeArgs = ['--resume', claudeSessionId]
      const finalArgs = autoMode ? ['--permission-mode', 'auto', ...resumeArgs] : resumeArgs
      const session = spawnSession(id, projectPath, 'claude', finalArgs)
      // Pre-set the claude session ID since we already know it
      session.claudeSessionId = claudeSessionId
      // Best-effort view-resume (pipeline drawer): never persist this PTY on quit —
      // the renderer kills it on unmount.
      session.ephemeral = ephemeral === true
      attachSessionListeners(id, session)
      return { id, projectPath, claudeSessionId }
    }
  )

  // List active PTY sessions (for renderer reconnection after crash/reload)
  ipcMain.handle('pty:listActive', () => {
    return getActiveSessions()
  })

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
    hookCleanupSession(id)
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

  // Composite/split-view groups — persisted across restarts. Renderer pushes
  // the current set on every change (keyed by claudeSessionId) and loads at
  // startup once saved PTY sessions are resumed.
  ipcMain.handle('splitGroups:load', () => {
    return loadSplitGroups()
  })
  ipcMain.on('splitGroups:save', (_e, groups: SavedSplitGroup[]) => {
    try { saveSplitGroups(groups) } catch (err) { console.warn('[splitGroups] save failed', err) }
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
    const titleClean = session.terminalTitle?.replace(TITLE_INDICATOR_RE, '').trim() ?? ''
    const isResumable = !!(session.claudeSessionId && !isDefaultTitle(titleClean))
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

  // ── Memory notes ────────────────────────────────────────────────────────

  ipcMain.handle('memory:list', (_event, filter?: { tag?: string; type?: string }) => {
    const idx = getIndex()
    let notes = [...idx.values()]
    if (filter?.tag) notes = notes.filter((n) => n.tags.includes(filter.tag!))
    if (filter?.type) notes = notes.filter((n) => n.type === filter.type!)
    return notes
  })

  ipcMain.handle('memory:read', (_event, filename: string) => {
    return readNote(filename)
  })

  ipcMain.handle(
    'memory:create',
    (
      _event,
      {
        filename,
        title,
        type,
        tags,
        summary,
        context,
        details,
        outcome,
      }: {
        filename?: string; title: string; type?: string; tags?: string[]
        summary?: string; context?: string; details?: string; outcome?: string
      }
    ) => {
      let fn = filename || slugify(title)
      if (!fn.endsWith('.md')) fn = `${fn}.md`

      if (readNote(fn)) {
        throw new Error(`Note "${fn}" already exists`)
      }

      const rawBody = generateNote({ title, type: type as any, tags, summary, context, details, outcome })
      const validation = validateNote(rawBody)
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(', ')}`)
      }

      writeNote(fn, rawBody)
      invalidate(fn)

      let note = readNote(fn)!
      syncBacklinks(fn, [], note.wikilinks)
      note = readNote(fn)!  // Re-read — syncBacklinks may have updated source's Related

      // Sync inbound links — existing notes that already reference this new note
      const inbound = getInboundLinks(fn)
      if (inbound.length > 0) {
        let updatedRaw = note.rawBody
        for (const refFn of inbound) {
          updatedRaw = addToRelatedSection(updatedRaw, filenameToWikilink(refFn))
        }
        if (updatedRaw !== note.rawBody) {
          writeNote(fn, updatedRaw)
          invalidate(fn)
          note = readNote(fn)!
        }
      }

      return note
    }
  )

  ipcMain.handle(
    'memory:update',
    (
      _event,
      {
        filename,
        frontmatter,
        body
      }: { filename: string; frontmatter?: Record<string, unknown>; body?: string }
    ) => {
      const existing = readNote(filename)
      if (!existing) throw new Error(`Note "${filename}" not found`)

      const oldWikilinks = existing.wikilinks
      let rawBody: string

      if (frontmatter && body !== undefined) {
        // Full replacement
        rawBody = buildRawBody(frontmatter, body)
      } else if (body !== undefined) {
        // Body-only update — preserve existing frontmatter
        rawBody = buildRawBody(
          { title: existing.title, type: existing.type, tags: existing.tags, date: existing.date, modified: existing.modified },
          body
        )
      } else if (frontmatter) {
        // Frontmatter-only update — preserve existing body
        rawBody = buildRawBody(frontmatter, existing.body)
      } else {
        return existing
      }

      rawBody = touchModified(rawBody)

      const validation = validateNote(rawBody)
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(', ')}`)
      }

      writeNote(filename, rawBody)
      invalidate(filename)

      const updated = readNote(filename)!
      syncBacklinks(filename, oldWikilinks, updated.wikilinks)

      return updated
    }
  )

  ipcMain.handle(
    'memory:editSection',
    (
      _event,
      { filename, heading, operation, content }: {
        filename: string; heading: string; operation: 'append' | 'prepend' | 'replace'; content: string
      }
    ) => {
      const existing = readNote(filename)
      if (!existing) throw new Error(`Note "${filename}" not found`)

      if (heading === 'Related') {
        throw new Error('## Related is auto-managed and cannot be edited directly')
      }

      const oldWikilinks = existing.wikilinks
      let rawBody: string

      if (operation === 'replace') rawBody = replaceSectionContent(existing.rawBody, heading, content)
      else if (operation === 'append') rawBody = appendToSection(existing.rawBody, heading, content)
      else rawBody = prependToSection(existing.rawBody, heading, content)

      rawBody = touchModified(rawBody)

      writeNote(filename, rawBody)
      invalidate(filename)

      const updated = readNote(filename)!
      syncBacklinks(filename, oldWikilinks, updated.wikilinks)

      return updated
    }
  )

  ipcMain.handle(
    'memory:delete',
    (_event, { filename, force }: { filename: string; force?: boolean }) => {
      const existing = readNote(filename)
      if (!existing) throw new Error(`Note "${filename}" not found`)

      const inbound = getInboundLinks(filename)
      if (inbound.length > 0 && !force) {
        return {
          error: 'Cannot delete: note is referenced by other notes',
          referencedBy: inbound
        }
      }

      if (inbound.length > 0 || existing.wikilinks.length > 0) {
        cleanupRefsBeforeDelete(filename)
      }

      deleteNoteFile(filename)
      invalidate(filename)

      return { ok: true, cleaned: inbound.length }
    }
  )

  ipcMain.handle(
    'memory:search',
    (
      _event,
      { query, searchType, tag, type }: { query: string; searchType?: 'content' | 'filename' | 'both'; tag?: string; type?: string }
    ) => {
      return searchNotes(query, searchType, tag, type)
    }
  )

  ipcMain.handle('memory:graph', () => {
    return getGraphData()
  })

  ipcMain.handle('memory:resolveLink', (_event, link: string) => {
    return resolveWikilink(link)
  })

  // ── Todos ──────────────────────────────────────────────────────────────

  ipcMain.handle('todos:list', async (_e, filter?: TodoFilter) => {
    if (filter?.search && filter.search.trim()) {
      const { search, ...rest } = filter
      return notesManager.searchTodosHybrid(search, rest)
    }
    return notesManager.listTodosSummary(filter)
  })
  ipcMain.handle('todos:read', (_e, id: string) => notesManager.readTodo(id))
  ipcMain.handle(
    'todos:create',
    (_e, input: { title: string; body?: string; tags?: string[] }) => notesManager.createTodo(input),
  )
  ipcMain.handle(
    'todos:update',
    (_e, id: string, patch: Parameters<typeof notesManager.updateTodo>[1]) => notesManager.updateTodo(id, patch),
  )
  ipcMain.handle('todos:delete', (_e, id: string) => notesManager.deleteTodo(id))
  ipcMain.handle('todos:listTags', () => notesManager.listAllTags())
  ipcMain.handle('todos:projectFromCwd', (_e, cwd: string) => notesManager.projectFromCwd(cwd))
  ipcMain.handle('todos:projectTagFromCwd', (_e, cwd: string) => notesManager.projectTagFromCwd(cwd))

  // Agentic pipeline (Cmd+L). Main owns the state; renderer mirrors it via the
  // 'pipeline:changed' broadcast. Orchestrator sessions mutate the same store
  // through the hook-server bridge (added in a later phase).
  ipcMain.handle('pipeline:list', () => pipelineStore.getPipelineTasks())
  ipcMain.handle('pipeline:autoResume', () => autoResumeInflightOrchestrators())
  ipcMain.handle('pipeline:start', (_e, todo: { id: string; title: string; tags: string[] }, defaultAutonomy: AutonomyLevel, projectPath?: string) => {
    // The full start flow (todo lookup, double-start guard, projectPath
    // derivation, orchestrator spawn, broadcast) lives in the shared
    // startPipelineTaskFlow so the IPC and pipeline-start MCP tool can't diverge.
    return startPipelineTaskFlow({ todoId: todo.id, defaultAutonomy, projectPath }).tasks
  })
  ipcMain.handle(
    'pipeline:startReview',
    (
      _e,
      todo: { id: string; title: string; tags: string[] },
      defaultAutonomy: AutonomyLevel,
      diffSource: DiffSource,
      projectPath?: string,
    ) => {
      // Send-to-review: begin at the review stage against an existing diff
      // (working tree or a committed range), skipping plan/implement. Shares the
      // same flow as pipeline:start, threading startStage + diffSource through.
      return startPipelineTaskFlow({
        todoId: todo.id,
        defaultAutonomy,
        projectPath,
        startStage: 'review',
        diffSource,
      }).tasks
    },
  )
  ipcMain.handle('pipeline:setStage', async (_e, id: string, stage: PipelineStage) => {
    // Detect a BACKWARD move (target earlier than the current stage) on an
    // already-running task. Done is excluded — it routes to the finalize/integrate
    // path below. Doing this in MAIN makes it robust regardless of caller.
    const task = pipelineStore.getPipelineTask(id)
    const order: PipelineStage[] = ['plan', 'implement', 'review', 'done']
    const backward = !!task?.orchestrator && order.indexOf(stage) < order.indexOf(task.stage)
    // Manual advance to Done is contingent on a clean merge: finalizeTaskCompletion
    // integrates first and only then moves the card to Done (on conflict it holds
    // the card in Review with a visible badge). Other stages advance directly.
    if (stage === 'done') {
      try { await finalizeTaskCompletion(id) } catch (err) { console.error('[pipeline] task completion failed:', err) }
    } else if (backward) {
      // Backward drag = RESTART from the target with a fresh orchestrator (the old
      // session re-enters its concluded "task complete" conversation and refuses
      // to work). Tears down the old tree, resets transient state, and respawns.
      // restartPipelineOrchestrator broadcasts internally, so no explicit push here.
      try { restartPipelineOrchestrator(id, stage) } catch (err) { console.error('[pipeline] task restart failed:', err) }
    } else {
      pipelineStore.setPipelineStage(id, stage)
      sendToRenderer('pipeline:changed', pipelineStore.getPipelineTasks())
    }
    return pipelineStore.getPipelineTasks()
  })
  ipcMain.handle('pipeline:setAutonomy', (_e, id: string, level: AutonomyLevel) => {
    const tasks = pipelineStore.setPipelineAutonomy(id, level)
    sendToRenderer('pipeline:changed', tasks)
    return tasks
  })
  ipcMain.handle('pipeline:resolveGate', async (_e, id: string, approve: boolean) => {
    // Capture BEFORE resolving — resolvePipelineGate clears the gate.
    const before = pipelineStore.getPipelineTask(id)
    const gateLabel = before?.gate?.label ?? 'gate'
    const orchestratorId = before?.orchestrator?.id

    const tasks = pipelineStore.resolvePipelineGate(id, approve)
    sendToRenderer('pipeline:changed', tasks)
    // Approving a gate can advance the task to Done. resolvePipelineGate already
    // set the stage optimistically; re-run the gated completion so a merge
    // conflict reverts the card to Review (not Done) and integration runs.
    if (approve && pipelineStore.getPipelineTask(id)?.stage === 'done') {
      try { await finalizeTaskCompletion(id) } catch (err) { console.error('[pipeline] task completion failed:', err) }
    }

    // Wake the orchestrator so gated/manual tasks resume. The orchestrator STOPS
    // after pipeline-request-approval returns "pending" and waits for this message.
    // Read the stage AFTER finalize so the text reflects the real landing stage
    // (a merge conflict holds the card in Review, not Done).
    if (orchestratorId) {
      const stage = pipelineStore.getPipelineTask(id)?.stage
      const message = approve
        ? `✅ The user APPROVED the gate "${gateLabel}". The board is now at the "${stage}" stage — resume the pipeline and proceed with the ${stage} work now. Call pipeline-get-task first if you need to recover context.`
        : `↩️ The user SENT BACK the gate "${gateLabel}" (changes requested). The task stays at the "${stage}" stage — do NOT advance. Revise the current stage's work to address the feedback, then re-request approval (pipeline-request-approval) when ready.`
      const res = deliverSessionMessage(orchestratorId, message, null)
      if (!res.ok) console.warn(`[pipeline] gate resolve: could not wake orchestrator ${orchestratorId}: ${res.error}`)
    }

    return pipelineStore.getPipelineTasks()
  })
  ipcMain.handle('pipeline:remove', (_e, id: string) => {
    // Stop the live sessions FIRST. Dragging a started task back to Backlog (or
    // any removal) used to only clean up worktrees + drop the task, leaving the
    // orchestrator + worker PTYs running — burning tokens, still editing files,
    // and racing cleanupTaskWorktrees as it force-removed the worktrees out from
    // under them (lost uncommitted work). Kill the whole session tree, then clean
    // up the now-idle worktrees.
    for (const sid of pipelineStore.getPipelineSessionIds(id)) {
      try { killSession(sid); hookCleanupSession(sid) } catch (err) { console.error('[pipeline] session teardown on remove failed:', err) }
    }
    try { cleanupTaskWorktrees(id) } catch (err) { console.error('[pipeline] worktree cleanup on remove failed:', err) }
    const tasks = pipelineStore.removePipelineTask(id)
    sendToRenderer('pipeline:changed', tasks)
    return tasks
  })
  ipcMain.handle('pipeline:pause', (_e, id: string) => {
    // Graceful stop: kill the live session tree, keep the worktree +
    // claudeSessionId, mark paused. pausePipelineTask broadcasts internally.
    try { pausePipelineTask(id) } catch (err) { console.error('[pipeline] pause failed:', err) }
    return pipelineStore.getPipelineTasks()
  })
  ipcMain.handle('pipeline:resume', (_e, id: string) => {
    // Re-wake the orchestrator from its saved claudeSessionId + re-attach the
    // worktree (reuses the relaunch resume path).
    let result: 'resumed' | 'skipped-live' | 'failed' = 'failed'
    try { result = resumePipelineTask(id) } catch (err) { console.error('[pipeline] resume failed:', err) }
    sendToRenderer('pipeline:changed', pipelineStore.getPipelineTasks())
    return { result, tasks: pipelineStore.getPipelineTasks() }
  })

  // Send an inter-session message (used by notes dispatch + future hooks)
  ipcMain.handle(
    'session:sendMessage',
    (_e, targetSessionId: string, message: string, fromSessionId?: string | null) => {
      return deliverSessionMessage(targetSessionId, message, fromSessionId ?? null)
    }
  )

  // Claude Code settings — read/write ~/.claude/settings.json
  const claudeSettingsPath = join(app.getPath('home'), '.claude', 'settings.json')

  // ── Statusline configuration ──────────────────────────────────────────
  const isWin = process.platform === 'win32'
  const statuslineConfigPath = join(app.getPath('home'), '.claude', 'statusline-config.json')
  const statuslineScriptPath = join(app.getPath('home'), '.claude', isWin ? 'statusline-command.js' : 'statusline-command.sh')

  ipcMain.handle('claude:getStatuslineConfig', () => {
    try {
      return JSON.parse(readFileSync(statuslineConfigPath, 'utf-8'))
    } catch {
      // No managed config — check if there's a custom statusline in settings.json
      let hasCustom = false
      try {
        const settings = JSON.parse(readFileSync(claudeSettingsPath, 'utf-8'))
        hasCustom = !!settings.statusLine
      } catch { /* no settings file */ }

      return {
        managed: false,
        hasCustom,
        elements: ['model', 'rateLimit5h', 'rateLimit7d'],
        scriptPath: statuslineScriptPath,
        settingsPath: claudeSettingsPath,
      }
    }
  })

  ipcMain.handle('claude:setStatuslineConfig', (_event, elements: string[], customComponents?: CustomComponentDef[]) => {
    try {
      // Save config (preserve existing custom components if not provided)
      let existingCustom: CustomComponentDef[] = []
      try {
        const existing = JSON.parse(readFileSync(statuslineConfigPath, 'utf-8'))
        existingCustom = existing.customComponents || []
      } catch { /* no existing config */ }

      const config = {
        managed: true,
        elements,
        customComponents: customComponents ?? existingCustom,
      }
      writeFileSync(statuslineConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')

      // Generate and write statusline script (bash on macOS/Linux, Node.js on Windows)
      const script = isWin
        ? generateStatuslineScriptNode(elements, config.customComponents)
        : generateStatuslineScript(elements, config.customComponents)
      writeFileSync(statuslineScriptPath, script, 'utf-8')
      if (!isWin) chmodSync(statuslineScriptPath, 0o755)

      // Ensure ~/.claude/settings.json points to the script
      const command = isWin
        ? `node "${statuslineScriptPath}"`
        : `bash ${statuslineScriptPath}`
      let settings: Record<string, unknown> = {}
      try {
        settings = JSON.parse(readFileSync(claudeSettingsPath, 'utf-8'))
      } catch { /* file doesn't exist */ }
      settings.statusLine = { type: 'command', command }
      writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')

      return true
    } catch {
      return false
    }
  })

  // ── CLAUDE.md instructions installer ────────────────────────────────
  const claudeMdPath = join(app.getPath('home'), '.claude', 'CLAUDE.md')
  const CLAUDE_MD_MARKER = '<!-- session-manager-instructions -->'

  ipcMain.handle('claude:getClaudeMdStatus', () => {
    try {
      const content = readFileSync(claudeMdPath, 'utf-8')
      return { exists: true, hasInstructions: content.includes(CLAUDE_MD_MARKER) }
    } catch {
      return { exists: false, hasInstructions: false }
    }
  })

  ipcMain.handle('claude:getClaudeMdPreview', () => {
    return generateClaudeMdInstructions()
  })

  ipcMain.handle('claude:installClaudeMdInstructions', () => {
    try {
      mkdirSync(join(app.getPath('home'), '.claude'), { recursive: true })

      let existing = ''
      try { existing = readFileSync(claudeMdPath, 'utf-8') } catch { /* doesn't exist */ }

      // Already installed
      if (existing.includes(CLAUDE_MD_MARKER)) return { ok: true, alreadyInstalled: true }

      const instructions = generateClaudeMdInstructions()
      const separator = existing.length > 0 && !existing.endsWith('\n\n') ? '\n\n' : ''
      writeFileSync(claudeMdPath, existing + separator + instructions, 'utf-8')
      return { ok: true, alreadyInstalled: false }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('claude:removeClaudeMdInstructions', () => {
    try {
      const content = readFileSync(claudeMdPath, 'utf-8')
      // Remove from marker start to marker end (inclusive)
      const startMarker = CLAUDE_MD_MARKER
      const endMarker = '<!-- /session-manager-instructions -->'
      const startIdx = content.indexOf(startMarker)
      const endIdx = content.indexOf(endMarker)
      if (startIdx === -1 || endIdx === -1) return { ok: true }

      const before = content.slice(0, startIdx).replace(/\n+$/, '')
      const after = content.slice(endIdx + endMarker.length).replace(/^\n+/, '')
      const result = before + (before && after ? '\n\n' : '') + after
      writeFileSync(claudeMdPath, result, 'utf-8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // ── Cleanup / Uninstall ─────────────────────────────────────────────
  registerCleanupHandlers(claudeSettingsPath, statuslineConfigPath, statuslineScriptPath, claudeMdPath, CLAUDE_MD_MARKER, opts.reinstallMcp)
}

// ── Cleanup helpers ─────────────────────────────────────────────────

function dirSizeAndCount(dir: string, exts?: string[]): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  const walk = (current: string): void => {
    let entries: string[]
    try { entries = readdirSync(current) } catch { return }
    for (const entry of entries) {
      const full = join(current, entry)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full)
      else if (st.isFile()) {
        if (!exts || exts.some((e) => entry.endsWith(e))) {
          bytes += st.size
          files += 1
        }
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

function fileSize(path: string): number {
  try { return statSync(path).size } catch { return 0 }
}

function clearDirContents(dir: string): { bytes: number; files: number } {
  if (!existsSync(dir)) return { bytes: 0, files: 0 }
  const stats = dirSizeAndCount(dir)
  for (const entry of readdirSync(dir)) {
    rmSync(join(dir, entry), { recursive: true, force: true })
  }
  return stats
}

interface CleanupStatus {
  mcp: { installed: boolean; disabled: boolean }
  hooks: { installed: boolean; disabled: boolean }
  statusline: { installed: boolean; managed: boolean; hasCustom: boolean }
  claudeMd: { installed: boolean }
  plugin: { pluginDirExists: boolean; disabled: boolean }
  memory: { exists: boolean; bytes: number; files: number }
  embeddings: { dbExists: boolean; dbBytes: number; modelCacheExists: boolean; modelCacheBytes: number }
  notes: { exists: boolean; bytes: number; files: number }
  sessions: { savedExists: boolean; messagesExists: boolean }
  appSettings: { exists: boolean }
}

function registerCleanupHandlers(
  claudeSettingsPath: string,
  statuslineConfigPath: string,
  statuslineScriptPath: string,
  claudeMdPath: string,
  CLAUDE_MD_MARKER: string,
  reinstallMcp: () => void,
): void {
  const userData = app.getPath('userData')
  const home = app.getPath('home')
  const mcpJsonPath = join(home, '.claude.json')
  const memoriesDir = join(userData, 'memories')
  const notesDir = join(userData, 'notes')
  const embeddingsDb = join(userData, 'memory-embeddings.db')
  const modelCacheDir = join(userData, 'models', 'bge-small-en-v1.5')
  const sessionsFile = join(userData, 'sessions.json')
  const messagesDir = join(userData, 'messages')
  const pluginDir = join(userData, 'plugin')
  const settingsFile = join(userData, 'state', 'settings.json')

  const HOOK_MARKER = 'session-manager-hook'

  function readJsonSafe(path: string): Record<string, unknown> | null {
    try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return null }
  }

  function getStatus(): CleanupStatus {
    const disabled = loadSettings().disabledIntegrations ?? {}

    const mcpJson = readJsonSafe(mcpJsonPath)
    const mcpInstalled = !!(mcpJson?.mcpServers && (mcpJson.mcpServers as Record<string, unknown>)['session-manager'])

    const claudeSettings = readJsonSafe(claudeSettingsPath) ?? {}
    const hooks = (claudeSettings.hooks ?? {}) as Record<string, Array<Record<string, unknown>>>
    let hooksInstalled = false
    for (const eventName of Object.keys(hooks)) {
      for (const entry of hooks[eventName] ?? []) {
        const entryHooks = entry.hooks as Array<Record<string, unknown>> | undefined
        if (entryHooks?.some((h) => typeof h.command === 'string' && (h.command as string).includes(HOOK_MARKER))) {
          hooksInstalled = true
          break
        }
      }
      if (hooksInstalled) break
    }

    const statuslineConfig = readJsonSafe(statuslineConfigPath)
    const hasCustom = !!claudeSettings.statusLine
    const statuslineManaged = !!(statuslineConfig && statuslineConfig.managed)

    let claudeMdInstalled = false
    try { claudeMdInstalled = readFileSync(claudeMdPath, 'utf-8').includes(CLAUDE_MD_MARKER) } catch { /* missing */ }

    const memoryStats = existsSync(memoriesDir) ? dirSizeAndCount(memoriesDir, ['.md']) : { bytes: 0, files: 0 }
    const notesStats = existsSync(notesDir) ? dirSizeAndCount(notesDir) : { bytes: 0, files: 0 }
    const modelCacheBytes = existsSync(modelCacheDir) ? dirSizeAndCount(modelCacheDir).bytes : 0

    return {
      mcp: { installed: mcpInstalled, disabled: !!disabled.mcp },
      hooks: { installed: hooksInstalled, disabled: !!disabled.hooks },
      statusline: {
        installed: statuslineManaged || hasCustom,
        managed: statuslineManaged,
        hasCustom,
      },
      claudeMd: { installed: claudeMdInstalled },
      plugin: { pluginDirExists: existsSync(pluginDir), disabled: !!disabled.plugin },
      memory: { exists: existsSync(memoriesDir) && memoryStats.files > 0, bytes: memoryStats.bytes, files: memoryStats.files },
      embeddings: {
        dbExists: existsSync(embeddingsDb),
        dbBytes: fileSize(embeddingsDb),
        modelCacheExists: existsSync(modelCacheDir),
        modelCacheBytes,
      },
      notes: { exists: existsSync(notesDir) && notesStats.files > 0, bytes: notesStats.bytes, files: notesStats.files },
      sessions: { savedExists: existsSync(sessionsFile), messagesExists: existsSync(messagesDir) },
      appSettings: { exists: existsSync(settingsFile) },
    }
  }

  ipcMain.handle('cleanup:status', (): CleanupStatus => getStatus())

  ipcMain.handle('cleanup:removeMcp', () => {
    try {
      unregisterMcpServer()
      setDisabledIntegration('mcp', true)
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cleanup:removeHooks', () => {
    try {
      removeHooks()
      setDisabledIntegration('hooks', true)
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cleanup:removeStatusline', () => {
    try {
      try { unlinkSync(statuslineConfigPath) } catch { /* missing */ }
      try { unlinkSync(statuslineScriptPath) } catch { /* missing */ }
      try {
        const settings = readJsonSafe(claudeSettingsPath)
        if (settings && 'statusLine' in settings) {
          delete settings.statusLine
          writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
        }
      } catch { /* ignore */ }
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cleanup:removePlugin', () => {
    try {
      uninstallPlugin()
      try { rmSync(pluginDir, { recursive: true, force: true }) } catch { /* missing */ }
      setDisabledIntegration('plugin', true)
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cleanup:reinstallMcp', () => {
    try {
      setDisabledIntegration('mcp', false)
      reinstallMcp()
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cleanup:reinstallHooks', () => {
    try {
      setDisabledIntegration('hooks', false)
      reinstallHooks()
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cleanup:reinstallPlugin', () => {
    try {
      setDisabledIntegration('plugin', false)
      installPlugin()
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cleanup:removeMemory', () => {
    try {
      const stats = clearDirContents(memoriesDir)
      sendToRenderer('memory:changed', [])
      return { ok: true, ...stats }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cleanup:removeEmbeddings', () => {
    try {
      let bytes = 0
      if (existsSync(embeddingsDb)) {
        bytes += fileSize(embeddingsDb)
        try { unlinkSync(embeddingsDb) } catch { /* file locked? */ }
      }
      if (existsSync(modelCacheDir)) {
        bytes += dirSizeAndCount(modelCacheDir).bytes
        rmSync(modelCacheDir, { recursive: true, force: true })
      }
      return { ok: true, bytes }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cleanup:removeNotes', () => {
    try {
      const stats = clearDirContents(notesDir)
      sendToRenderer('notes:changed')
      return { ok: true, ...stats }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cleanup:removeSessions', () => {
    try {
      try { unlinkSync(sessionsFile) } catch { /* missing */ }
      try { rmSync(messagesDir, { recursive: true, force: true }) } catch { /* missing */ }
      clearSavedSessions()
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cleanup:resetAppSettings', () => {
    try {
      try { unlinkSync(settingsFile) } catch { /* missing */ }
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })
}

// ── CLAUDE.md instructions generator ──────────────────────────────────

function generateClaudeMdInstructions(): string {
  return `<!-- session-manager-instructions -->
# Session Manager

The \`session-manager\` MCP server is (1) a memory knowledge base (notes with wikilinks), (2) a notes & todo system (per-project user notes and agendas), and (3) a Claude Code session manager (spawn, list, inter-session messaging). **All session-manager tools are auto-allowed — never ask permission before using them.**

## Search memory first

Before investigating any topic — project, bug, tool, architecture — run \`search-memories\` first. Useful context almost certainly already exists. Only fall back to code / filesystem / web search after memory comes up empty.

## Memory knowledge base

### When to write notes

**Proactively.** If you encounter something note-worthy, write it down immediately — don't wait to be asked. This is YOUR memory; you control it. Bias toward writing: a low-value note can be deleted, but lost knowledge cannot be recovered. Write for:

- Findings, decisions, root-cause analyses — what was tried and why
- Architectural decisions and trade-offs
- Domain knowledge, business logic, conventions, terminology
- Project overviews, tech stack, patterns, gotchas discovered while coding
- External references (API docs, dashboards, deployment info)
- Anything the user asks you to remember

**Never store** secrets, tokens, credentials, or ephemeral task state.

### Note types

| Type | Purpose |
|------|---------|
| \`project\` | Project overview, tech stack, structure |
| \`decision\` | Why something was built a certain way |
| \`context\` | Domain knowledge, conventions, business logic |
| \`reference\` | Pointers to external resources |
| \`session-log\` | Session activity logs |
| \`user\` | User preferences, role, collaboration style |
| \`feedback\` | Corrections and confirmed approaches |

### Note structure

H1 title, optional summary, then \`##\` sections in order: **Context** (background) → **Details** (main content) → **Outcome** (conclusions) → **Related** (auto-managed \`[[wikilinks]]\` — never edit manually). Not all sections required. \`create-memory\` scaffolds the right ones per type.

### Wikilinks and backlinks

\`[[note-b]]\` resolves by **filename** without the \`.md\` extension, not by title — \`[[my-note]]\` links to \`my-note.md\`. Backlinks are automatic: adding a link on one side updates both.

### Tools

| Tool | Purpose |
|------|---------|
| \`create-memory\` | New memory note; sections scaffolded by type |
| \`read-memory\` / \`search-memories\` / \`list-memories\` | Read / full-text search / filter by tag or type |
| \`edit-memory\` | Edit one \`## Section\` (\`append\`, \`prepend\`, \`replace\`) |
| \`batch-section-edit\` | Multiple sections across multiple notes in one call |
| \`delete-memory\` | Refuses if referenced unless \`force=true\` |
| \`add-tags\` / \`remove-tags\` | Manage tags |
| \`repair-related\` | Rebuild \`## Related\` from a wikilink scan |

**Before creating a memory note: always \`search-memories\` first** and update an existing note rather than creating a duplicate.

## Todos (and notes - same thing)

**Distinct from memory.** Memory is YOUR long-term knowledge base. Todos are the USER's workspace - a single global todo list, shared between user and agents. Each todo has a title, markdown body, binary done/not-done status, and free-form tags. Never write memory content into todos, and don't turn todos into memory unless the user asks.

**Terminology:** the user may say "note", "todo", "task", "ticket", "card", "jot this down", "add to the list", "stick a pin in" - these all map to the same MCP tools (\`create-todo\` / \`list-todos\` / etc.). There is no separate notes system. A todo with a substantial body and no urgency is effectively a note; a todo with a one-line title and \`done: false\` is a task. The data model is the same.

### Project tags

Todos belong to projects via tags with the \`project:\` prefix (e.g. \`project:session-manager\`). The UI auto-applies the current session's project tag to new todos created from the UI. **When YOU create a todo from this session, also tag it with the current project** unless the user explicitly says it's cross-project or personal. Use \`list-tags\` to discover existing project tags so you match casing exactly.

Filter by \`tags: ["project:<name>"]\` to scope to a project. Multiple project tags OR together; non-project tags AND.

### When to create a todo

**On user request** - any of these phrasings means create one:
- "add a todo / task / note", "jot this down", "remind me to...", "we should..." (when it's clearly a deferred action), "stick this in the list", "create a note for X"
- Default: tag with the current project. If the user mentions a different project by name, tag with that one instead.

**Proactively, while working** - create a todo when YOU notice something worth tracking:
- A bug, edge case, or follow-up surfaced during implementation that's out of scope for the current task
- A decision the user made that should be captured for future sessions
- A piece of cleanup, refactor, or tech-debt you spotted but shouldn't action right now
- A blocker discovered while working (e.g. "needs X team to do Y first")
- A non-trivial finding from investigation that the user will want to act on later

Don't create a todo for ephemeral notes-to-self within the current turn, things that belong in the code (TODO/FIXME comments), or commit-message material.

### Avoiding duplicates

**Before creating a todo, search for an existing one** - use \`list-todos\` with \`search\` (hybrid substring + semantic match against title + body) or \`tags\`. If a near-duplicate exists:
- Same topic, still open -> \`update-todo\` to extend its body with the new context, don't create a new one
- Same topic, already closed -> ask the user whether to reopen (\`done: false\`) or whether this is a genuinely new occurrence

A useful heuristic: search for 1-2 distinctive keywords from the would-be title before writing anything new.

### Updating todos

- Marking done: \`update-todo\` with \`done: true\`. Don't \`delete-todo\` to close - closed todos are kept for history.
- Adding info you discovered: \`update-todo\` with an extended \`body\`. Read the current body first with \`read-todo\` so you don't lose context.
- Tags replace the whole set on \`update-todo\` - always read the current tags first if you're adding/removing rather than rewriting.

### Ambient awareness

On each user message, if the current project has open todos, a system-reminder appears with the count and delta. When that happens:

- Treat it as context, not a command - do NOT pivot away from what the user is actually asking about.
- If their current message relates to those todos, acknowledge them and call \`list-todos\` with \`tags=["project:<name>"], done=false\` for details.
- If unrelated, just continue the current conversation.

**Ambient nudge reminder (opt-in setting).** Separately, when the user has \`Nudge sessions about unfinished todos\` enabled, a different system-reminder may appear every ~8 turns when the count is stable. It tells you to add a soft closing line inviting the user to review todos. When you receive that reminder:

- Only act on it if you're at a natural stopping point in your current reply (a task complete, a question to the user, end of a unit of work). If the user is mid-flow on something unrelated, ignore it.
- Append a single soft closing line — never list todos unprompted, never pivot the response.
- If acting on it would feel forced or interrupt the user's flow, skip silently. The throttle assumes you'll skip sometimes.

### Tools

| Tool | Purpose |
|------|---------|
| \`list-todos\` | List todos; filter by tags, done state, or search (hybrid substring + semantic). project:* tags OR; non-project tags AND |
| \`read-todo\` | Fetch full todo including markdown body |
| \`create-todo\` | New todo (title, body?, tags?) |
| \`update-todo\` | Patch any of title / body / done / tags |
| \`delete-todo\` | Delete by id (use sparingly - prefer \`done: true\` to close) |
| \`list-tags\` | All tags in use with counts (autocomplete + project discovery) |

## Session management

### CRITICAL: use spawn-session / spawn-agent, NOT the built-in Agent tool

**When the user asks to spawn, spin up, kick off, launch, start, fire up, run, create, or send an agent or session — ALWAYS use \`spawn-agent\` or \`spawn-session\` (MCP), never the built-in \`Agent\` tool.** Same rule if they name an agent type ("research agent", "code review agent") or describe delegation to a separate Claude Code session.

The built-in \`Agent\` tool is an internal implementation detail — fine when YOU decide to parallelise your own work (codebase searches, etc.), but user-requested agents/sessions must be real sessions that appear in the graph, can receive messages, and persist.

### Spawning sessions

\`spawn-session\` creates a new Claude Code session with an initial prompt — appears in the graph, starts immediately. **Include full context** (no conversation history is inherited). **Never put your own session ID in the prompt** — it is appended automatically. Optional \`allowedTools\` restricts the child's tools (e.g., \`["Read", "Edit", "Bash"]\`).

\`reportBack\` controls what the child sends back:

| Value | Meaning | Pick when user says… |
|-------|---------|----------------------|
| \`"true"\` | Parent is waiting on results | "find out", "investigate", "what is", "check whether" |
| \`"done"\` | Parent wants a ping when finished, no details — child sends a short "\<task\> done." | "do X then let me know", "notify when done" |
| \`"optional"\` | Useful to know; parent isn't blocked | "go fix", "handle this", "take care of" |
| \`"false"\` | Fire-and-forget; output visible elsewhere (PR, file) | "just do it" |

When in doubt, default to \`"true"\` — an unnecessary report is low-cost; a missing one is frustrating.

### Other session tools

- \`spawn-agent\` — spawn a specialised agent. Run \`list-agents\` first to see what's available and their tool sets.
- \`list-sessions\` — all active sessions (IDs, project paths, status, terminal titles). Use before messaging.
- \`send-message\` — message another session. Delivered immediately if the target is idle, queued if busy. Child sessions can message their parent — the parent ID is available automatically.

## Agentic pipeline

The agentic pipeline turns a backlog todo into autonomous, multi-session work. Press **Cmd+L** to open the pipeline board (a kanban of \`Backlog → Plan → Implement → Review → Done\`); opened from the graph it shows all projects, opened from inside a session it filters to that session's project. Starting a backlog todo spawns an **orchestrator** session that reads the todo as the task brief and drives it through the stages — planning, implementing, then fanning out **reviewer** workers across the relevant dimensions (correctness, bugs, security if touched, architecture, tests, performance) and looping review⇄fix until the work passes. Each task runs in its own git **worktree** so parallel tasks never collide; isolated workers are merged back when they finish. Landing in \`Done\` marks the backing todo done. Pipeline sessions are real, resumable Claude sessions but are kept out of the graph view — manage them from the board and the per-task drawer (milestone feed + terminal).

**Autonomy** governs how far the orchestrator runs before pausing for you. Set the global default in Settings (⌘O → "Agentic pipeline"); override per-task with an \`autonomy:<level>\` tag on the todo. Levels:

- \`auto\` — runs end-to-end without stopping; gates auto-approve.
- \`gated\` (default) — pauses at stage gates for your approval, then continues.
- \`manual\` — you advance every stage yourself.

### Starting work into the pipeline

| Tool | Purpose |
|------|---------|
| \`pipeline-start\` | Launch a backlog todo into the pipeline — same as the board's "Start": creates the task with per-task worktree isolation and spawns the orchestrator. No-op-safe if the todo is already running |
| \`pipeline-start-review\` | Send EXISTING work (uncommitted edits or a committed branch) straight into the review⇄fix loop, skipping plan/implement. The diff comes from git (working tree or \`base...target\` range); the todo body is the review rubric |

### Orchestrator / worker tools

Tools an orchestrator or worker session uses to drive a task. The orchestrator is told its \`taskId\` in its spawn prompt; workers emit milestones against the same \`taskId\`. Children join the task tree via \`spawn-session\`'s pipeline params (\`pipelineTaskId\`, \`pipelineRole\`, \`pipelineLabel\`, \`fanoutKind\`, \`isolate\`/\`worktreeBranch\`, \`modelId\`).

| Tool | Purpose |
|------|---------|
| \`pipeline-get-task\` | Read a task's full state: stage, autonomy, pending gate, review round, and session tree. Call on resume to recover context |
| \`pipeline-set-stage\` | Move a task to a new stage (Plan→Implement→Review→Done). Orchestrator-only — how the board advances |
| \`pipeline-request-approval\` | Pause at a gate for user approval. Auto-approves under \`auto\` autonomy; sets a pending gate under \`gated\`/\`manual\` (stop and wait) |
| \`emit-milestone\` | Post a one-line milestone to your session's feed (plan ready, fanned out, verdict, blocked, done); drives the card line, badge, and status |
| \`pipeline-rename-session\` | Rename a node in your task tree (a child or yourself) to a descriptive board label, e.g. "Implement · CSV serializer" |
| \`pipeline-put-artifact\` / \`pipeline-get-artifact\` | Store/read a full stage hand-off (\`plan\`/\`diff\`/\`review\`) off the board, so downstream stages read large content cleanly instead of relaying it through chat or milestones |
| \`merge-worktree\` | Merge a finished isolated-worktree worker's branch into the integration branch, remove its worktree, and mark the node read-only; conflicts keep the worktree for a fix worker |
<!-- /session-manager-instructions -->
`
}

// ── Statusline script generator ───────────────────────────────────────

interface CustomComponentDef {
  id: string
  label: string
  description: string
  preview: string
  extract: string
  format: string
  guard?: string
  extractNode?: string  // JS expression for Windows (custom components)
}

interface ElementDef {
  extract: string      // bash lines to extract the value
  format: string       // bash expression that produces the display segment
  guard?: string       // condition to check before including (variable name)
}

const ELEMENT_DEFS: Record<string, ElementDef> = {
  model: {
    extract: 'MODEL=$(echo "$input" | jq -r \'.model.display_name // empty\')',
    format: '"[$MODEL]"',
    guard: 'MODEL',
  },
  rateLimit5h: {
    extract: 'RATE_5H=$(echo "$input" | jq -r \'.rate_limits.five_hour.used_percentage // empty\')',
    format: '"5h: $(printf \'%.0f\' "$RATE_5H")%"',
    guard: 'RATE_5H',
  },
  rateLimit7d: {
    extract: 'RATE_7D=$(echo "$input" | jq -r \'.rate_limits.seven_day.used_percentage // empty\')',
    format: '"7d: $(printf \'%.0f\' "$RATE_7D")%"',
    guard: 'RATE_7D',
  },
  resetTime5h: {
    extract: [
      'RESET_5H_TS=$(echo "$input" | jq -r \'.rate_limits.five_hour.resets_at // empty\')',
      'RESET_5H=""',
      'if [ -n "$RESET_5H_TS" ]; then',
      '  NOW=$(date +%s)',
      '  DIFF=$(( RESET_5H_TS - NOW ))',
      '  if [ "$DIFF" -gt 0 ]; then',
      '    HOURS=$(( DIFF / 3600 ))',
      '    MINS=$(( (DIFF % 3600) / 60 ))',
      '    if [ "$HOURS" -gt 0 ]; then',
      '      RESET_5H="${HOURS}h ${MINS}m"',
      '    else',
      '      RESET_5H="${MINS}m"',
      '    fi',
      '  fi',
      'fi',
    ].join('\n'),
    format: '"5h reset: $RESET_5H"',
    guard: 'RESET_5H',
  },
  resetTime7d: {
    extract: [
      'RESET_7D_TS=$(echo "$input" | jq -r \'.rate_limits.seven_day.resets_at // empty\')',
      'RESET_7D=""',
      'if [ -n "$RESET_7D_TS" ]; then',
      '  NOW=${NOW:-$(date +%s)}',
      '  DIFF=$(( RESET_7D_TS - NOW ))',
      '  if [ "$DIFF" -gt 0 ]; then',
      '    DAYS=$(( DIFF / 86400 ))',
      '    HOURS=$(( (DIFF % 86400) / 3600 ))',
      '    if [ "$DAYS" -gt 0 ]; then',
      '      RESET_7D="${DAYS}d ${HOURS}h"',
      '    else',
      '      RESET_7D="${HOURS}h"',
      '    fi',
      '  fi',
      'fi',
    ].join('\n'),
    format: '"7d reset: $RESET_7D"',
    guard: 'RESET_7D',
  },
  contextUsage: {
    extract: 'CTX=$(echo "$input" | jq -r \'.context_window.used_percentage // empty\')',
    format: '"ctx: $(printf \'%.0f\' "$CTX")%"',
    guard: 'CTX',
  },
  cost: {
    extract: 'COST=$(echo "$input" | jq -r \'.cost.total_cost_usd // empty\')',
    format: '"\\$$COST"',
    guard: 'COST',
  },
  gitBranch: {
    extract: 'BRANCH=$(echo "$input" | jq -r \'.workspace.git_branch // empty\')',
    format: '"⎇ $BRANCH"',
    guard: 'BRANCH',
  },
  linesChanged: {
    extract: [
      'ADDED=$(echo "$input" | jq -r \'.cost.total_lines_added // empty\')',
      'REMOVED=$(echo "$input" | jq -r \'.cost.total_lines_removed // empty\')',
      'LINES=""',
      '[ -n "$ADDED" ] && [ -n "$REMOVED" ] && LINES="+${ADDED} -${REMOVED}"',
    ].join('\n'),
    format: '"$LINES"',
    guard: 'LINES',
  },
  inputTokens: {
    extract: [
      'IN_TOK=$(echo "$input" | jq -r \'.context_window.total_input_tokens // empty\')',
      'IN_TOK_FMT=""',
      'if [ -n "$IN_TOK" ]; then',
      '  if [ "$IN_TOK" -ge 1000000 ]; then',
      '    IN_TOK_FMT="$(printf \'%.1fM\' "$(echo "$IN_TOK / 1000000" | bc -l)")"',
      '  elif [ "$IN_TOK" -ge 1000 ]; then',
      '    IN_TOK_FMT="$(printf \'%.1fk\' "$(echo "$IN_TOK / 1000" | bc -l)")"',
      '  else',
      '    IN_TOK_FMT="$IN_TOK"',
      '  fi',
      'fi',
    ].join('\n'),
    format: '"in: $IN_TOK_FMT"',
    guard: 'IN_TOK_FMT',
  },
  outputTokens: {
    extract: [
      'OUT_TOK=$(echo "$input" | jq -r \'.context_window.total_output_tokens // empty\')',
      'OUT_TOK_FMT=""',
      'if [ -n "$OUT_TOK" ]; then',
      '  if [ "$OUT_TOK" -ge 1000000 ]; then',
      '    OUT_TOK_FMT="$(printf \'%.1fM\' "$(echo "$OUT_TOK / 1000000" | bc -l)")"',
      '  elif [ "$OUT_TOK" -ge 1000 ]; then',
      '    OUT_TOK_FMT="$(printf \'%.1fk\' "$(echo "$OUT_TOK / 1000" | bc -l)")"',
      '  else',
      '    OUT_TOK_FMT="$OUT_TOK"',
      '  fi',
      'fi',
    ].join('\n'),
    format: '"out: $OUT_TOK_FMT"',
    guard: 'OUT_TOK_FMT',
  },
  totalTokens: {
    extract: [
      'T_IN=$(echo "$input" | jq -r \'.context_window.total_input_tokens // 0\')',
      'T_OUT=$(echo "$input" | jq -r \'.context_window.total_output_tokens // 0\')',
      'TOTAL_TOK=$(( T_IN + T_OUT ))',
      'TOTAL_TOK_FMT=""',
      'if [ "$TOTAL_TOK" -gt 0 ]; then',
      '  if [ "$TOTAL_TOK" -ge 1000000 ]; then',
      '    TOTAL_TOK_FMT="$(printf \'%.1fM\' "$(echo "$TOTAL_TOK / 1000000" | bc -l)")"',
      '  elif [ "$TOTAL_TOK" -ge 1000 ]; then',
      '    TOTAL_TOK_FMT="$(printf \'%.1fk\' "$(echo "$TOTAL_TOK / 1000" | bc -l)")"',
      '  else',
      '    TOTAL_TOK_FMT="$TOTAL_TOK"',
      '  fi',
      'fi',
    ].join('\n'),
    format: '"tok: $TOTAL_TOK_FMT"',
    guard: 'TOTAL_TOK_FMT',
  },
  cacheReadTokens: {
    extract: [
      'CACHE_R=$(echo "$input" | jq -r \'.context_window.current_usage.cache_read_input_tokens // empty\')',
      'CACHE_R_FMT=""',
      'if [ -n "$CACHE_R" ] && [ "$CACHE_R" -gt 0 ]; then',
      '  if [ "$CACHE_R" -ge 1000000 ]; then',
      '    CACHE_R_FMT="$(printf \'%.1fM\' "$(echo "$CACHE_R / 1000000" | bc -l)")"',
      '  elif [ "$CACHE_R" -ge 1000 ]; then',
      '    CACHE_R_FMT="$(printf \'%.1fk\' "$(echo "$CACHE_R / 1000" | bc -l)")"',
      '  else',
      '    CACHE_R_FMT="$CACHE_R"',
      '  fi',
      'fi',
    ].join('\n'),
    format: '"cache: $CACHE_R_FMT"',
    guard: 'CACHE_R_FMT',
  },
  contextBar: {
    extract: [
      'CTX_BAR_PCT=$(echo "$input" | jq -r \'.context_window.used_percentage // empty\')',
      'CTX_BAR=""',
      'if [ -n "$CTX_BAR_PCT" ]; then',
      '  FILLED=$(printf \'%.0f\' "$(echo "$CTX_BAR_PCT / 10" | bc -l)")',
      '  BAR=""',
      '  for i in $(seq 1 10); do',
      '    if [ "$i" -le "$FILLED" ]; then BAR="${BAR}█"; else BAR="${BAR}░"; fi',
      '  done',
      '  CTX_BAR="ctx $BAR $(printf \'%.0f\' "$CTX_BAR_PCT")%"',
      'fi',
    ].join('\n'),
    format: '"$CTX_BAR"',
    guard: 'CTX_BAR',
  },
  rateLimitBar5h: {
    extract: [
      'RLB_5H=$(echo "$input" | jq -r \'.rate_limits.five_hour.used_percentage // empty\')',
      'RLB_5H_FMT=""',
      'if [ -n "$RLB_5H" ] && [ "$(echo "$RLB_5H > 0" | bc)" -eq 1 ]; then',
      '  FILLED_5H=$(printf \'%.0f\' "$(echo "$RLB_5H / 10" | bc -l)")',
      '  BAR_5H=""',
      '  for i in $(seq 1 10); do',
      '    if [ "$i" -le "$FILLED_5H" ]; then BAR_5H="${BAR_5H}█"; else BAR_5H="${BAR_5H}░"; fi',
      '  done',
      '  RLB_5H_FMT="5h $BAR_5H $(printf \'%.0f\' "$RLB_5H")%"',
      'fi',
    ].join('\n'),
    format: '"$RLB_5H_FMT"',
    guard: 'RLB_5H_FMT',
  },
  rateLimitBar7d: {
    extract: [
      'RLB_7D=$(echo "$input" | jq -r \'.rate_limits.seven_day.used_percentage // empty\')',
      'RLB_7D_FMT=""',
      'if [ -n "$RLB_7D" ] && [ "$(echo "$RLB_7D > 0" | bc)" -eq 1 ]; then',
      '  FILLED_7D=$(printf \'%.0f\' "$(echo "$RLB_7D / 10" | bc -l)")',
      '  BAR_7D=""',
      '  for i in $(seq 1 10); do',
      '    if [ "$i" -le "$FILLED_7D" ]; then BAR_7D="${BAR_7D}█"; else BAR_7D="${BAR_7D}░"; fi',
      '  done',
      '  RLB_7D_FMT="7d $BAR_7D $(printf \'%.0f\' "$RLB_7D")%"',
      'fi',
    ].join('\n'),
    format: '"$RLB_7D_FMT"',
    guard: 'RLB_7D_FMT',
  },
}

function generateStatuslineScript(elements: string[], customComponents?: CustomComponentDef[]): string {
  const extracts: string[] = []
  const segments: string[] = []

  // Build a lookup for custom components
  const customMap = new Map<string, CustomComponentDef>()
  for (const c of customComponents || []) {
    customMap.set(c.id, c)
  }

  for (const id of elements) {
    // Check built-in elements first, then custom components
    const builtIn = ELEMENT_DEFS[id]
    if (builtIn) {
      extracts.push(builtIn.extract)
      if (builtIn.guard) {
        segments.push(`[ -n "$${builtIn.guard}" ] && PARTS+=("$(echo -n ${builtIn.format})")`)
      } else {
        segments.push(`PARTS+=("$(echo -n ${builtIn.format})")`)
      }
      continue
    }

    const custom = customMap.get(id)
    if (custom) {
      extracts.push(custom.extract)
      if (custom.guard) {
        segments.push(`[ -n "$${custom.guard}" ] && PARTS+=("$(echo -n ${custom.format})")`)
      } else {
        segments.push(`PARTS+=("$(echo -n ${custom.format})")`)
      }
    }
  }

  return [
    '#!/bin/bash',
    '# Auto-generated by session-manager statusline editor',
    '# Edit via Settings > Statusline — manual changes will be overwritten',
    'input=$(cat)',
    '',
    ...extracts,
    '',
    'PARTS=()',
    ...segments,
    '',
    '# Join parts with separator',
    'OUTPUT=""',
    'for p in "${PARTS[@]}"; do',
    '  [ -z "$p" ] && continue',
    '  [ -n "$OUTPUT" ] && OUTPUT="$OUTPUT | "',
    '  OUTPUT="$OUTPUT$p"',
    'done',
    '',
    'echo "$OUTPUT"',
    '',
  ].join('\n')
}

// ── Node.js statusline generator (Windows) ────────────────────────────

interface NodeElementDef {
  extract: string   // JS code that returns the formatted string (or empty string to skip)
}

const NODE_ELEMENT_DEFS: Record<string, NodeElementDef> = {
  model: {
    extract: `d.model?.display_name ? \`[\${d.model.display_name}]\` : ''`,
  },
  rateLimit5h: {
    extract: `d.rate_limits?.five_hour?.used_percentage != null ? \`5h: \${Math.round(d.rate_limits.five_hour.used_percentage)}%\` : ''`,
  },
  rateLimit7d: {
    extract: `d.rate_limits?.seven_day?.used_percentage != null ? \`7d: \${Math.round(d.rate_limits.seven_day.used_percentage)}%\` : ''`,
  },
  resetTime5h: {
    extract: [
      `(() => {`,
      `  const ts = d.rate_limits?.five_hour?.resets_at;`,
      `  if (!ts) return '';`,
      `  const diff = ts - Math.floor(Date.now() / 1000);`,
      `  if (diff <= 0) return '';`,
      `  const h = Math.floor(diff / 3600), m = Math.floor((diff % 3600) / 60);`,
      `  return h > 0 ? \`5h reset: \${h}h \${m}m\` : \`5h reset: \${m}m\`;`,
      `})()`,
    ].join('\n'),
  },
  resetTime7d: {
    extract: [
      `(() => {`,
      `  const ts = d.rate_limits?.seven_day?.resets_at;`,
      `  if (!ts) return '';`,
      `  const diff = ts - Math.floor(Date.now() / 1000);`,
      `  if (diff <= 0) return '';`,
      `  const days = Math.floor(diff / 86400), h = Math.floor((diff % 86400) / 3600);`,
      `  return days > 0 ? \`7d reset: \${days}d \${h}h\` : \`7d reset: \${h}h\`;`,
      `})()`,
    ].join('\n'),
  },
  contextUsage: {
    extract: `d.context_window?.used_percentage != null ? \`ctx: \${Math.round(d.context_window.used_percentage)}%\` : ''`,
  },
  cost: {
    extract: `d.cost?.total_cost_usd != null ? \`$\${d.cost.total_cost_usd}\` : ''`,
  },
  gitBranch: {
    extract: `d.workspace?.git_branch ? \`⎇ \${d.workspace.git_branch}\` : ''`,
  },
  linesChanged: {
    extract: `(d.cost?.total_lines_added != null && d.cost?.total_lines_removed != null) ? \`+\${d.cost.total_lines_added} -\${d.cost.total_lines_removed}\` : ''`,
  },
  inputTokens: {
    extract: `((t) => t == null ? '' : \`in: \${t >= 1e6 ? (t/1e6).toFixed(1)+'M' : t >= 1e3 ? (t/1e3).toFixed(1)+'k' : t}\`)(d.context_window?.total_input_tokens)`,
  },
  outputTokens: {
    extract: `((t) => t == null ? '' : \`out: \${t >= 1e6 ? (t/1e6).toFixed(1)+'M' : t >= 1e3 ? (t/1e3).toFixed(1)+'k' : t}\`)(d.context_window?.total_output_tokens)`,
  },
  totalTokens: {
    extract: [
      `(() => {`,
      `  const i = d.context_window?.total_input_tokens || 0, o = d.context_window?.total_output_tokens || 0;`,
      `  const t = i + o;`,
      `  if (t === 0) return '';`,
      `  return \`tok: \${t >= 1e6 ? (t/1e6).toFixed(1)+'M' : t >= 1e3 ? (t/1e3).toFixed(1)+'k' : t}\`;`,
      `})()`,
    ].join('\n'),
  },
  cacheReadTokens: {
    extract: `((t) => !t || t === 0 ? '' : \`cache: \${t >= 1e6 ? (t/1e6).toFixed(1)+'M' : t >= 1e3 ? (t/1e3).toFixed(1)+'k' : t}\`)(d.context_window?.current_usage?.cache_read_input_tokens)`,
  },
  contextBar: {
    extract: [
      `(() => {`,
      `  const p = d.context_window?.used_percentage;`,
      `  if (p == null) return '';`,
      `  const filled = Math.round(p / 10);`,
      `  return \`ctx \${'█'.repeat(filled)}\${'░'.repeat(10 - filled)} \${Math.round(p)}%\`;`,
      `})()`,
    ].join('\n'),
  },
  rateLimitBar5h: {
    extract: [
      `(() => {`,
      `  const p = d.rate_limits?.five_hour?.used_percentage;`,
      `  if (p == null || p <= 0) return '';`,
      `  const filled = Math.round(p / 10);`,
      `  return \`5h \${'█'.repeat(filled)}\${'░'.repeat(10 - filled)} \${Math.round(p)}%\`;`,
      `})()`,
    ].join('\n'),
  },
  rateLimitBar7d: {
    extract: [
      `(() => {`,
      `  const p = d.rate_limits?.seven_day?.used_percentage;`,
      `  if (p == null || p <= 0) return '';`,
      `  const filled = Math.round(p / 10);`,
      `  return \`7d \${'█'.repeat(filled)}\${'░'.repeat(10 - filled)} \${Math.round(p)}%\`;`,
      `})()`,
    ].join('\n'),
  },
}

function generateStatuslineScriptNode(elements: string[], customComponents?: CustomComponentDef[]): string {
  const customMap = new Map<string, CustomComponentDef>()
  for (const c of customComponents || []) {
    customMap.set(c.id, c)
  }

  const extractors: string[] = []
  for (const id of elements) {
    const builtIn = NODE_ELEMENT_DEFS[id]
    if (builtIn) {
      extractors.push(`  parts.push(${builtIn.extract});`)
      continue
    }
    // Custom components on Windows use JS extract/format (not bash)
    const custom = customMap.get(id)
    if (custom?.extractNode) {
      extractors.push(`  parts.push(${custom.extractNode});`)
    }
  }

  return [
    '#!/usr/bin/env node',
    '// Auto-generated by session-manager statusline editor',
    '// Edit via Settings > Statusline — manual changes will be overwritten',
    '',
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => input += chunk);',
    'process.stdin.on("end", () => {',
    '  try {',
    '    const d = JSON.parse(input);',
    '    const parts = [];',
    ...extractors,
    '    process.stdout.write(parts.filter(Boolean).join(" | "));',
    '  } catch {',
    '    process.stdout.write("");',
    '  }',
    '});',
    '',
  ].join('\n')
}
