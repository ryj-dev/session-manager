/**
 * Notes & Todo storage manager.
 *
 * Layout under Electron userData:
 *   notes/
 *     <project-name>/
 *       <note>.md              — free-form markdown note
 *       <list>.todo.yaml       — structured todo list
 *       <subdir>/...           — nested dirs allowed
 *     <root-level>.md          — notes outside any project folder
 *
 * Folder name = project identifier. Moving a file between folders changes its project.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import { randomUUID } from 'crypto'
import { atomicWriteSync } from './atomic-write'

export type TodoStatus = 'not-started' | 'agent-todo' | 'in-progress' | 'completed'

export const TODO_STATUSES: TodoStatus[] = ['not-started', 'agent-todo', 'in-progress', 'completed']

export interface TodoItem {
  id: string
  text: string
  status: TodoStatus
  created: string
  updated?: string
  /** Session ID this todo is assigned to (or null = unassigned). */
  assignee?: string | null
  /** Human-readable label for the assignee at assignment time (for display if the session is gone). */
  assigneeLabel?: string | null
}

export interface TodoListFile {
  type: 'todo-list'
  title: string
  created: string
  updated: string
  todos: TodoItem[]
}

/** Summary of a note/todo-list for listing. */
export interface NoteEntry {
  /** Path relative to notes root, using forward slashes. E.g. "session-manager/Bugs.todo.yaml" */
  relPath: string
  /** Basename including extension. */
  name: string
  /** Project name (first path segment), or null for root-level files. */
  project: string | null
  /** Subdir segments between project and file. Empty if file is directly in project/root. */
  subdir: string[]
  kind: 'note' | 'todo-list'
}

export interface DirEntry {
  relPath: string
  name: string
  project: string | null
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

/** Explicitly set the notes root (called from main on startup). */
export function setNotesRoot(dir: string): void {
  notesRoot = dir
  fs.mkdirSync(dir, { recursive: true })
}

function toRel(p: string): string {
  return p.split(path.sep).join('/')
}

function fromRel(rel: string): string {
  // Block path traversal
  const normalized = path.posix.normalize(rel).replace(/^\/+/, '')
  if (normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error(`Invalid path: ${rel}`)
  }
  return path.join(getNotesRoot(), ...normalized.split('/'))
}

function classify(name: string): 'note' | 'todo-list' | null {
  if (name.endsWith('.todo.yaml')) return 'todo-list'
  if (name.endsWith('.md')) return 'note'
  return null
}

function entryFromRel(rel: string): NoteEntry | null {
  const kind = classify(path.basename(rel))
  if (!kind) return null
  const parts = rel.split('/')
  const name = parts[parts.length - 1]
  if (parts.length === 1) {
    return { relPath: rel, name, project: null, subdir: [], kind }
  }
  const project = parts[0]
  const subdir = parts.slice(1, -1)
  return { relPath: rel, name, project, subdir, kind }
}

function nowIso(): string {
  return new Date().toISOString()
}

function shortId(): string {
  return randomUUID().slice(0, 8)
}

/** Sanitize a filename segment — allow alnum, dash, dot, space, underscore. */
function sanitizeFilename(name: string): string {
  return name.trim().replace(/[/\\:*?"<>|]/g, '-').slice(0, 200)
}

// ── Public API ──────────────────────────────────────────────────────────────

function manualMarkerPath(project: string): string {
  return path.join(getNotesRoot(), project, '.manual')
}

export function ensureProject(project: string, opts?: { manual?: boolean }): void {
  const safe = sanitizeFilename(project)
  if (!safe) throw new Error('Invalid project name')
  fs.mkdirSync(path.join(getNotesRoot(), safe), { recursive: true })
  if (opts?.manual) {
    try { fs.writeFileSync(manualMarkerPath(safe), '', 'utf-8') } catch { /* best-effort */ }
  }
  // Every folio has exactly one pinned agenda. Create it if missing.
  getOrCreateAgenda(safe)
}

/** Canonical filename for the single pinned agenda per folio. */
export const AGENDA_FILENAME = 'Agenda.todo.yaml'

/** Ensure a project has its pinned agenda. Idempotent. Returns relPath. */
export function getOrCreateAgenda(project: string): string {
  const rel = `${project}/${AGENDA_FILENAME}`
  const full = fromRel(rel)
  if (!fs.existsSync(full)) {
    fs.mkdirSync(path.dirname(full), { recursive: true })
    writeTodoList(rel, {
      type: 'todo-list',
      title: 'Agenda',
      created: nowIso(),
      updated: nowIso(),
      todos: [],
    })
  }
  return rel
}

export function isManualProject(project: string): boolean {
  try { return fs.existsSync(manualMarkerPath(project)) } catch { return false }
}

export interface ProjectInfo {
  name: string
  manual: boolean
}

export function listProjects(): string[] {
  const root = getNotesRoot()
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
}

export function listProjectsDetailed(): ProjectInfo[] {
  return listProjects().map((name) => ({ name, manual: isManualProject(name) }))
}

/** Walk the notes root and return all notes + todo lists. */
export function listAllEntries(): NoteEntry[] {
  const root = getNotesRoot()
  if (!fs.existsSync(root)) return []
  const out: NoteEntry[] = []

  function walk(dir: string, relParts: string[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const fullPath = path.join(dir, entry.name)
      const relPath = [...relParts, entry.name].join('/')
      if (entry.isDirectory()) {
        walk(fullPath, [...relParts, entry.name])
      } else {
        const e = entryFromRel(relPath)
        if (e) out.push(e)
      }
    }
  }
  walk(root, [])
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath))
}

/** List sub-directories within the notes tree (excludes project roots). */
export function listAllDirs(): DirEntry[] {
  const root = getNotesRoot()
  if (!fs.existsSync(root)) return []
  const out: DirEntry[] = []

  function walk(dir: string, relParts: string[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue
      const relPath = [...relParts, entry.name].join('/')
      // Skip the project-level dir itself; we record sub-dirs inside.
      if (relParts.length > 0) {
        out.push({ relPath, name: entry.name, project: relParts[0] })
      }
      walk(path.join(dir, entry.name), [...relParts, entry.name])
    }
  }
  walk(root, [])
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath))
}

export function readNote(relPath: string): string {
  const full = fromRel(relPath)
  return fs.readFileSync(full, 'utf-8')
}

export function writeNote(relPath: string, content: string): void {
  const full = fromRel(relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  atomicWriteSync(full, content)
}

export function readTodoList(relPath: string): TodoListFile {
  const raw = fs.readFileSync(fromRel(relPath), 'utf-8')
  const parsed = yaml.load(raw) as Partial<TodoListFile> | null
  if (!parsed || typeof parsed !== 'object') {
    return { type: 'todo-list', title: path.basename(relPath, '.todo.yaml'), created: nowIso(), updated: nowIso(), todos: [] }
  }
  return {
    type: 'todo-list',
    title: parsed.title ?? path.basename(relPath, '.todo.yaml'),
    created: parsed.created ?? nowIso(),
    updated: parsed.updated ?? nowIso(),
    todos: Array.isArray(parsed.todos) ? parsed.todos.filter((t) => t && typeof t === 'object' && t.id) as TodoItem[] : [],
  }
}

export function writeTodoList(relPath: string, data: TodoListFile): void {
  const full = fromRel(relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  const serialized = yaml.dump(data, { lineWidth: 0, noRefs: true })
  atomicWriteSync(full, serialized)
}

/** Create a note (or todo-list). Returns the relPath actually used (after collision suffixing). */
export function createNote(opts: {
  project: string | null
  subdir?: string[]
  name: string
  kind: 'note' | 'todo-list'
  content?: string
}): string {
  const { project, subdir = [], name, kind, content } = opts
  if (project) ensureProject(project)

  const ext = kind === 'note' ? '.md' : '.todo.yaml'
  const baseName = sanitizeFilename(name).replace(/\.md$|\.todo\.yaml$/i, '')
  if (!baseName) throw new Error('Invalid note name')

  const dirParts = [project, ...subdir].filter(Boolean) as string[]
  const dirRel = dirParts.join('/')
  fs.mkdirSync(dirParts.length ? fromRel(dirRel) : getNotesRoot(), { recursive: true })

  let finalName = `${baseName}${ext}`
  let suffix = 1
  while (fs.existsSync(fromRel(dirRel ? `${dirRel}/${finalName}` : finalName))) {
    finalName = `${baseName} ${++suffix}${ext}`
    if (suffix > 999) throw new Error('Too many name collisions')
  }
  const rel = dirRel ? `${dirRel}/${finalName}` : finalName

  if (kind === 'note') {
    writeNote(rel, content ?? `# ${baseName}\n\n`)
  } else {
    writeTodoList(rel, { type: 'todo-list', title: baseName, created: nowIso(), updated: nowIso(), todos: [] })
  }
  return rel
}

export function createDir(project: string | null, subdirParts: string[]): string {
  const parts = [project, ...subdirParts].filter(Boolean) as string[]
  if (parts.length === 0) throw new Error('Cannot create dir at notes root')
  const rel = parts.join('/')
  fs.mkdirSync(fromRel(rel), { recursive: true })
  return rel
}

export function moveEntry(fromRelPath: string, toRelPath: string): void {
  const fromFull = fromRel(fromRelPath)
  const toFull = fromRel(toRelPath)
  if (!fs.existsSync(fromFull)) throw new Error(`Not found: ${fromRelPath}`)
  if (fs.existsSync(toFull)) throw new Error(`Destination exists: ${toRelPath}`)
  fs.mkdirSync(path.dirname(toFull), { recursive: true })
  fs.renameSync(fromFull, toFull)
}

export function deleteEntry(relPath: string): void {
  const full = fromRel(relPath)
  if (!fs.existsSync(full)) return
  const stat = fs.statSync(full)
  if (stat.isDirectory()) {
    fs.rmSync(full, { recursive: true, force: true })
  } else {
    fs.unlinkSync(full)
  }
}

// ── Todo item operations ────────────────────────────────────────────────────

export function addTodo(listRelPath: string, text: string): TodoItem {
  const list = readTodoList(listRelPath)
  const item: TodoItem = { id: shortId(), text, status: 'not-started', created: nowIso() }
  list.todos.push(item)
  list.updated = nowIso()
  writeTodoList(listRelPath, list)
  return item
}

export function setTodoStatus(listRelPath: string, todoId: string, status: TodoStatus): void {
  const list = readTodoList(listRelPath)
  const t = list.todos.find((x) => x.id === todoId)
  if (!t) throw new Error(`Todo not found: ${todoId}`)
  t.status = status
  t.updated = nowIso()
  list.updated = nowIso()
  writeTodoList(listRelPath, list)
}

export function setTodoAssignee(
  listRelPath: string,
  todoId: string,
  assignee: string | null,
  assigneeLabel?: string | null,
): void {
  const list = readTodoList(listRelPath)
  const t = list.todos.find((x) => x.id === todoId)
  if (!t) throw new Error(`Todo not found: ${todoId}`)
  t.assignee = assignee
  t.assigneeLabel = assignee ? (assigneeLabel ?? null) : null
  t.updated = nowIso()
  list.updated = nowIso()
  writeTodoList(listRelPath, list)
}

export function updateTodoText(listRelPath: string, todoId: string, text: string): void {
  const list = readTodoList(listRelPath)
  const t = list.todos.find((x) => x.id === todoId)
  if (!t) throw new Error(`Todo not found: ${todoId}`)
  t.text = text
  t.updated = nowIso()
  list.updated = nowIso()
  writeTodoList(listRelPath, list)
}

export function removeTodo(listRelPath: string, todoId: string): void {
  const list = readTodoList(listRelPath)
  list.todos = list.todos.filter((x) => x.id !== todoId)
  list.updated = nowIso()
  writeTodoList(listRelPath, list)
}

export interface AggregatedTodo {
  listRelPath: string
  listTitle: string
  project: string | null
  todo: TodoItem
}

/** Flatten todos across all (or one project's) todo-lists for the global view. */
export function listAllTodos(filter?: {
  project?: string
  status?: TodoStatus
  assignee?: string | null
}): AggregatedTodo[] {
  const entries = listAllEntries().filter((e) => e.kind === 'todo-list')
  const out: AggregatedTodo[] = []
  for (const e of entries) {
    if (filter?.project && e.project !== filter.project) continue
    let list: TodoListFile
    try { list = readTodoList(e.relPath) } catch { continue }
    for (const t of list.todos) {
      if (filter?.status && t.status !== filter.status) continue
      if (filter && 'assignee' in filter) {
        if (filter.assignee === null && t.assignee) continue
        if (typeof filter.assignee === 'string' && t.assignee !== filter.assignee) continue
      }
      out.push({ listRelPath: e.relPath, listTitle: list.title, project: e.project, todo: t })
    }
  }
  return out
}

// ── Search ──────────────────────────────────────────────────────────────────

export interface SearchHit {
  relPath: string
  kind: 'note' | 'todo-list'
  project: string | null
  snippet: string
}

export function searchNotes(query: string): SearchHit[] {
  const q = query.toLowerCase()
  if (!q) return []
  const hits: SearchHit[] = []
  for (const e of listAllEntries()) {
    try {
      if (e.kind === 'note') {
        const content = readNote(e.relPath)
        if (content.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)) {
          const idx = content.toLowerCase().indexOf(q)
          const snippet = idx >= 0
            ? content.slice(Math.max(0, idx - 30), idx + q.length + 30).replace(/\s+/g, ' ')
            : e.name
          hits.push({ relPath: e.relPath, kind: e.kind, project: e.project, snippet })
        }
      } else {
        const list = readTodoList(e.relPath)
        const matches: string[] = []
        if (list.title.toLowerCase().includes(q)) matches.push(list.title)
        for (const t of list.todos) {
          if (t.text.toLowerCase().includes(q)) matches.push(t.text)
        }
        if (matches.length || e.name.toLowerCase().includes(q)) {
          hits.push({ relPath: e.relPath, kind: e.kind, project: e.project, snippet: matches[0] ?? e.name })
        }
      }
    } catch { /* skip unreadable */ }
  }
  return hits
}

// ── Watcher ─────────────────────────────────────────────────────────────────

let watcher: fs.FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let notifyCb: (() => void) | null = null

export function startNotesWatcher(onChange: () => void): void {
  notifyCb = onChange
  const root = getNotesRoot()
  try {
    watcher = fs.watch(root, { recursive: true }, () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        notifyCb?.()
      }, 150)
    })
    console.log('[notes] watcher started on', root)
  } catch (err) {
    console.error('[notes] watcher failed:', err)
  }
}

export function stopNotesWatcher(): void {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
  if (watcher) { watcher.close(); watcher = null }
  notifyCb = null
}

/** Map a filesystem path (e.g. a session cwd) to a project folder name. */
export function projectFromCwd(cwd: string): string {
  return sanitizeFilename(path.basename(cwd) || 'untitled')
}
