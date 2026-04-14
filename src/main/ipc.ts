import { ipcMain, BrowserWindow, app } from 'electron'
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'fs'
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
  TITLE_INDICATOR_RE
} from './pty-manager'
import { readDirectory, readFile, getHomeDir, isDirectory, installSkillCommand, uninstallSkillCommand, cleanupAllSkillCommands } from './fs-service'
import { onPtyData as hookOnPtyData, setAttachListeners, cleanupSession as hookCleanupSession } from './hook-server'
import { loadSavedSessions, clearSavedSessions, type SavedSession } from './session-store'
import { loadSettings, saveSettings, type AppSettings } from './settings-store'
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

  // Capture early PTY output for debugging quick exits
  let earlyOutput = ''
  const earlyCapture = session.process.onData((chunk) => {
    if (earlyOutput.length < 2000) earlyOutput += chunk
  })
  setTimeout(() => earlyCapture.dispose(), 5000)

  session.process.onExit(({ exitCode }) => {
    attachedSessions.delete(id)
    const clean = earlyOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    if (exitCode !== 0) {
      console.log(`[pty] session ${id} exited with code ${exitCode}:`, clean.slice(0, 300))
    }
    setTimeout(() => {
      sendToRenderer('pty:exit', { id, exitCode, error: exitCode !== 0 ? clean.slice(0, 300) : undefined })
    }, 200)
  })
}

export function registerIpcHandlers(): void {
  // Register the attach-listeners callback for hook-server spawned sessions
  setAttachListeners((id, session) => attachSessionListeners(id, session))

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
        attachSessionListeners(id, session)
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
      attachSessionListeners(id, session)
      return { id, projectPath }
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
      const fn = filename || slugify(title)

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

  // Claude Code settings — read/write ~/.claude/settings.json
  const claudeSettingsPath = join(app.getPath('home'), '.claude', 'settings.json')

  // ── Statusline configuration ──────────────────────────────────────────
  const statuslineConfigPath = join(app.getPath('home'), '.claude', 'statusline-config.json')
  const statuslineScriptPath = join(app.getPath('home'), '.claude', 'statusline-command.sh')

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

      // Generate and write bash script
      const script = generateStatuslineScript(elements, config.customComponents)
      writeFileSync(statuslineScriptPath, script, 'utf-8')
      chmodSync(statuslineScriptPath, 0o755)

      // Ensure ~/.claude/settings.json points to the script
      let settings: Record<string, unknown> = {}
      try {
        settings = JSON.parse(readFileSync(claudeSettingsPath, 'utf-8'))
      } catch { /* file doesn't exist */ }
      settings.statusLine = { type: 'command', command: `bash ${statuslineScriptPath}` }
      writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')

      return true
    } catch {
      return false
    }
  })
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
