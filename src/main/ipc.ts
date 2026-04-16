import { ipcMain, BrowserWindow, app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'fs'
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
  TITLE_INDICATOR_RE,
  isDefaultTitle
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

  session.process.onExit(({ exitCode }) => {
    attachedSessions.delete(id)
    setTimeout(() => {
      sendToRenderer('pty:exit', { id, exitCode })
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
}

// ── CLAUDE.md instructions generator ──────────────────────────────────

function generateClaudeMdInstructions(): string {
  return `<!-- session-manager-instructions -->
# Session Manager

The \`session-manager\` MCP server provides a memory knowledge base for storing and retrieving notes, context, and knowledge. It also manages Claude Code sessions — spawning, listing, and inter-session messaging. **Session-manager tools are auto-allowed — do not ask the user for permission before creating, reading, or editing notes. Just do it.**

## Search Memory First

**Before investigating ANY topic** — whether it's a project, a bug, a tool, an architecture question, or anything else — **always search memory notes first**.

### Investigation order (mandatory)

1. **Search session-manager notes** (\`search-notes\`) — by filename and content
2. **Only then** fall back to code exploration, file searches, web searches, or filesystem browsing

Do NOT skip to step 2. Assume useful context already exists in memory. This applies to every task, not just memory-related ones.

## Memory Knowledge Base

### When to create memories

**Proactively** create or update notes throughout every session. Do NOT wait for the user to ask — if you encounter something note-worthy, write it down immediately. This is YOUR memory, not the user's — you control it. Create your own memories when you feel it is appropriate. Do NOT ask permission, it is already auto-allowed. Create notes for:

- **Findings and decisions**: Any decision made during a session, investigation results, root cause analyses, what was tried and why
- **Cross-project knowledge**: Relationships, shared patterns, or dependencies between projects
- **Architectural decisions**: Why something was built a certain way, trade-offs considered
- **Domain knowledge**: Business logic, terminology, workflows
- **Project context**: High-level summaries, key patterns, tech stack details
- **Useful references**: External resources, API docs, deployment info
- **Implementation details**: Notable patterns, gotchas, or workarounds discovered while working on code
- **Anything the user asks you to remember**

**Bias toward writing notes.** When in doubt, create the note. A note that turns out to be low-value can be deleted later; knowledge lost because you didn't write it down cannot be recovered.

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

Every note has: H1 title, optional summary paragraph, then \`## sections\` in this order:
- **## Context** — Background, motivation, constraints
- **## Details** — Main content (free-form markdown)
- **## Outcome** — Conclusions, decisions, results
- **## Related** — Auto-managed \`[[wikilinks]]\` (do NOT edit manually)

Not all sections are required. Use \`create-note\` with the appropriate type and it will scaffold the right sections.

### Tools reference

| Tool | Purpose |
|------|---------|
| \`create-note\` | Create a new note. Sections auto-generated based on type |
| \`read-note\` | Read a note by filename |
| \`edit-note\` | Edit a single \`## Section\` of a note (\`append\`, \`prepend\`, \`replace\`) |
| \`batch-section-edit\` | Edit multiple sections across multiple notes in one call |
| \`search-notes\` | Search notes by content, filename, or both |
| \`list-notes\` | List all notes, optionally filtered by tag or type |
| \`delete-note\` | Delete a note (refuses if referenced unless \`force=true\`) |
| \`add-tags\` / \`remove-tags\` | Manage note tags |
| \`repair-related\` | Rebuild \`## Related\` section from wikilink scan |

### Before creating a note

- **Always search first** (\`search-notes\`) to check if a note on the same topic already exists
- **Update the existing note** rather than creating a duplicate

### Back-links are automatic

When you add \`[[note-b]]\` to a note, the MCP server automatically adds the reverse link. No need to manually update both sides. Wikilinks are resolved by **filename** (without the \`.md\` extension), not by note title — e.g. \`[[my-note]]\` links to \`my-note.md\`.

### Do NOT store

- Secrets, tokens, or credentials
- Ephemeral debugging context or temporary task state

## Session Management

### CRITICAL: spawn-agent / spawn-session vs built-in Agent tool

**When the user asks you to spawn, spin up, kick off, launch, start, or create an agent or session, ALWAYS use the session-manager MCP tools (\`spawn-agent\` or \`spawn-session\`), NOT the built-in \`Agent\` subagent tool.**

Trigger phrases that MUST use session-manager MCP tools:
- "spin up a/an ... agent/session"
- "spawn a/an ... agent/session"
- "kick off a/an ... agent/session"
- "launch a/an ... agent/session"
- "start a/an ... agent/session"
- "create a/an ... agent/session"
- "run a/an ... agent/session"
- Any reference to a named agent type (e.g., "research agent", "code review agent")
- Any request involving delegation to a separate Claude Code session

**Decision rule:**

| Scenario | Tool to use |
|----------|-------------|
| User asks to spawn/spin up/launch an agent or session | \`spawn-agent\` or \`spawn-session\` (MCP) |
| User references a named agent type (research, review, etc.) | \`list-agents\` then \`spawn-agent\` (MCP) |
| User wants work done in a separate terminal/session | \`spawn-session\` (MCP) |
| User wants to delegate work that reports back | \`spawn-session\` (MCP) |
| You autonomously decide to parallelise internal subtasks (no user request to "spawn" anything) | Built-in \`Agent\` tool is acceptable |
| Simple codebase search/exploration as part of your own workflow | Built-in \`Agent\` tool is acceptable |

**The built-in \`Agent\` tool is an internal implementation detail for your own workflow.** When the user explicitly asks for an agent or session, they mean a real Claude Code session managed by session-manager — one that appears in the graph view, can receive messages, and persists independently.

### Spawning sessions

Use \`spawn-session\` to create a new Claude Code session with an initial prompt. The session appears in the graph view and starts working immediately.

- **Include full context** — the new session has no conversation history
- **Never include your own session ID** in the prompt — it is appended automatically
- \`reportBack\` controls whether the child reports findings to the parent. **Choose intelligently based on the task:**

  | Value | When to use | Examples |
  |-------|-------------|---------|
  | \`"true"\` | Parent is **waiting on results** to continue its own work | Research questions, investigations, lookups, audits |
  | \`"done"\` | Parent wants to **know when it finishes** but doesn't need details — child sends a short "\<task\> done." message (e.g. "Schema migration done.") | Build tasks, migrations, "do X then let me know" |
  | \`"optional"\` | The work is **useful to know about** but the parent isn't blocked | Background refactors, routine cleanup, "fix this if you can" |
  | \`"false"\` | The task is **fully self-contained** — fire and forget | Autonomous maintenance, independent feature work the user will review via PR |

  **Heuristics:**
  - If the user says "find out", "investigate", "what is", "check whether" → \`"true"\` (they want an answer)
  - If the user says "do X then let me know", "notify when done" → \`"done"\` (they want a ping, not a report)
  - If the user says "go fix", "handle this", "take care of" → \`"optional"\` (they want it done, report only if interesting)
  - If the user says "just do it", or the task has its own visible output (PR, commit, file) → \`"false"\`
  - When in doubt, default to \`"true"\` — an unnecessary report is low-cost, a missing one is frustrating

- Optionally restrict tools with \`allowedTools\` (e.g., \`["Read", "Write", "Edit", "Bash"]\`)

### Spawning agents

Use \`list-agents\` to see available specialised agents, then \`spawn-agent\` to spawn one. Agents have predefined tool sets and system prompts tailored to their specialisation.

### Listing sessions

Use \`list-sessions\` to see all active Claude Code sessions — their IDs, project paths, status, and terminal titles. Use this to discover sessions for messaging.

### Inter-session messaging

Sessions can communicate with each other via \`send-message\`:

- If the target session is **idle**, the message is delivered immediately as a new prompt
- If the target session is **busy**, the message is queued and delivered when it finishes its current task
- **Child sessions can message their parent** for additional context if needed — the parent session ID is automatically available
- Use this for coordination: reporting results back, requesting clarification, or passing discovered context between related sessions
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
