/**
 * Executing an accepted suggestion.
 *
 * Everything here routes through machinery that already exists and is already
 * the user's own surface — schedule-store for scheduled tasks, notes-manager
 * for todos, the memory backlink helpers for wikilinks, fs-service for skills.
 * The observer never gets its own parallel write path; accepting a suggestion
 * does exactly what the user would have done by hand.
 *
 * Every branch validates the proposal before touching anything: the proposal
 * JSON was written by an LLM, so it is untrusted input, not a typed value.
 */

import { join } from 'path'
import * as scheduleStore from '../schedule-store'
import * as notesManager from '../notes-manager'
import { readNote, writeNote } from '../memory/store'
import { addToRelatedSection, filenameToWikilink, touchModified } from '../memory/core'
import { invalidate } from '../memory/index'
import { syncBacklinks } from '../memory/backlinks'
import { installSkillCommand } from '../fs-service'
import { setPatternStatus } from './db'
import type { SuggestionRow } from './db'

export interface ApplyResult {
  ok: boolean
  /** Human-readable outcome stored on the suggestion row. */
  message: string
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Apply an accepted suggestion. Never throws — a bad proposal resolves to a
 *  failed result the inbox can show, not an unhandled rejection. */
export function applySuggestion(
  suggestion: SuggestionRow,
  ctx: { defaultProjectPath: string | null; memoriesDir: string },
): ApplyResult {
  try {
    switch (suggestion.kind) {
      case 'scheduled-task': return applyScheduledTask(suggestion, ctx.defaultProjectPath)
      case 'todo':           return applyTodo(suggestion)
      case 'skill':          return applySkill(suggestion)
      case 'memory-link':    return applyMemoryLink(suggestion)
      case 'todo-cleanup':   return applyTodoCleanup(suggestion)
      default:
        return { ok: false, message: `Unknown suggestion kind "${suggestion.kind}"` }
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

function applyScheduledTask(s: SuggestionRow, defaultProjectPath: string | null): ApplyResult {
  const p = s.proposal
  const name = str(p.name) ?? s.title
  const prompt = str(p.prompt)
  const projectPath = str(p.projectPath) ?? defaultProjectPath
  if (!prompt) return { ok: false, message: 'Proposal has no prompt' }
  if (!projectPath) return { ok: false, message: 'Proposal has no project directory and no default is configured' }

  // Recurrence is user-visible scheduling; validate rather than trust.
  const raw = (p.recurrence ?? {}) as Record<string, unknown>
  let recurrence: scheduleStore.ScheduleRecurrence = { kind: 'none' }
  if (raw.kind === 'interval') {
    const minutes = Number(raw.minutes)
    // Floor at 15 minutes: an LLM-proposed "every minute" job would hammer the
    // machine, and no observed usage pattern justifies sub-quarter-hour runs.
    recurrence = { kind: 'interval', minutes: Number.isFinite(minutes) ? Math.max(15, Math.round(minutes)) : 60 }
  } else if (raw.kind === 'daily') {
    const hour = Number(raw.hour), minute = Number(raw.minute)
    recurrence = {
      kind: 'daily',
      hour: Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.round(hour))) : 9,
      minute: Number.isFinite(minute) ? Math.min(59, Math.max(0, Math.round(minute))) : 0,
    }
  }

  const launch = p.launch === 'every' || p.launch === 'firstOfDay' ? p.launch : 'off'
  const model = ['haiku', 'sonnet', 'opus', 'fable'].includes(String(p.model)) ? String(p.model) : undefined

  const task = scheduleStore.createSchedule({
    name,
    prompt,
    projectPath,
    autoApprove: true,
    model,
    launch,
    recurrence,
    // Created DISABLED. A suggestion the user accepted in one click should not
    // silently start firing a Claude session on a timer — they enable it in ⌘J
    // once they've read the prompt.
    enabled: false,
  })
  return { ok: true, message: `Created scheduled task "${task.name}" (disabled — enable it in ⌘J when you're happy with the prompt)` }
}

function applyTodo(s: SuggestionRow): ApplyResult {
  const p = s.proposal
  const title = str(p.title) ?? s.title
  const tags = Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : []
  const todo = notesManager.createTodo({
    title,
    body: str(p.body) ?? s.rationale,
    tags: [...new Set([...tags, 'from:observer'])],
  })
  return { ok: true, message: `Created todo "${todo.title}"` }
}

function applySkill(s: SuggestionRow): ApplyResult {
  const p = s.proposal
  const name = str(p.name) ?? s.title
  const body = str(p.body)
  if (!body) return { ok: false, message: 'Proposal has no skill body' }
  const description = str(p.description) ?? s.rationale
  // Same on-disk format the skills gallery installs: frontmatter + markdown.
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
  // PERSISTENT, unlike a gallery install. The gallery's commands are wiped at
  // app exit because they exist to serve the session you just spawned; this
  // one the user deliberately accepted, and the inbox goes on reporting it as
  // "Installed" — a slash command that vanished on quit made that a lie.
  const commandName = installSkillCommand(name, content, { persistent: true })
  return { ok: true, message: `Installed skill as /${commandName} (kept across restarts; delete ~/.claude/commands/${commandName}.md to remove it)` }
}

function applyMemoryLink(s: SuggestionRow): ApplyResult {
  const from = str(s.proposal.from)
  const to = str(s.proposal.to)
  if (!from || !to) return { ok: false, message: 'Proposal is missing `from` or `to`' }
  const fromFile = from.endsWith('.md') ? from : `${from}.md`
  const toFile = to.endsWith('.md') ? to : `${to}.md`

  const note = readNote(fromFile)
  if (!note) return { ok: false, message: `Note "${fromFile}" not found` }
  if (!readNote(toFile)) return { ok: false, message: `Note "${toFile}" not found` }

  const link = filenameToWikilink(toFile)
  if (note.wikilinks.includes(link.replace(/^\[\[|\]\]$/g, ''))) {
    return { ok: true, message: 'The notes were already linked' }
  }

  // Write through the SAME helpers the memory IPC uses, so ## Related stays
  // auto-managed and the reverse backlink is created too.
  const before = note.wikilinks
  const raw = touchModified(addToRelatedSection(note.rawBody, link))
  writeNote(fromFile, raw)
  invalidate(fromFile)
  const updated = readNote(fromFile)
  if (updated) syncBacklinks(fromFile, before, updated.wikilinks)
  return { ok: true, message: `Linked ${fromFile} ↔ ${toFile}` }
}

function applyTodoCleanup(s: SuggestionRow): ApplyResult {
  const todoId = str(s.proposal.todoId)
  if (!todoId) return { ok: false, message: 'Proposal is missing `todoId`' }
  let todo
  try {
    todo = notesManager.readTodo(todoId)
  } catch {
    return { ok: false, message: 'That todo no longer exists' }
  }
  if (todo.done) return { ok: true, message: 'That todo was already closed' }
  notesManager.updateTodo(todoId, { done: true })
  return { ok: true, message: `Closed todo "${todo.title}"` }
}

/**
 * Dismissing feeds back into the pattern table so the same observation decays
 * instead of resurfacing: 'dismissed' returns the pattern to the candidate pool
 * but the suggestion history blocks a re-proposal, while 'never' mutes it
 * permanently.
 */
export function feedbackToPattern(patternId: string | null, verdict: 'dismissed' | 'never'): void {
  if (!patternId) return
  setPatternStatus(patternId, verdict === 'never' ? 'muted' : 'candidate')
}

/** Where an accepted scheduled-task proposal lands when it names no project. */
export function defaultProjectPathFrom(baseProjectsDir: string | null, project: string | null): string | null {
  if (!baseProjectsDir) return null
  return project ? join(baseProjectsDir, project) : baseProjectsDir
}
