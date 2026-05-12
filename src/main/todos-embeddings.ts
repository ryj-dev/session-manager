/**
 * Semantic indexing for todos. Reuses the memory embeddings module + DB —
 * todo entries are namespaced in the chunk_meta table with a `todo:<id>` key
 * so they live alongside memory notes without collision.
 *
 * Indexing is fire-and-forget; if the model isn't ready or fails, todos still
 * work via substring search.
 */

import {
  indexNote as embedIndexNote,
  removeNote as embedRemoveNote,
  isEmbeddingsAvailable,
  searchSemantic,
  type SemanticHit,
} from './memory/embeddings'
import { listTodos, type Todo } from './notes-manager'

const TODO_PREFIX = 'todo:'

/** Stable cosine-distance threshold above which semantic hits are discarded. */
export const SEMANTIC_DISTANCE_THRESHOLD = 0.8

function keyFor(id: string): string {
  return `${TODO_PREFIX}${id}`
}

function idFromKey(key: string): string | null {
  return key.startsWith(TODO_PREFIX) ? key.slice(TODO_PREFIX.length) : null
}

function corpusFor(todo: Todo): string {
  // Title is weighted by repeating it once at the head — keeps title matches
  // ranked above body-only matches without separate per-field embeddings.
  const tagLine = todo.tags.length ? `Tags: ${todo.tags.join(', ')}\n` : ''
  return `${todo.title}\n${todo.title}\n${tagLine}${todo.body}`.trim()
}

export async function indexTodo(todo: Todo): Promise<void> {
  if (!isEmbeddingsAvailable()) return
  try {
    const mtime = Date.parse(todo.updated) || Date.now()
    await embedIndexNote(keyFor(todo.id), corpusFor(todo), mtime)
  } catch (err) {
    console.error('[todos:embed] index failed for', todo.id, err)
  }
}

export function removeTodoFromIndex(id: string): void {
  if (!isEmbeddingsAvailable()) return
  try {
    embedRemoveNote(keyFor(id))
  } catch (err) {
    console.error('[todos:embed] remove failed for', id, err)
  }
}

/** Reindex every todo. Call once on startup after the model is ready. */
export async function reindexAllTodos(): Promise<void> {
  if (!isEmbeddingsAvailable()) return
  const t0 = Date.now()
  const todos = listTodos()
  let embedded = 0
  for (const todo of todos) {
    try {
      await indexTodo(todo)
      embedded++
    } catch (err) {
      console.error('[todos:embed] reindex error for', todo.id, err)
    }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`[todos:embed] reindex done — ${embedded}/${todos.length} in ${dt}s`)
}

export interface TodoSemanticHit {
  id: string
  distance: number
}

/**
 * Semantic search for todos. Returns ids ranked by ascending distance,
 * filtered by the configured threshold (drops likely-junk results).
 */
export async function searchTodosSemantic(
  query: string,
  limit: number = 50,
): Promise<TodoSemanticHit[]> {
  if (!isEmbeddingsAvailable()) return []
  if (!query.trim()) return []
  const hits: SemanticHit[] = await searchSemantic(query, limit * 4) // overfetch — many results will be memory notes
  const seen = new Set<string>()
  const out: TodoSemanticHit[] = []
  for (const h of hits) {
    const id = idFromKey(h.filename)
    if (!id) continue
    if (h.distance > SEMANTIC_DISTANCE_THRESHOLD) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, distance: h.distance })
    if (out.length >= limit) break
  }
  return out
}
