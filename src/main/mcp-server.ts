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
import { rrf } from './memory/embeddings'
import {
  configureEmbedClient,
  isAvailable as isEmbedClientAvailable,
  searchSemantic as embedClientSearch,
  searchKeyword as embedClientKeyword
} from './memory/embed-client'
import * as notes from './notes-manager'

// ─── Storage ───────────────────────────────────────────────────────────────

const MEMORIES_DIR = process.env.SM_MEMORIES_DIR || path.join(
  process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'session-manager')
    : path.join(process.env.HOME || '.', process.platform === 'darwin' ? 'Library/Application Support/session-manager' : '.config/session-manager'),
  'memories'
)

const io: NoteIO = createNoteIO(MEMORIES_DIR)

// Connect to the main process's embed-server for semantic search. The model
// is loaded once in the main process; this child sends queries over a Unix
// socket / named pipe instead of loading its own copy. Falls back to
// keyword-only if the socket is unreachable.
configureEmbedClient(process.env.SM_EMBED_SOCKET || null)

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

Always search first (search-memories or list-memories) to check if a note on the same topic already exists. **Update the existing note** rather than creating a duplicate.

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
| create-memory | Create a memory note with structured sections (type, context, details, outcome) |
| read-memory | Read a memory note by filename |
| edit-memory | Edit a single section (append/prepend/replace) |
| batch-section-edit | Edit multiple sections across multiple notes in one call |
| search-memories | Search memory notes by content, filename, or both |
| list-memories | List memory notes, optionally filtered by tag/type |
| delete-memory | Delete a memory note (cleans up backlinks automatically) |
| add-tags / remove-tags | Manage tags on notes |
| repair-related | Rebuild ## Related from actual wikilinks (for fixing broken backlinks) |
| spawn-session | Spawn a new Claude Code session with an initial prompt (visible in session manager). Pipeline: pass \`pipelineTaskId\` + \`pipelineRole\` (orchestrator/plan/implement/review) to link it into a task tree, \`pipelineLabel\` for its tree-node label, \`fanoutKind\` for parallel children, and \`isolate:true\` + \`worktreeBranch\` for an isolated git worktree worker |
| merge-worktree | Merge a finished worktree worker's branch back into the integration branch, remove its worktree, and mark the node read-only (pipeline) |
| spawn-agent | Spawn a specialised agent (researcher, debugger, etc.) in a new session with a task |
| list-agents | List available specialised agents and their capabilities |
| list-sessions | List all active sessions with IDs, status, and project paths |
| send-message | Send a message to another session (delivered when idle, queued when busy) |
| pipeline-get-task | Read a task's full state: stage, autonomy, pending gate, review round, and session tree. Call on resume to recover context (pipeline) |
| pipeline-set-stage | Orchestrator-only: advance a task Backlog→Plan→Implement→Review→Done. Call \`pipeline-request-approval\` first when autonomy is gated/manual (pipeline) |
| pipeline-request-approval | Pause at a user gate; auto-approves under 'auto' autonomy, otherwise sets a pending gate you must stop and wait on (pipeline) |
| emit-milestone | Post a one-line milestone to your session's feed — drives the card line, badge, status, and feed colour (pipeline) |
| pipeline-rename-session | Rename a node in your task tree to a descriptive board label (pipeline) |
| pipeline-put-artifact | Store the full plan/diff/review for a task so downstream stages read it cleanly instead of relaying big content via chat; overwrites same kind (pipeline) |
| pipeline-get-artifact | Read a stored hand-off artifact ('plan'/'diff'/'review'); found:false just means nothing stored yet, not an error (pipeline) |
| pipeline-start | Launch a backlog todo into the pipeline (same as the UI's "start task"): creates the task with per-task worktree isolation and spawns the orchestrator; no-op-safe if already running (pipeline) |
| pipeline-start-review | Send EXISTING work (uncommitted edits or a committed branch) straight into the review⇄fix loop, skipping plan/implement: diff comes from git (working tree or base...target range), todo body is the rubric (pipeline) |

Use **create-memory** with structured section inputs (context, details, outcome) instead of raw markdown.
Use **batch-section-edit** to edit multiple sections across multiple notes in one call.
Use **edit-memory** for simple single-section edits.

## Linking

Use [[wikilinks]] in note content to connect related notes. Wikilinks are resolved by **filename** (without the .md extension), not by note title — e.g. \`[[my-note]]\` links to \`my-note.md\`. Backlinks in ## Related are fully automatic — never edit them manually.

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

## Agentic pipeline

The session manager can run a task through an orchestrator/worker pipeline. An orchestrator session and its worker sessions are linked into one task tree via **spawn-session**'s pipeline params (\`pipelineTaskId\`, \`pipelineRole\`, \`pipelineLabel\`, \`fanoutKind\`). The orchestrator drives the board with **pipeline-set-stage** (Backlog→Plan→Implement→Review→Done) and gates progress at user checkpoints with **pipeline-request-approval**. Every session narrates its progress with **emit-milestone** (and can relabel tree nodes via **pipeline-rename-session**), while **pipeline-get-task** recovers full task state on resume. Finished worktree workers (spawned with \`isolate:true\`) are folded back in with **merge-worktree**. Large stage hand-offs (the full plan, a diff summary, review verdicts) pass between stages via **pipeline-put-artifact** / **pipeline-get-artifact** — stored off the board so the planner's full plan, the implementer's diff, and each reviewer's verdict flow cleanly to the next stage instead of being relayed through chat or milestones (which stay one-line summaries).

## Notes & todo lists (separate from memory)

The app also hosts a distinct Notes system for user-facing task tracking — free-form markdown notes and structured todo lists, organised by project folder. These are NOT memory notes. Use the following tools when the user wants to jot, track, or manage todos:

| Tool | Purpose |
|------|---------|
| create-note / read-note / edit-note | Per-project markdown notes (distinct from create-memory) |
| create-todo-list | Create an empty todo list (.todo.yaml) |
| add-todo / set-todo-status / update-todo-text / remove-todo | Mutate items within a todo list |
| list-todos | Flat view of todos across all projects (filter by project or status) |
| list-notes / list-projects / search-notes | Discovery |
| move-note / delete-note | Organisation |

Statuses in v1: \`not-started\` and \`completed\` only. Assignment and agent dispatch come in v2.

Memory notes stored in: ${MEMORIES_DIR}`
  }
)

// Suggest existing notes that the just-written content seems related to.
// Uses semantic search (cosine distance from sqlite-vec — lower = more similar).
// Excludes the source note, existing wikilinks, and anything beyond the cutoff.
const SUGGEST_DISTANCE_MAX = 1.0
const SUGGEST_TOP_K = 5

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
  'could', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those', 'i',
  'you', 'he', 'she', 'it', 'we', 'they', 'them', 'their', 'what', 'which', 'who',
  'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'with', 'from', 'into', 'onto', 'about',
  'between', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'of',
  'in', 'on', 'at', 'by', 'for', 'as', 'if', 'then', 'else', 'because', 'while',
  'note', 'notes', 'see', 'also', 'use', 'used', 'using', 'one', 'two', 'three'
])

function extractKeywords(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []
  return new Set(tokens.filter((t) => !STOPWORDS.has(t)))
}

function scoreKeywordOverlap(query: Set<string>, target: string): number {
  if (query.size === 0) return 0
  const targetTokens = extractKeywords(target)
  let overlap = 0
  for (const t of query) if (targetTokens.has(t)) overlap++
  return overlap
}

async function suggestRelatedNotes(
  sourceFilename: string,
  query: string,
  alreadyLinked: Set<string>
): Promise<{ filename: string; distance: number; keywordScore: number }[]> {
  if (!query.trim()) return []

  const queryTokens = extractKeywords(query)

  const embedAvailable = await isEmbedClientAvailable()

  // Semantic candidates (best chunk per file)
  const semanticByFile = new Map<string, number>()
  if (embedAvailable) {
    const hits = await embedClientSearch(query, 50)
    for (const hit of hits) {
      if (hit.filename === sourceFilename) continue
      if (!hit.filename.endsWith('.md')) continue
      if (hit.distance > SUGGEST_DISTANCE_MAX) continue
      const prev = semanticByFile.get(hit.filename)
      if (prev === undefined || hit.distance < prev) semanticByFile.set(hit.filename, hit.distance)
    }
  }

  // Keyword candidates. Preferred path: ask the main process's IndexedNote
  // map over the embed socket (constant-time regardless of corpus size).
  // Fallback: scan files locally if the socket is unreachable.
  const keywordByFile = new Map<string, number>()
  if (embedAvailable) {
    const hits = await embedClientKeyword([...queryTokens], { limit: 50, bodyChars: 500 })
    for (const h of hits) {
      if (h.filename === sourceFilename) continue
      if (h.score < 2) continue
      keywordByFile.set(h.filename, h.score)
    }
  } else {
    for (const fn of io.listNotes()) {
      if (fn === sourceFilename) continue
      const note = io.readNote(fn)
      if (!note) continue
      const haystack = `${note.title}\n${fn}\n${note.body.slice(0, 500)}`
      const score = scoreKeywordOverlap(queryTokens, haystack)
      if (score >= 2) keywordByFile.set(fn, score)
    }
  }

  // Rank lists for RRF
  const semanticRanked = [...semanticByFile.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([filename, distance]) => ({ filename, distance }))

  const keywordRanked = [...keywordByFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([filename, score]) => ({ filename, score }))

  const fused = rrf<{ filename: string }>(
    [
      { items: semanticRanked, weight: 1 },
      { items: keywordRanked, weight: 1.2 }
    ],
    (n) => n.filename
  )

  const out: { filename: string; distance: number; keywordScore: number }[] = []
  for (const { item } of fused) {
    if (alreadyLinked.has(item.filename)) continue
    if (!io.readNote(item.filename)) continue
    out.push({
      filename: item.filename,
      distance: semanticByFile.get(item.filename) ?? 2,
      keywordScore: keywordByFile.get(item.filename) ?? 0
    })
    if (out.length >= SUGGEST_TOP_K) break
  }
  return out
}

function formatSuggestions(
  suggestions: { filename: string; distance: number; keywordScore: number }[]
): string {
  if (suggestions.length === 0) return ''
  const lines = suggestions.map((s) => {
    const sim = (1 - s.distance / 2).toFixed(2)
    return `  - [[${s.filename.replace(/\.md$/, '')}]] (sim ${sim}, keyword ${s.keywordScore})`
  })
  return (
    `\n\nSuggested related notes (verify before linking):\n` +
    lines.join('\n') +
    `\nIf any are genuinely related, add the wikilink in the appropriate body section via edit-memory. Backlinks sync automatically.`
  )
}

// ── create-memory ───────────────────────────────────────────────────────────

server.tool(
  'create-memory',
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
    let fn = filename || slugify(title)
    if (!fn.endsWith('.md')) fn = `${fn}.md`

    if (io.readNote(fn)) {
      return { content: [{ type: 'text', text: `Error: Note "${fn}" already exists` }], isError: true }
    }

    const rawBody = generateNote({ title, type: type || undefined, tags, summary, context, details, outcome })
    io.writeNote(fn, rawBody)
    let note = io.readNote(fn)!

    io.syncBacklinks(fn, [], note.wikilinks)
    note = io.readNote(fn)!  // Re-read — syncBacklinks may have updated source's Related

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

    const alreadyLinked = new Set<string>()
    for (const link of note.wikilinks) {
      const resolved = io.resolveWikilink(link)
      if (resolved) alreadyLinked.add(resolved)
    }
    for (const ref of inbound) alreadyLinked.add(ref)

    const queryText = [title, summary, context, details, outcome].filter(Boolean).join('\n\n')
    const suggestions = await suggestRelatedNotes(fn, queryText, alreadyLinked)

    const base = `Created "${fn}" [${note.type || 'context'}] (${note.wikilinks.length} outbound, ${inbound.length} inbound links synced)`
    return { content: [{ type: 'text', text: base + formatSuggestions(suggestions) }] }
  }
)

// ── read-memory ─────────────────────────────────────────────────────────────

server.tool(
  'read-memory',
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

// ── edit-memory ─────────────────────────────────────────────────────────────

server.tool(
  'edit-memory',
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

// ── delete-memory ───────────────────────────────────────────────────────────

server.tool(
  'delete-memory',
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

// ── search-memories ─────────────────────────────────────────────────────────

server.tool(
  'search-memories',
  'Search memory notes by content, filename, or both. Uses hybrid keyword + semantic search when the local embedding index is available; falls back to keyword-only otherwise.',
  {
    query: z.string().describe('Search query'),
    searchType: z.enum(['content', 'filename', 'both']).optional().describe('Where to search (default: both)')
  },
  async ({ query, searchType }) => {
    const type = searchType || 'both'
    const q = query.toLowerCase()

    // Keyword pass over all notes.
    const keyword: string[] = []
    for (const fn of io.listNotes()) {
      const note = io.readNote(fn)
      if (!note) continue

      const matchesFilename = fn.toLowerCase().includes(q)
      const matchesContent = note.rawBody.toLowerCase().includes(q)

      if (type === 'filename' && matchesFilename) keyword.push(fn)
      else if (type === 'content' && matchesContent) keyword.push(fn)
      else if (type === 'both' && (matchesFilename || matchesContent)) keyword.push(fn)
    }

    let results: string[] = keyword

    // Semantic pass — only when index is available and we're searching content.
    if (
      query.trim().length > 0 &&
      type !== 'filename' &&
      (await isEmbedClientAvailable())
    ) {
      const semanticHits = await embedClientSearch(query, 50)
      const semanticByFile: string[] = []
      const seen = new Set<string>()
      for (const hit of semanticHits) {
        if (seen.has(hit.filename)) continue
        seen.add(hit.filename)
        semanticByFile.push(hit.filename)
      }
      const fused = rrf<string>(
        [
          { items: keyword },
          { items: semanticByFile }
        ],
        (fn) => fn
      )
      results = fused.map((f) => f.item)
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

// ── list-memories ───────────────────────────────────────────────────────────

server.tool(
  'list-memories',
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

const APP_DATA_DIR = process.env.SM_DATA_DIR || (
  process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'session-manager')
    : process.platform === 'darwin'
      ? path.join(process.env.HOME || '.', 'Library', 'Application Support', 'session-manager')
      : path.join(process.env.HOME || '.', '.config', 'session-manager')
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

function buildParentContext(reportBack: 'true' | 'optional' | 'done' | 'false'): string {
  const parentId = process.env.APP_SESSION_ID || null
  if (!parentId) return ''

  const reportLine =
    reportBack === 'true'
      ? `Report back your findings and results using the \`mcp__session-manager__send-message\` tool with targetSessionId "${parentId}".`
      : reportBack === 'done'
        ? `When you have finished your task, send a brief completion notification using the \`mcp__session-manager__send-message\` tool with targetSessionId "${parentId}". Include a short task identifier so the parent knows which task finished (e.g. "Schema migration done." or "Lint cleanup done."). Do NOT include detailed findings — just confirm completion.`
        : reportBack === 'optional'
          ? `If you need to report back results or issues, use the \`mcp__session-manager__send-message\` tool with targetSessionId "${parentId}".`
          : `Do NOT report back unless you run into an issue that blocks your work. If you do need help, use the \`mcp__session-manager__send-message\` tool with targetSessionId "${parentId}".`

  return `\n\n---\nYou were spawned by session ${parentId}. ${reportLine}`
}

server.tool(
  'spawn-session',
  'Spawn a new Claude Code session in the session manager with an initial prompt. The session appears in the graph view and starts working immediately. Use this to delegate implementation tasks to a sub-session. The parent session ID and messaging instructions are automatically appended — NEVER include your own session ID in the prompt (it may be stale). Set reportBack=true to instruct the child to report back findings, or leave false for optional reporting. Do NOT manually write "report back" in the prompt — use the flag instead.',
  {
    prompt: z.string().describe('The initial prompt to send to the new session. Include full context — the new session has no conversation history.'),
    projectPath: z.string().optional().describe('Project directory for the new session. Defaults to the current working directory.'),
    allowedTools: z.array(z.string()).optional().describe('Restrict the session to specific tools (e.g. ["Read", "Write", "Edit", "Bash"])'),
    reportBack: z.enum(['true', 'done', 'optional', 'false']).optional().default('true').describe('Controls report-back behavior. "true" (default): child must report back findings. "done": child sends a brief completion notification (no details). "optional": reporting is mentioned but not required. "false": do NOT report back unless blocked by an issue.'),
    pipelineTaskId: z.string().optional().describe('Agentic pipeline: link this session into the given task\'s tree. Only set when spawning a pipeline stage/worker.'),
    pipelineRole: z.enum(['orchestrator', 'plan', 'implement', 'review']).optional().describe('Agentic pipeline: this session\'s role in the task tree. Required with pipelineTaskId.'),
    pipelineLabel: z.string().optional().describe('Agentic pipeline: short label for the tree node (e.g. "Research · auth flow", "worktree: feat/export-ui").'),
    fanoutKind: z.string().optional().describe('Agentic pipeline: when this spawn is a parallel child, the kind of fan-out (e.g. "research", "worktrees", "topics").'),
    worktreeBranch: z.string().optional().describe('Agentic pipeline: for worktree workers, the branch they build on (recorded for resume / read-only-after-merge).'),
    isolate: z.boolean().optional().describe('Agentic pipeline: create an isolated git worktree+branch for this worker so parallel workers cannot clobber each other. Requires worktreeBranch and a git projectPath; falls back to the shared dir (with a warning) for non-git projects.'),
  },
  async ({ prompt, projectPath, allowedTools, reportBack, pipelineTaskId, pipelineRole, pipelineLabel, fanoutKind, worktreeBranch, isolate }) => {
    try {
      const parentContext = buildParentContext(reportBack)
      const cwd = projectPath || process.cwd()
      const result = await callHookServer('/spawn', {
        prompt: prompt + parentContext,
        projectPath: cwd,
        allowedTools,
        pipelineTaskId,
        pipelineRole,
        pipelineLabel,
        fanoutKind,
        worktreeBranch,
        isolate,
        // The spawner becomes the parent node in the tree.
        parentSessionId: process.env.APP_SESSION_ID || undefined,
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
  'Send a message to another Claude Code session. The message is delivered instantly via the monitor plugin — it arrives as a task notification regardless of whether the target session is idle or working.',
  {
    targetSessionId: z.string().describe('The session ID to send the message to (from list-sessions or spawn-session)'),
    message: z.string().describe('The message content to send'),
  },
  async ({ targetSessionId, message }) => {
    try {
      const fromId = process.env.APP_SESSION_ID || null

      await callHookServer('/message', {
        targetSessionId,
        message,
        fromSessionId: fromId,
      })

      return { content: [{ type: 'text', text: `Message delivered to session ${targetSessionId}` }] }
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
    reportBack: z.enum(['true', 'done', 'optional', 'false']).optional().default('true').describe('Controls report-back behavior. "true" (default): agent must report back findings. "done": agent sends a brief completion notification (no details). "optional": reporting is mentioned but not required. "false": do NOT report back unless blocked by an issue.'),
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

// ─── Agentic pipeline (Cmd+L) ────────────────────────────────────────────────
//
// Tools for an orchestrator/worker session to drive its task through the
// pipeline. The orchestrator is told its taskId in its spawn prompt; workers
// emit milestones against the same taskId using their own session id.

server.tool(
  'pipeline-get-task',
  'Read the current state of an agentic-pipeline task: its stage, autonomy level, pending gate, review round, and the full session tree (orchestrator + stage/fan-out children with their statuses). Call this on resume to recover context, or before deciding the next transition.',
  {
    taskId: z.string().describe('The pipeline task id (provided in your orchestrator prompt).'),
  },
  async ({ taskId }) => {
    try {
      const task = await callHookServer('/pipeline/get-task', { taskId })
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error reading task: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  }
)

server.tool(
  'pipeline-set-stage',
  'Move a pipeline task to a new stage (Backlog→Plan→Implement→Review→Done). Orchestrator-only — this is how the board advances. When autonomy is gated/manual and you are crossing a user gate, call pipeline-request-approval FIRST and wait for approval instead of forcing the move here.',
  {
    taskId: z.string().describe('The pipeline task id.'),
    stage: z.enum(['plan', 'implement', 'review', 'done']).describe('Target stage.'),
  },
  async ({ taskId, stage }) => {
    try {
      await callHookServer('/pipeline/set-stage', { taskId, stage })
      return { content: [{ type: 'text', text: `Task ${taskId} moved to ${stage}.` }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error setting stage: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  }
)

server.tool(
  'emit-milestone',
  'Emit a notable milestone to your session\'s feed in the pipeline UI. Use this for anything the user should see at a glance (plan ready, fanned out, review verdict, blocked, done) — it drives the card line, badges, and status. Far better than relying on raw terminal output. Defaults the session to you (the caller).',
  {
    taskId: z.string().describe('The pipeline task id this session belongs to.'),
    text: z.string().describe('One-line, human-readable milestone for the feed.'),
    status: z.enum(['working', 'idle', 'permission', 'done', 'queued']).optional().describe('Update this session\'s status.'),
    badge: z.string().optional().describe('Short status chip, e.g. "2 issues", "approved", "plan ready".'),
    tone: z.enum(['pass', 'fail', 'warn', 'active', 'neutral']).optional().describe('Color tone for the badge.'),
    kind: z.enum(['info', 'plan-ready', 'fanout', 'review-verdict', 'blocked', 'done', 'error']).optional().describe('Notification type for feed colouring'),
    fanoutKind: z.string().optional().describe('If you just fanned out, the kind: "research" | "worktrees" | "topics".'),
    sessionId: z.string().optional().describe('Override the target session id (defaults to your own session).'),
  },
  async ({ taskId, text, status, badge, tone, kind, fanoutKind, sessionId }) => {
    try {
      const sid = sessionId || process.env.APP_SESSION_ID
      if (!sid) {
        return { content: [{ type: 'text', text: 'No session id available (APP_SESSION_ID unset). Pass sessionId explicitly.' }], isError: true }
      }
      await callHookServer('/pipeline/emit-milestone', { taskId, sessionId: sid, text, status, badge, tone, kind, fanoutKind })
      return { content: [{ type: 'text', text: `Milestone emitted.` }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error emitting milestone: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  }
)

server.tool(
  'pipeline-rename-session',
  'Rename a session in your pipeline task tree (one of your children, or yourself) to a descriptive label shown on the board — e.g. "Security review · auth token check", "Implement · CSV serializer". Use the session id returned by spawn-session.',
  {
    taskId: z.string().describe('The pipeline task id.'),
    sessionId: z.string().describe('The app session id of the node to rename (from spawn-session, or your own APP_SESSION_ID).'),
    label: z.string().describe('The new label.'),
  },
  async ({ taskId, sessionId, label }) => {
    try {
      await callHookServer('/pipeline/rename-session', { taskId, sessionId, label })
      return { content: [{ type: 'text', text: `Renamed ${sessionId} to "${label}".` }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error renaming session: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  }
)

server.tool(
  'pipeline-request-approval',
  'Pause the task at a gate and ask the user to approve advancing. Under "auto" autonomy this auto-approves and advances immediately; under "gated"/"manual" it sets a pending gate the user resolves in the UI, and you should stop and wait for a message before proceeding. Returns the decision.',
  {
    taskId: z.string().describe('The pipeline task id.'),
    gate: z.string().describe('Short label for what you want to do, e.g. "Begin implementation", "Merge to Done".'),
    detail: z.string().optional().describe('Context shown in the approval banner (e.g. "Plan ready · 3 steps · ~2 files").'),
  },
  async ({ taskId, gate, detail }) => {
    try {
      const result = await callHookServer('/pipeline/request-approval', { taskId, gate, detail }) as { decision: string; stage?: string }
      const msg = result.decision === 'auto-approved'
        ? `Auto-approved (autonomy=auto). Task advanced to ${result.stage}. Continue.`
        : result.decision === 'pending'
          ? `Gate "${gate}" is pending user approval. STOP and wait for an approval message before continuing.`
          : `Task not found.`
      return { content: [{ type: 'text', text: msg }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error requesting approval: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  }
)

server.tool(
  'merge-worktree',
  'Merge a finished worktree worker\'s branch back into the integration branch, then remove its worktree and mark its node read-only. Call this when a worker spawned with isolate:true reports it has FINISHED. On success the worker node becomes read-only (its session is torn down). On a merge conflict the worktree + session are KEPT so a fix worker can resolve and you can retry. Orchestrator-only.',
  {
    taskId: z.string().describe('The pipeline task id.'),
    sessionId: z.string().describe('The app session id of the worktree worker to merge (from spawn-session).'),
  },
  async ({ taskId, sessionId }) => {
    try {
      const result = await callHookServer('/pipeline/merge-worktree', { taskId, sessionId }) as
        { merged: boolean; branch?: string; conflicts?: string[] }
      if (result.merged) {
        return { content: [{ type: 'text', text: `Merged ${result.branch ?? 'branch'}, worktree removed, node read-only.` }] }
      }
      return {
        content: [{
          type: 'text',
          text: `MERGE CONFLICT in: ${(result.conflicts ?? []).join(', ') || '(unknown files)'}. Worktree kept — resolve in the worker's worktree and retry merge-worktree, or spawn a fix worker.`,
        }],
      }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error merging worktree: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  }
)

server.tool(
  'pipeline-put-artifact',
  'Store the full plan/diff/review for a pipeline task so downstream stages read it cleanly instead of relaying big content through chat. Overwrites any existing artifact of the same kind. Keep large content here, NOT in milestones or chat.',
  {
    taskId: z.string().describe('The pipeline task id.'),
    kind: z.string().describe("Artifact kind: 'plan' | 'diff' | 'review' (free-form, e.g. 'review:security')."),
    content: z.string().describe('The full artifact content (markdown).'),
  },
  async ({ taskId, kind, content }) => {
    try {
      const sid = process.env.APP_SESSION_ID
      const r = await callHookServer('/pipeline/put-artifact', { taskId, kind, content, sessionId: sid }) as { bytes: number }
      return { content: [{ type: 'text', text: `Stored ${kind} artifact (${r.bytes} bytes).` }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error storing artifact: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  }
)

server.tool(
  'pipeline-get-artifact',
  'Read a stored hand-off artifact for a pipeline task. Implementers fetch the plan; the orchestrator reads review verdicts to drive the review loop. A missing artifact (found:false) is NOT an error — it just means nothing has been stored yet.',
  {
    taskId: z.string().describe('The pipeline task id.'),
    kind: z.string().describe("Artifact kind to read: 'plan' | 'diff' | 'review' (or a specific variant like 'review:security')."),
  },
  async ({ taskId, kind }) => {
    try {
      const r = await callHookServer('/pipeline/get-artifact', { taskId, kind }) as { found: boolean; content: string | null }
      return { content: [{ type: 'text', text: r.found ? (r.content ?? '') : `No ${kind} artifact stored yet.` }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error reading artifact: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  }
)

server.tool(
  'pipeline-start',
  'Launch a backlog todo into the agentic pipeline (the same action as the UI\'s "start task"). Looks up the todo, creates the pipeline task with per-task git-worktree isolation, spawns the orchestrator session, and updates the board live. Use this to kick off work on a backlog todo from an agent/session instead of the UI. No-op-safe: if the todo is already running it reports that instead of starting a duplicate.',
  {
    todoId: z.string().describe('The backlog todo id to launch into the pipeline.'),
    defaultAutonomy: z.enum(['manual', 'gated', 'auto']).optional()
      .describe('Autonomy for the new task: manual = pause at every hand-off, gated = pause at gates, auto = run unattended. Defaults to the configured default (gated).'),
    projectPath: z.string().optional()
      .describe('Absolute path to the project the task should run in. If omitted, derived from the todo\'s project: tag and the configured base projects dir.'),
  },
  async ({ todoId, defaultAutonomy, projectPath }) => {
    try {
      const r = await callHookServer('/pipeline/start', { todoId, defaultAutonomy, projectPath }) as
        { ok: boolean; alreadyRunning: boolean; taskId: string; orchestratorSessionId: string | null }
      if (r.alreadyRunning) {
        return { content: [{ type: 'text', text: `Todo ${todoId} is already in the pipeline (task ${r.taskId}, orchestrator ${r.orchestratorSessionId ?? 'none'}). Not started again.` }] }
      }
      return { content: [{ type: 'text', text: `Started pipeline task ${r.taskId}. Orchestrator session: ${r.orchestratorSessionId ?? '(spawn failed — check logs)'}.` }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error starting pipeline task: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  }
)

server.tool(
  'pipeline-start-review',
  'Send EXISTING work (written outside the pipeline — uncommitted edits, or a committed branch) straight into the review⇄fix loop, skipping plan/implement. The diff comes from git (working tree, or a base...target range); the todo body is the rubric reviewers check it against. No-op-safe: if the todo is already running it reports that instead of starting a duplicate.',
  {
    todoId: z.string().describe('Backlog todo id whose body is the review rubric.'),
    defaultAutonomy: z.enum(['manual', 'gated', 'auto']).optional()
      .describe('Autonomy for the new task. Defaults to the configured default (gated).'),
    projectPath: z.string().optional()
      .describe('Absolute project dir (the repo holding the changes). For working-tree mode this is where the uncommitted edits live.'),
    diffSource: z.union([
      z.object({ kind: z.literal('working-tree') }),
      z.object({ kind: z.literal('range'), base: z.string(), target: z.string() }),
    ]).optional().default({ kind: 'working-tree' })
      .describe("Where the diff comes from. 'working-tree' (default) = uncommitted changes in the project dir (reviewed in place, no worktree). 'range' = base...target committed work (e.g. base:'main', target:'HEAD')."),
  },
  async ({ todoId, defaultAutonomy, projectPath, diffSource }) => {
    try {
      const r = await callHookServer('/pipeline/start', { todoId, defaultAutonomy, projectPath, startStage: 'review', diffSource }) as
        { ok: boolean; alreadyRunning: boolean; taskId: string; orchestratorSessionId: string | null }
      if (r.alreadyRunning) {
        return { content: [{ type: 'text', text: `Todo ${todoId} is already in the pipeline (task ${r.taskId}, orchestrator ${r.orchestratorSessionId ?? 'none'}). Not started again.` }] }
      }
      return { content: [{ type: 'text', text: `Started send-to-review task ${r.taskId}. Orchestrator session: ${r.orchestratorSessionId ?? '(spawn failed — check logs)'}.` }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error starting review task: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  }
)

// ─── Todos ──────────────────────────────────────────────────────────────────

const TODO_KEY_PREFIX = 'todo:'
const TODO_SEMANTIC_DISTANCE_THRESHOLD = 0.8

async function listTodosWithSemantic(opts: {
  tags?: string[]
  done?: boolean
  search?: string
}): Promise<ReturnType<typeof notes.listTodosSummary>> {
  const { tags, done, search } = opts
  const query = search?.trim() ?? ''
  if (!query) return notes.listTodosSummary({ tags, done })

  // Substring half — uses the existing in-process filter.
  const substring = notes.listTodosSummary({ tags, done, search: query })
  const substringIds = new Set(substring.map((t) => t.id))

  // Semantic half — main process owns the model; we query over the socket
  // and filter to todo: keys with an acceptable distance.
  if (!(await isEmbedClientAvailable())) return substring

  const hits = await embedClientSearch(query, 120)
  const semanticIds: string[] = []
  const seen = new Set<string>()
  for (const h of hits) {
    if (!h.filename.startsWith(TODO_KEY_PREFIX)) continue
    if (h.distance > TODO_SEMANTIC_DISTANCE_THRESHOLD) continue
    const id = h.filename.slice(TODO_KEY_PREFIX.length)
    if (substringIds.has(id) || seen.has(id)) continue
    seen.add(id)
    semanticIds.push(id)
  }
  if (semanticIds.length === 0) return substring

  // Re-apply tag/done filters via a fresh listing (semanticIds came from the
  // full corpus, including todos that don't match the current filter).
  const baseFiltered = notes.listTodosSummary({ tags, done })
  const baseById = new Map(baseFiltered.map((t) => [t.id, t] as const))
  const extras = semanticIds.map((id) => baseById.get(id)).filter((t): t is NonNullable<typeof t> => Boolean(t))

  return [...substring, ...extras]
}

server.tool(
  'list-todos',
  'List todos. Filter by tags, done state, or search. Search is hybrid: case-insensitive substring (title + body) + semantic (bge-small embeddings with a similarity threshold), deduped. Tag semantics: project:* tags OR with each other, non-project tags AND with each other; the two groups AND together. Returns summary lines without the body - use read-todo to fetch full body.',
  {
    tags: z.array(z.string()).optional().describe('Filter tags. project:* tags use OR; other tags use AND.'),
    done: z.boolean().optional().describe('Filter by done state'),
    search: z.string().optional().describe('Hybrid substring + semantic search against title + body'),
  },
  async ({ tags, done, search }) => {
    const items = await listTodosWithSemantic({ tags, done, search })
    if (items.length === 0) return { content: [{ type: 'text', text: 'No todos found' }] }
    const lines = items.map((t) => {
      const box = t.done ? '[x]' : '[ ]'
      const tagStr = t.tags.length ? `  {${t.tags.join(', ')}}` : ''
      return `${box} ${t.title}${tagStr}  (id: ${t.id})`
    })
    return { content: [{ type: 'text', text: `${items.length} todo(s):\n${lines.join('\n')}` }] }
  },
)

server.tool(
  'read-todo',
  'Read a todo\'s full content including its markdown body.',
  { id: z.string() },
  async ({ id }) => {
    try {
      const t = notes.readTodo(id)
      const fm = `id: ${t.id}\ntitle: ${t.title}\ndone: ${t.done}\ntags: [${t.tags.join(', ')}]\ncreated: ${t.created}\nupdated: ${t.updated}`
      return { content: [{ type: 'text', text: `${fm}\n\n---\n${t.body}` }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  },
)

server.tool(
  'create-todo',
  'Create a new todo. Tags are free-form strings; use `project:<name>` for project membership.',
  {
    title: z.string(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
  },
  async ({ title, body, tags }) => {
    const t = notes.createTodo({ title, body, tags })
    return { content: [{ type: 'text', text: `Created todo ${t.id}: ${t.title}` }] }
  },
)

server.tool(
  'update-todo',
  'Update fields on a todo. Pass only the fields to change. Replacing `tags` replaces the entire tag set.',
  {
    id: z.string(),
    title: z.string().optional(),
    body: z.string().optional(),
    done: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
  },
  async ({ id, title, body, done, tags }) => {
    try {
      const patch: { title?: string; body?: string; done?: boolean; tags?: string[] } = {}
      if (title !== undefined) patch.title = title
      if (body !== undefined) patch.body = body
      if (done !== undefined) patch.done = done
      if (tags !== undefined) patch.tags = tags
      const t = notes.updateTodo(id, patch)
      return { content: [{ type: 'text', text: `Updated ${t.id}` }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  },
)

server.tool(
  'delete-todo',
  'Delete a todo by id.',
  { id: z.string() },
  async ({ id }) => {
    notes.deleteTodo(id)
    return { content: [{ type: 'text', text: `Deleted ${id}` }] }
  },
)

server.tool(
  'list-tags',
  'List all tags in use, with counts. Useful for autocomplete and discovering project tags.',
  {},
  async () => {
    const tags = notes.listAllTags()
    if (tags.length === 0) return { content: [{ type: 'text', text: 'No tags' }] }
    const lines = tags.map((t) => `- ${t.tag} (${t.count})`)
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  },
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
