/**
 * Todo storage manager.
 *
 * Layout under Electron userData:
 *   notes/todos/<id>.md — one file per todo; YAML frontmatter + markdown body
 *
 * Frontmatter: id, title, done, tags, created, updated.
 * Project membership is conveyed by a `project:<name>` tag.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import matter from 'gray-matter'
import { randomUUID } from 'crypto'
import { atomicWriteSync } from './atomic-write'

// Optional dependency on the semantic indexer — pulled in lazily to avoid a
// hard cycle (todos-embeddings imports listTodos from this module).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedHooks: any = null
export function setEmbedHooks(hooks: {
  index: (todo: Todo) => Promise<void>
  remove: (id: string) => void
  searchSemantic: (query: string, limit?: number) => Promise<Array<{ id: string; distance: number }>>
}): void {
  embedHooks = hooks
}

// Note: data migration from the old per-project layout was performed once via
// `scripts/migrate-todos-once.mjs`. New installs simply start with an empty
// `notes/todos/` directory.

export interface Todo {
  id: string
  title: string
  body: string
  done: boolean
  /** Free-form tags. The `project:<name>` prefix is a convention used by the UI and hook server. */
  tags: string[]
  created: string
  updated: string
}

export interface TodoSummary {
  id: string
  title: string
  done: boolean
  tags: string[]
  created: string
  updated: string
}

export interface TodoFilter {
  /**
   * Tag filter with split semantics:
   * - `project:*` tags use OR among themselves (a todo matches if it has at least one).
   * - All other tags use AND (a todo must have every one).
   * - The two groups AND with each other.
   *
   * A single todo carries at most one project tag in practice, so AND across projects
   * would be self-defeating.
   */
  tags?: string[]
  done?: boolean
  /** Case-insensitive substring match against title + body. */
  search?: string
}

let notesRoot: string | null = null

function defaultNotesRoot(): string {
  if (process.env.SM_NOTES_DIR) return process.env.SM_NOTES_DIR
  const dataDir = process.env.SM_DATA_DIR || (
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'session-manager')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'session-manager')
        : path.join(os.homedir(), '.config', 'session-manager')
  )
  return path.join(dataDir, 'notes')
}

function getNotesRoot(): string {
  if (!notesRoot) {
    notesRoot = defaultNotesRoot()
    fs.mkdirSync(notesRoot, { recursive: true })
  }
  return notesRoot
}

function todosDir(): string {
  const dir = path.join(getNotesRoot(), 'todos')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Explicitly set the notes root (called from main on startup). */
export function setNotesRoot(dir: string): void {
  notesRoot = dir
  fs.mkdirSync(dir, { recursive: true })
}

function nowIso(): string {
  return new Date().toISOString()
}

function shortId(): string {
  return randomUUID().slice(0, 8)
}

function sanitizeFilename(name: string): string {
  return name.trim().replace(/[/\\:*?"<>|]/g, '-').slice(0, 200)
}

function todoPath(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid todo id: ${id}`)
  return path.join(todosDir(), `${id}.md`)
}

function serializeTodo(t: Todo): string {
  const fm = {
    id: t.id,
    title: t.title,
    done: t.done,
    tags: t.tags,
    created: t.created,
    updated: t.updated,
  }
  const yamlStr = yaml.dump(fm, { lineWidth: 0, noRefs: true }).trimEnd()
  return `---\n${yamlStr}\n---\n\n${t.body}`
}

function parseTodoFile(raw: string, fallbackId: string): Todo | null {
  try {
    const parsed = matter(raw)
    const data = (parsed.data || {}) as Partial<Todo>
    const id = typeof data.id === 'string' && data.id ? data.id : fallbackId
    const title = typeof data.title === 'string' ? data.title : ''
    const done = data.done === true
    const tags = Array.isArray(data.tags) ? data.tags.filter((t) => typeof t === 'string') as string[] : []
    const created = typeof data.created === 'string' ? data.created : nowIso()
    const updated = typeof data.updated === 'string' ? data.updated : created
    return {
      id, title, done, tags, created, updated,
      body: parsed.content.replace(/^\n+/, ''),
    }
  } catch {
    return null
  }
}

function readTodoFile(id: string): Todo | null {
  const full = todoPath(id)
  if (!fs.existsSync(full)) return null
  const raw = fs.readFileSync(full, 'utf-8')
  return parseTodoFile(raw, id)
}

function writeTodoFile(t: Todo): void {
  atomicWriteSync(todoPath(t.id), serializeTodo(t))
}

// ── Public API ──────────────────────────────────────────────────────────────

export function readTodo(id: string): Todo {
  const t = readTodoFile(id)
  if (!t) throw new Error(`Todo not found: ${id}`)
  return t
}

export function createTodo(input: { title: string; body?: string; tags?: string[] }): Todo {
  let id = shortId()
  // Collision-avoid (vanishingly unlikely with uuid slice, but cheap)
  while (fs.existsSync(todoPath(id))) id = shortId()
  const now = nowIso()
  const t: Todo = {
    id,
    title: input.title ?? '',
    body: input.body ?? '',
    done: false,
    tags: Array.isArray(input.tags) ? [...new Set(input.tags.filter(Boolean))] : [],
    created: now,
    updated: now,
  }
  writeTodoFile(t)
  void embedHooks?.index(t)
  return t
}

export function updateTodo(
  id: string,
  patch: Partial<Pick<Todo, 'title' | 'body' | 'done' | 'tags'>>,
): Todo {
  const t = readTodo(id)
  if (typeof patch.title === 'string') t.title = patch.title
  if (typeof patch.body === 'string') t.body = patch.body
  if (typeof patch.done === 'boolean') t.done = patch.done
  if (Array.isArray(patch.tags)) t.tags = [...new Set(patch.tags.filter((x) => typeof x === 'string' && x))]
  t.updated = nowIso()
  writeTodoFile(t)
  void embedHooks?.index(t)
  return t
}

export function deleteTodo(id: string): void {
  const full = todoPath(id)
  if (fs.existsSync(full)) fs.unlinkSync(full)
  embedHooks?.remove(id)
}

function allTodos(): Todo[] {
  const dir = todosDir()
  if (!fs.existsSync(dir)) return []
  const out: Todo[] = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md') || name.startsWith('.')) continue
    const id = name.slice(0, -3)
    const t = readTodoFile(id)
    if (t) out.push(t)
  }
  return out
}

export function listTodos(filter?: TodoFilter): Todo[] {
  let todos = allTodos()
  if (filter?.tags && filter.tags.length > 0) {
    const projectTags = filter.tags.filter((t) => t.startsWith('project:'))
    const otherTags = filter.tags.filter((t) => !t.startsWith('project:'))
    if (projectTags.length > 0) {
      todos = todos.filter((t) => projectTags.some((tag) => t.tags.includes(tag)))
    }
    if (otherTags.length > 0) {
      todos = todos.filter((t) => otherTags.every((tag) => t.tags.includes(tag)))
    }
  }
  if (typeof filter?.done === 'boolean') {
    todos = todos.filter((t) => t.done === filter.done)
  }
  if (filter?.search) {
    const q = filter.search.toLowerCase()
    todos = todos.filter((t) =>
      t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q),
    )
  }
  // Newest-updated first
  todos.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0))
  return todos
}

export function listTodosSummary(filter?: TodoFilter): TodoSummary[] {
  return listTodos(filter).map(({ body, ...rest }) => rest)
}

/**
 * Hybrid search: substring (title + body) + semantic, deduped, with substring
 * hits ranked first. Other filters (tags, done) apply equally to both halves.
 *
 * Returns summaries for the renderer / MCP.
 */
export async function searchTodosHybrid(
  query: string,
  filter?: Omit<TodoFilter, 'search'>,
): Promise<TodoSummary[]> {
  const q = query.trim()
  if (!q) return listTodosSummary(filter)

  // Substring half (already filtered by tags/done inside listTodos).
  const substring = listTodos({ ...filter, search: q })
  const substringIds = new Set(substring.map((t) => t.id))

  // Semantic half — fetch ids, then filter+order against current corpus.
  const semantic = embedHooks ? await embedHooks.searchSemantic(q, 30) : []
  const baseFiltered = listTodos(filter) // tag/done predicates applied
  const baseById = new Map(baseFiltered.map((t) => [t.id, t] as const))

  const out: Todo[] = [...substring]
  for (const hit of semantic) {
    if (substringIds.has(hit.id)) continue
    const t = baseById.get(hit.id)
    if (!t) continue
    out.push(t)
  }
  return out.map(({ body, ...rest }) => rest)
}

export function listAllTags(): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const t of allTodos()) {
    for (const tag of t.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag))
}

/** Map a filesystem path (e.g. a session cwd) to a project tag value. */
export function projectFromCwd(cwd: string): string {
  return sanitizeFilename(path.basename(cwd) || 'untitled')
}

/** Build the canonical project tag for a given cwd. */
export function projectTagFromCwd(cwd: string): string {
  return `project:${projectFromCwd(cwd)}`
}

// ── Watcher ─────────────────────────────────────────────────────────────────

let watcher: fs.FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let notifyCb: (() => void) | null = null

export function startNotesWatcher(onChange: () => void): void {
  notifyCb = onChange
  const dir = todosDir()
  try {
    watcher = fs.watch(dir, { recursive: false }, () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        notifyCb?.()
      }, 150)
    })
    console.log('[notes] watcher started on', dir)
  } catch (err) {
    console.error('[notes] watcher failed:', err)
  }
}

export function stopNotesWatcher(): void {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
  if (watcher) { watcher.close(); watcher = null }
  notifyCb = null
}
