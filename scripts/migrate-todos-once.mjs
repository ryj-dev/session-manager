#!/usr/bin/env node
// One-shot migration: legacy notes/<project>/Agenda.todo.yaml (+ .md notes)
// → notes/todos/<id>.md with project tags. Moves legacy tree to notes/_legacy/.
// Safe to run only once — guarded by existence of notes/todos/.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import yaml from 'js-yaml'

const ROOT = process.argv[2] || path.join(os.homedir(), 'Library', 'Application Support', 'session-manager', 'notes')
const LEGACY_DIR = '_legacy'

function shortId() { return randomUUID().slice(0, 8) }
function nowIso() { return new Date().toISOString() }

function serializeTodo(t) {
  const fm = {
    id: t.id,
    title: t.title,
    done: t.done,
    tags: t.tags,
    created: t.created,
    updated: t.updated,
  }
  return `---\n${yaml.dump(fm, { lineWidth: 0, noRefs: true }).trimEnd()}\n---\n\n${t.body}`
}

const todosPath = path.join(ROOT, 'todos')
if (fs.existsSync(todosPath)) {
  console.error(`Refusing to run: ${todosPath} already exists.`)
  process.exit(1)
}

const entries = fs.readdirSync(ROOT, { withFileTypes: true })
const projectDirs = entries.filter((e) => e.isDirectory() && e.name !== 'todos' && e.name !== LEGACY_DIR && !e.name.startsWith('.'))

fs.mkdirSync(todosPath, { recursive: true })

let agendaItems = 0
let mdNotes = 0
const usedIds = new Set()

function uniqueId(seed) {
  let id = seed && /^[a-zA-Z0-9_-]+$/.test(seed) ? seed : shortId()
  while (usedIds.has(id) || fs.existsSync(path.join(todosPath, `${id}.md`))) {
    id = shortId()
  }
  usedIds.add(id)
  return id
}

function walk(dir, projectName) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, projectName)
      continue
    }
    const projectTag = `project:${projectName}`
    if (entry.name.endsWith('.todo.yaml')) {
      try {
        const raw = fs.readFileSync(full, 'utf-8')
        const parsed = yaml.load(raw)
        if (parsed && Array.isArray(parsed.todos)) {
          for (const item of parsed.todos) {
            if (!item || typeof item !== 'object') continue
            const id = uniqueId(item.id)
            const created = typeof item.created === 'string' ? item.created : nowIso()
            const updated = typeof item.updated === 'string' ? item.updated : created
            const todo = {
              id,
              title: typeof item.text === 'string' ? item.text : '(untitled)',
              body: '',
              done: item.status === 'completed',
              tags: [projectTag],
              created,
              updated,
            }
            fs.writeFileSync(path.join(todosPath, `${id}.md`), serializeTodo(todo))
            agendaItems++
          }
        }
      } catch (err) {
        console.warn('failed to parse', full, err.message)
      }
    } else if (entry.name.endsWith('.md')) {
      try {
        const raw = fs.readFileSync(full, 'utf-8')
        const baseName = entry.name.replace(/\.md$/, '')
        const id = uniqueId()
        const stat = fs.statSync(full)
        const todo = {
          id,
          title: baseName,
          body: raw,
          done: false,
          tags: [projectTag],
          created: stat.birthtime.toISOString(),
          updated: stat.mtime.toISOString(),
        }
        fs.writeFileSync(path.join(todosPath, `${id}.md`), serializeTodo(todo))
        mdNotes++
      } catch (err) {
        console.warn('failed to read', full, err.message)
      }
    }
  }
}

for (const dir of projectDirs) {
  walk(path.join(ROOT, dir.name), dir.name)
}

const legacyDest = path.join(ROOT, LEGACY_DIR)
fs.mkdirSync(legacyDest, { recursive: true })
for (const dir of projectDirs) {
  const from = path.join(ROOT, dir.name)
  const to = path.join(legacyDest, dir.name)
  try { fs.renameSync(from, to) }
  catch (err) { console.warn('failed to move', from, '→', to, err.message) }
}

console.log(`✓ migrated ${agendaItems} agenda items + ${mdNotes} notes → ${todosPath}`)
console.log(`  legacy tree at ${legacyDest}`)
