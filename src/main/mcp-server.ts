/**
 * Standalone MCP server for memory notes.
 * Runs as a child process with stdio transport.
 * Claude Code sessions discover it via ~/.claude/.mcp.json.
 *
 * Imports shared logic from memory/core.ts and memory/note-io.ts
 * instead of duplicating it.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import {
  NOTE_TYPES,
  TYPE_SECTIONS,
  slugify,
  generateNote,
  touchModified,
  appendToSection,
  replaceSectionContent,
  prependToSection,
  filenameToWikilink,
  addToRelatedSection,
  type MemoryNote,
} from './memory/core'
import { createNoteIO, type NoteIO } from './memory/note-io'

// ─── Storage ───────────────────────────────────────────────────────────────

const MEMORIES_DIR = process.env.SM_MEMORIES_DIR || path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  process.platform === 'darwin'
    ? 'Library/Application Support/session-manager/memories'
    : '.config/session-manager/memories'
)

const io: NoteIO = createNoteIO(MEMORIES_DIR)

function today(): string {
  return new Date().toISOString().split('T')[0]
}

const noteTypeEnum = z.enum(NOTE_TYPES)

// ─── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'session-manager', version: '0.1.0' },
  {
    instructions: `Memory knowledge base for session-manager. Notes are markdown files with YAML frontmatter and [[wikilink]] relationships.

## When to create memories

**Proactively** create or update notes throughout every session. Do not wait to be asked — if you encounter something note-worthy, write it down immediately. Create notes for:

- **Findings and decisions**: Any decision made during a session, investigation results, root cause analyses, what was tried and why
- **Project context**: High-level summaries, key patterns, tech stack details, architecture
- **Domain knowledge**: Business logic, terminology, workflows, conventions
- **User preferences**: Role, collaboration style, corrections, confirmed approaches
- **Useful references**: External resources, API docs, deployment info, tool configurations
- **Implementation details**: Notable patterns, gotchas, or workarounds discovered while coding

**Bias toward writing notes.** A note that turns out to be low-value can be deleted later; knowledge lost because you didn't write it down cannot be recovered.

## Before creating a note

Always search first (search-notes or list-notes) to check if a note on the same topic already exists. **Update the existing note** rather than creating a duplicate.

## Note structure

Every note has: H1 title, optional summary paragraph, then ## sections in this order:
- **## Context** — Background, motivation, constraints
- **## Details** — Main content (free-form markdown)
- **## Outcome** — Conclusions, decisions, results
- **## Related** — Auto-managed [[wikilinks]] (do NOT edit manually)

Not all sections are required. Each note type has recommended sections.

## Note types

| Type | Purpose | Recommended sections |
|------|---------|---------------------|
| project | Project overview, tech stack, structure | Context, Details |
| decision | Why something was built a certain way | Context, Details, Outcome |
| context | Domain knowledge, conventions, business logic | Details |
| reference | Pointers to external resources | Details |
| session-log | What happened in a session | Context, Outcome |
| user | User preferences, role, collaboration style | Details |
| feedback | Corrections/confirmations about approach | Context, Details |

## Tools

| Tool | Purpose |
|------|---------|
| create-note | Create a note with structured sections (type, context, details, outcome) |
| read-note | Read a note by filename |
| edit-note | Edit a single section (append/prepend/replace) |
| batch-section-edit | Edit multiple sections across multiple notes in one call |
| search-notes | Search by content, filename, or both |
| list-notes | List all notes, optionally filtered by tag/type |
| delete-note | Delete a note (cleans up backlinks automatically) |
| add-tags / remove-tags | Manage tags on notes |
| repair-related | Rebuild ## Related from actual wikilinks (for fixing broken backlinks) |
| spawn-session | Spawn a new Claude Code session with an initial prompt (visible in session manager) |
| spawn-agent | Spawn a specialised agent (researcher, debugger, etc.) in a new session with a task |
| list-agents | List available specialised agents and their capabilities |
| list-sessions | List all active sessions with IDs, status, and project paths |
| send-message | Send a message to another session (delivered when idle, queued when busy) |

Use **create-note** with structured section inputs (context, details, outcome) instead of raw markdown.
Use **batch-section-edit** to edit multiple sections across multiple notes in one call.
Use **edit-note** for simple single-section edits.

## Linking

Use [[wikilinks]] in note content to connect related notes. Backlinks in ## Related are fully automatic — never edit them manually.

## Keyword routing — IMPORTANT

When the user says any of the following, ALWAYS use the session-manager MCP tools listed here — NEVER the built-in Claude Code Agent tool or native subagents:

| User says | Use this tool |
|-----------|---------------|
| "spawn", "spin up", "start a session", "new session", "kick off", "delegate to a session" | **spawn-session** |
| "spawn agent", "run agent", "use the [name] agent", "send to [agent]", "have [agent] look at", "get [agent] to" | **spawn-agent** |
| "message", "tell session", "send to session", "notify session", "ping session" | **send-message** |
| "what's running", "active sessions", "show sessions" | **list-sessions** |
| "what agents", "available agents", "which agents" | **list-agents** |

**Why:** The session manager tracks sessions in a graph view. MCP-spawned sessions are visible, manageable, and can message each other. Built-in Agent subagents are invisible and ephemeral. The user expects "spawn" and "agent" to create tracked sessions, not throwaway subprocesses.

**Exception:** The built-in Agent tool is still appropriate for quick internal searches/exploration (e.g. codebase grep, file lookups) that don't need to be tracked.

## Session management

Use **spawn-session** to delegate work to a new Claude Code session. The new session:
- Appears in the session manager graph view immediately
- Starts working on the prompt automatically
- Runs in the specified project directory (defaults to cwd)
- Can be monitored and interacted with by the user
- **Automatically receives the parent session ID and tool names** — the child session knows how to message back without you needing to include that in the prompt

Include full context in the prompt — the new session has no conversation history. Be specific about what to implement, which files to modify, and any constraints. NEVER include your own session ID in the prompt — the parent ID and send-message instructions are injected automatically, and your session ID may become stale. You CAN tell the child to "send results back to the parent" or "report back when done" — just don't specify the target session ID.

Use **list-sessions** to discover all active sessions and their IDs/status.

Use **spawn-agent** to spin up a specialised agent (e.g. researcher, debugger, code-reviewer). The agent:
- Has a predefined system prompt and restricted tool set optimised for its role
- Receives the task prompt after its system prompt is loaded
- Has send-message auto-allowed so it can report back without permission prompts
- Use **list-agents** to see what's available

Use **send-message** to communicate with another session. Messages are:
- Delivered immediately if the target is idle (at the prompt)
- Queued and auto-delivered when the target finishes its current task
- Prefixed with the sender's session ID so the recipient knows who sent it

All spawned sessions (spawn-session and spawn-agent) automatically have send-message allowed so they can report back without permission prompts.

Notes stored in: ${MEMORIES_DIR}`
  }
)

// ── create-note ─────────────────────────────────────────────────────────────

server.tool(
  'create-note',
  'Create a new memory note with structured sections. Sections are auto-generated based on note type. Backlinks synced automatically.',
  {
    title: z.string().describe('Note title'),
    filename: z.string().optional().describe('Filename (auto-generated from title if omitted)'),
    type: noteTypeEnum.optional().describe('Note type (default: context)'),
    tags: z.array(z.string()).optional().describe('Freeform tags'),
    summary: z.string().optional().describe('1-2 sentence summary (appears after H1, before sections)'),
    context: z.string().optional().describe('Content for ## Context section'),
    details: z.string().optional().describe('Content for ## Details section'),
    outcome: z.string().optional().describe('Content for ## Outcome section'),
  },
  async ({ title, filename, type, tags, summary, context, details, outcome }) => {
    const fn = filename || slugify(title)

    if (io.readNote(fn)) {
      return { content: [{ type: 'text', text: `Error: Note "${fn}" already exists` }], isError: true }
    }

    const rawBody = generateNote({ title, type: type || undefined, tags, summary, context, details, outcome })
    io.writeNote(fn, rawBody)
    let note = io.readNote(fn)!

    io.syncBacklinks(fn, [], note.wikilinks)

    const inbound = io.getInboundLinks(fn)
    if (inbound.length > 0) {
      let updatedRaw = note.rawBody
      for (const refFn of inbound) {
        updatedRaw = addToRelatedSection(updatedRaw, filenameToWikilink(refFn))
      }
      if (updatedRaw !== note.rawBody) {
        io.writeNote(fn, updatedRaw)
        note = io.readNote(fn)!
      }
    }

    return { content: [{ type: 'text', text: `Created "${fn}" [${note.type || 'context'}] (${note.wikilinks.length} outbound, ${inbound.length} inbound links synced)` }] }
  }
)

// ── read-note ───────────────────────────────────────────────────────────────

server.tool(
  'read-note',
  'Read a memory note by filename.',
  { filename: z.string().describe('Note filename (e.g. "my-note.md")') },
  async ({ filename }) => {
    const note = io.readNote(filename)
    if (!note) {
      return { content: [{ type: 'text', text: `Error: Note "${filename}" not found` }], isError: true }
    }
    return { content: [{ type: 'text', text: note.rawBody }] }
  }
)

// ── edit-note ───────────────────────────────────────────────────────────────

server.tool(
  'edit-note',
  'Edit a single section of a memory note. New sections are inserted in canonical order (Context → Details → Outcome). Cannot edit ## Related (use repair-related for fixes). Backlinks synced automatically.',
  {
    filename: z.string().describe('Note filename'),
    heading: z.string().describe('Target ## section name (e.g. "Context", "Details", "Outcome"). Cannot be "Related".'),
    operation: z.enum(['append', 'prepend', 'replace']).describe('Edit operation'),
    content: z.string().describe('Content to add/replace'),
  },
  async ({ filename, heading, operation, content }) => {
    const note = io.readNote(filename)
    if (!note) {
      return { content: [{ type: 'text', text: `Error: Note "${filename}" not found` }], isError: true }
    }

    if (heading === 'Related') {
      return { content: [{ type: 'text', text: 'Error: ## Related is auto-managed. Use [[wikilinks]] in other sections.' }], isError: true }
    }

    const oldWikilinks = note.wikilinks
    let rawBody: string

    if (operation === 'replace') rawBody = replaceSectionContent(note.rawBody, heading, content)
    else if (operation === 'append') rawBody = appendToSection(note.rawBody, heading, content)
    else rawBody = prependToSection(note.rawBody, heading, content)

    rawBody = touchModified(rawBody)

    io.writeNote(filename, rawBody)
    const updated = io.readNote(filename)!
    io.syncBacklinks(filename, oldWikilinks, updated.wikilinks)

    return { content: [{ type: 'text', text: `Updated "${filename}" (${operation} in ## ${heading})` }] }
  }
)

// ── batch-section-edit ──────────────────────────────────────────────────────

server.tool(
  'batch-section-edit',
  'Edit multiple sections across multiple notes in one call. Each edit targets a specific ## section with append/prepend/replace. Sections are inserted in canonical order if missing. Cannot edit ## Related (use repair-related for fixes). Backlinks synced automatically.',
  {
    edits: z.array(z.object({
      filename: z.string().describe('Note filename'),
      heading: z.string().describe('Target ## section name. Cannot be "Related".'),
      operation: z.enum(['append', 'prepend', 'replace']).describe('Edit operation'),
      content: z.string().describe('Content to add/replace'),
    })).describe('Array of section edits to apply'),
  },
  async ({ edits }) => {
    const results: string[] = []
    const errors: string[] = []

    const byFile = new Map<string, typeof edits>()
    for (const edit of edits) {
      if (edit.heading === 'Related') {
        errors.push(`${edit.filename}: ## Related is auto-managed, skipped`)
        continue
      }
      if (!byFile.has(edit.filename)) byFile.set(edit.filename, [])
      byFile.get(edit.filename)!.push(edit)
    }

    for (const [filename, fileEdits] of byFile) {
      const note = io.readNote(filename)
      if (!note) {
        errors.push(`${filename}: not found`)
        continue
      }

      const oldWikilinks = note.wikilinks
      let rawBody = note.rawBody

      for (const edit of fileEdits) {
        if (edit.operation === 'replace') rawBody = replaceSectionContent(rawBody, edit.heading, edit.content)
        else if (edit.operation === 'append') rawBody = appendToSection(rawBody, edit.heading, edit.content)
        else rawBody = prependToSection(rawBody, edit.heading, edit.content)
      }

      rawBody = touchModified(rawBody)
      io.writeNote(filename, rawBody)

      const updated = io.readNote(filename)!
      io.syncBacklinks(filename, oldWikilinks, updated.wikilinks)

      results.push(`${filename}: ${fileEdits.length} edit(s) applied`)
    }

    const summary = [
      ...results.map((r) => `  ok: ${r}`),
      ...errors.map((e) => `  err: ${e}`),
    ]
    return { content: [{ type: 'text', text: `Batch edit complete:\n${summary.join('\n')}` }] }
  }
)

// ── delete-note ─────────────────────────────────────────────────────────────

server.tool(
  'delete-note',
  'Delete a memory note. By default, refuses if other notes reference it (set force=true to override and clean up refs).',
  {
    filename: z.string().describe('Note filename'),
    force: z.boolean().optional().describe('Force delete even if referenced by other notes')
  },
  async ({ filename, force }) => {
    const note = io.readNote(filename)
    if (!note) {
      return { content: [{ type: 'text', text: `Error: Note "${filename}" not found` }], isError: true }
    }

    const inbound = io.getInboundLinks(filename)
    if (inbound.length > 0 && !force) {
      return {
        content: [{
          type: 'text',
          text: `Cannot delete "${filename}": referenced by ${inbound.length} note(s):\n${inbound.map((f) => `  - ${f}`).join('\n')}\n\nUse force=true to delete and clean up references.`
        }],
        isError: true
      }
    }

    if (inbound.length > 0 || note.wikilinks.length > 0) {
      io.cleanupRefsBeforeDelete(filename)
    }

    io.deleteNote(filename)
    return { content: [{ type: 'text', text: `Deleted "${filename}" (cleaned ${inbound.length} inbound references)` }] }
  }
)

// ── search-notes ────────────────────────────────────────────────────────────

server.tool(
  'search-notes',
  'Search memory notes by content, filename, or both.',
  {
    query: z.string().describe('Search query'),
    searchType: z.enum(['content', 'filename', 'both']).optional().describe('Where to search (default: both)')
  },
  async ({ query, searchType }) => {
    const type = searchType || 'both'
    const q = query.toLowerCase()
    const results: string[] = []

    for (const fn of io.listNotes()) {
      const note = io.readNote(fn)
      if (!note) continue

      const matchesFilename = fn.toLowerCase().includes(q)
      const matchesContent = note.rawBody.toLowerCase().includes(q)

      if (type === 'filename' && matchesFilename) results.push(fn)
      else if (type === 'content' && matchesContent) results.push(fn)
      else if (type === 'both' && (matchesFilename || matchesContent)) results.push(fn)
    }

    if (results.length === 0) {
      return { content: [{ type: 'text', text: `No notes found matching "${query}"` }] }
    }

    return {
      content: [{
        type: 'text',
        text: `Found ${results.length} note(s):\n${results.map((f) => `  - ${f}`).join('\n')}`
      }]
    }
  }
)

// ── list-notes ──────────────────────────────────────────────────────────────

server.tool(
  'list-notes',
  'List all memory notes, optionally filtered by tag or type.',
  {
    tag: z.string().optional().describe('Filter by tag'),
    type: noteTypeEnum.optional().describe('Filter by type')
  },
  async ({ tag, type }) => {
    let notes = io.listNotes().map((fn) => io.readNote(fn)).filter(Boolean) as MemoryNote[]

    if (tag) notes = notes.filter((n) => n.tags.includes(tag))
    if (type) notes = notes.filter((n) => n.type === type)

    if (notes.length === 0) {
      return { content: [{ type: 'text', text: 'No notes found' }] }
    }

    const lines = notes.map((n) => `- ${n.filename} [${n.type}] ${n.title}${n.tags.length ? ` (${n.tags.join(', ')})` : ''}`)
    return { content: [{ type: 'text', text: `${notes.length} note(s):\n${lines.join('\n')}` }] }
  }
)

// ── add-tags ────────────────────────────────────────────────────────────────

server.tool(
  'add-tags',
  'Add tags to a note.',
  {
    filename: z.string().describe('Note filename'),
    tags: z.array(z.string()).describe('Tags to add')
  },
  async ({ filename, tags }) => {
    const note = io.readNote(filename)
    if (!note) {
      return { content: [{ type: 'text', text: `Error: Note "${filename}" not found` }], isError: true }
    }

    const existing = new Set(note.tags)
    const newTags = tags.filter((t) => !existing.has(t))
    if (newTags.length === 0) {
      return { content: [{ type: 'text', text: 'All tags already present' }] }
    }

    const { data } = matter(note.rawBody)
    data.tags = [...note.tags, ...newTags]
    data.modified = today()
    const rawBody = matter.stringify(note.body, data)
    io.writeNote(filename, rawBody)

    return { content: [{ type: 'text', text: `Added ${newTags.length} tag(s) to "${filename}": ${newTags.join(', ')}` }] }
  }
)

// ── remove-tags ─────────────────────────────────────────────────────────────

server.tool(
  'remove-tags',
  'Remove tags from a note.',
  {
    filename: z.string().describe('Note filename'),
    tags: z.array(z.string()).describe('Tags to remove')
  },
  async ({ filename, tags }) => {
    const note = io.readNote(filename)
    if (!note) {
      return { content: [{ type: 'text', text: `Error: Note "${filename}" not found` }], isError: true }
    }

    const removeSet = new Set(tags)
    const remaining = note.tags.filter((t) => !removeSet.has(t))
    const removed = note.tags.filter((t) => removeSet.has(t))

    if (removed.length === 0) {
      return { content: [{ type: 'text', text: 'None of the specified tags were present' }] }
    }

    const { data } = matter(note.rawBody)
    data.tags = remaining
    data.modified = today()
    const rawBody = matter.stringify(note.body, data)
    io.writeNote(filename, rawBody)

    return { content: [{ type: 'text', text: `Removed ${removed.length} tag(s) from "${filename}": ${removed.join(', ')}` }] }
  }
)

// ── repair-related ─────────────────────────────────────────────────────────

server.tool(
  'repair-related',
  'Rebuild the ## Related section for a note by scanning all wikilinks (inbound and outbound). Use this to fix broken or out-of-sync backlinks — not for routine edits.',
  {
    filename: z.string().describe('Note filename to repair'),
  },
  async ({ filename }) => {
    const note = io.readNote(filename)
    if (!note) {
      return { content: [{ type: 'text', text: `Error: Note "${filename}" not found` }], isError: true }
    }

    const outbound = new Set<string>()
    const lines = note.body.split('\n')
    let inRelated = false
    for (const line of lines) {
      if (line.startsWith('## ')) {
        inRelated = line.trim() === '## Related'
        continue
      }
      if (!inRelated) {
        for (const m of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
          const resolved = io.resolveWikilink(m[1])
          if (resolved && resolved !== filename) outbound.add(filenameToWikilink(resolved))
        }
      }
    }

    const inbound = io.getInboundLinks(filename)
    for (const fn of inbound) {
      outbound.add(filenameToWikilink(fn))
    }

    const relatedEntries = [...outbound].sort().map((link) => `- [[${link}]]`).join('\n')
    const rawBody = replaceSectionContent(note.rawBody, 'Related', relatedEntries)

    io.writeNote(filename, rawBody)

    return {
      content: [{
        type: 'text',
        text: `Repaired ## Related for "${filename}": ${outbound.size} link(s) (${inbound.length} inbound, ${outbound.size - inbound.length} outbound)`
      }]
    }
  }
)

// ── spawn-session ──────────────────────────────────────────────────────────

const APP_DATA_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  process.platform === 'darwin'
    ? 'Library/Application Support/session-manager'
    : '.config/session-manager'
)

function getHookServerPort(): number | null {
  try {
    const portFile = path.join(APP_DATA_DIR, 'hook-server.port')
    if (!fs.existsSync(portFile)) return null
    return parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10)
  } catch {
    return null
  }
}

async function callHookServer(endpoint: string, body: unknown): Promise<unknown> {
  const port = getHookServerPort()
  if (!port) throw new Error('Session manager hook server is not running')

  const payload = JSON.stringify(body)
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Hook server error (${res.status}): ${text}`)
  }
  return JSON.parse(text)
}

function buildParentContext(reportBack: boolean): string {
  const parentId = process.env.APP_SESSION_ID || null
  if (!parentId) return ''

  const reportLine = reportBack
    ? `Report back your findings and results using the \`mcp__session-manager__send-message\` tool with targetSessionId "${parentId}".`
    : `If you need to report back results or issues, use the \`mcp__session-manager__send-message\` tool with targetSessionId "${parentId}".`

  return `\n\n---\nYou were spawned by session ${parentId}. ${reportLine}`
}

server.tool(
  'spawn-session',
  'Spawn a new Claude Code session in the session manager with an initial prompt. The session appears in the graph view and starts working immediately. Use this to delegate implementation tasks to a sub-session. The parent session ID and messaging instructions are automatically appended — NEVER include your own session ID in the prompt (it may be stale). Set reportBack=true to instruct the child to report back findings, or leave false for optional reporting. Do NOT manually write "report back" in the prompt — use the flag instead.',
  {
    prompt: z.string().describe('The initial prompt to send to the new session. Include full context — the new session has no conversation history.'),
    projectPath: z.string().optional().describe('Project directory for the new session. Defaults to the current working directory.'),
    allowedTools: z.array(z.string()).optional().describe('Restrict the session to specific tools (e.g. ["Read", "Write", "Edit", "Bash"])'),
    reportBack: z.boolean().optional().default(true).describe('When true (default), the child session is instructed to report back its findings to the parent. When false, it only mentions reporting as optional.'),
  },
  async ({ prompt, projectPath, allowedTools, reportBack }) => {
    try {
      const parentContext = buildParentContext(reportBack)
      const cwd = projectPath || process.cwd()
      const result = await callHookServer('/spawn', {
        prompt: prompt + parentContext,
        projectPath: cwd,
        allowedTools,
      }) as { id: string; projectPath: string }

      return {
        content: [{
          type: 'text',
          text: `Spawned session ${result.id} in ${result.projectPath}. The session is now visible in the session manager and working on the prompt.`
        }]
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error spawning session: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      }
    }
  }
)

// ── list-sessions ──────────────────────────────────────────────────────────

server.tool(
  'list-sessions',
  'List all active Claude Code sessions in the session manager. Returns session IDs, project paths, status, and terminal titles. Use this to discover sessions for messaging.',
  {},
  async () => {
    try {
      const result = await callHookServer('/sessions', {}) as {
        sessions: Array<{ id: string; projectPath: string; claudeSessionId: string | null; status: string; title: string | null }>
      }

      if (result.sessions.length === 0) {
        return { content: [{ type: 'text', text: 'No active sessions' }] }
      }

      const lines = result.sessions.map((s) =>
        `- ${s.id} [${s.status}] ${s.title || '(untitled)'} — ${s.projectPath}`
      )
      return { content: [{ type: 'text', text: `${result.sessions.length} active session(s):\n${lines.join('\n')}` }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error listing sessions: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      }
    }
  }
)

// ── send-message ───────────────────────────────────────────────────────────

server.tool(
  'send-message',
  'Send a message to another Claude Code session. If the target session is idle, the message is delivered immediately as a new prompt. If busy, it is queued and delivered when the session finishes its current task.',
  {
    targetSessionId: z.string().describe('The session ID to send the message to (from list-sessions or spawn-session)'),
    message: z.string().describe('The message content to send'),
  },
  async ({ targetSessionId, message }) => {
    try {
      const fromId = process.env.APP_SESSION_ID || null

      const result = await callHookServer('/message', {
        targetSessionId,
        message,
        fromSessionId: fromId,
      }) as { delivered: boolean; queued?: boolean }

      if (result.delivered) {
        return { content: [{ type: 'text', text: `Message delivered to session ${targetSessionId}` }] }
      } else {
        return { content: [{ type: 'text', text: `Message queued for session ${targetSessionId} (currently busy). It will be delivered when the session becomes idle.` }] }
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error sending message: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      }
    }
  }
)

// ── list-agents ────────────────────────────────────────────────────────────

server.tool(
  'list-agents',
  'List all available specialised agents that can be spawned. Returns agent names, descriptions, and their allowed tools.',
  {},
  async () => {
    try {
      const result = await callHookServer('/agents', {}) as {
        agents: Array<{ name: string; description: string; tools: string[] }>
      }

      if (result.agents.length === 0) {
        return { content: [{ type: 'text', text: 'No agents available' }] }
      }

      const lines = result.agents.map((a) =>
        `- **${a.name}** — ${a.description}\n  Tools: ${a.tools.join(', ')}`
      )
      return { content: [{ type: 'text', text: `${result.agents.length} agent(s) available:\n${lines.join('\n')}` }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error listing agents: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      }
    }
  }
)

// ── spawn-agent ────────────────────────────────────────────────────────────

server.tool(
  'spawn-agent',
  'Spawn a specialised agent in a new session. The agent is activated with its predefined tools and system prompt, then receives your task prompt. The send-message tool is auto-allowed so the agent can report back. Use list-agents to see available agents. NEVER include your own session ID in the prompt — it is appended automatically and your ID may be stale. Set reportBack=true to instruct the agent to report back findings, or leave false for optional reporting. Do NOT manually write "report back" in the prompt — use the flag instead.',
  {
    agentName: z.string().describe('Name of the agent to spawn (from list-agents)'),
    prompt: z.string().describe('The task prompt for the agent. Include full context — the agent has no conversation history.'),
    projectPath: z.string().optional().describe('Project directory for the session. Defaults to the current working directory.'),
    reportBack: z.boolean().optional().default(true).describe('When true (default), the agent is instructed to report back its findings to the parent. When false, it only mentions reporting as optional.'),
  },
  async ({ agentName, prompt, projectPath, reportBack }) => {
    try {
      const parentContext = buildParentContext(reportBack)
      const cwd = projectPath || process.cwd()
      const result = await callHookServer('/spawn-agent', {
        agentName,
        prompt: prompt + parentContext,
        projectPath: cwd,
      }) as { id: string; projectPath: string; agent: string }

      return {
        content: [{
          type: 'text',
          text: `Spawned ${result.agent} agent in session ${result.id} (${result.projectPath}). The agent is working on the prompt and can message back when done.`
        }]
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error spawning agent: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      }
    }
  }
)

// ─── Start server ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('[mcp-server] fatal:', err)
  process.exit(1)
})
