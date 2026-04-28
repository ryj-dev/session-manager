/**
 * Electron-aware glue for embeddings: resolves DB + model paths and exposes
 * helpers used by the watcher, bootstrap, and IPC layers.
 *
 * On startup the model is fetched lazily via model-loader (bundled copy if
 * present, otherwise downloaded into userData). Indexing/search calls made
 * before the model is ready wait on a single shared promise.
 */

import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import {
  initEmbeddings,
  isEmbeddingsAvailable,
  indexNote as embedIndexNote,
  removeNote as embedRemoveNote,
  isFresh
} from './embeddings'
import { getMemoriesDir, readNote } from './store'
import { ensureModelAvailable } from './model-loader'

let initPromise: Promise<void> | null = null

export function initMemoryEmbeddings(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    const t0 = Date.now()
    try {
      console.log('[memory] resolving embedding model…')
      const modelPath = await ensureModelAvailable()
      const dbPath = path.join(app.getPath('userData'), 'memory-embeddings.db')
      initEmbeddings({ dbPath, modelPath })
      if (!isEmbeddingsAvailable()) {
        console.warn('[memory] semantic search disabled (init failed)')
      } else {
        console.log(`[memory] embeddings ready in ${Date.now() - t0}ms`)
      }
    } catch (err) {
      console.error('[memory] model unavailable — semantic search disabled:', err)
    }
  })()
  return initPromise
}

async function awaitInit(): Promise<void> {
  if (initPromise) return initPromise
}

export interface IndexProgress {
  done: number
  total: number
  filename?: string
}

export async function reindexAll(
  onProgress?: (p: IndexProgress) => void
): Promise<void> {
  await awaitInit()
  if (!isEmbeddingsAvailable()) return
  const dir = getMemoriesDir()
  if (!fs.existsSync(dir)) return
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))

  const t0 = Date.now()
  let done = 0
  let embedded = 0
  for (const filename of files) {
    try {
      const fullPath = path.join(dir, filename)
      const stat = fs.statSync(fullPath)
      const mtime = Math.floor(stat.mtimeMs)
      if (!isFresh(filename, mtime)) {
        const note = readNote(filename)
        if (note) {
          await embedIndexNote(filename, note.rawBody, mtime)
          embedded++
        }
      }
    } catch (err) {
      console.error('[memory] reindex error for', filename, err)
    }
    done++
    onProgress?.({ done, total: files.length, filename })
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(
    `[memory] reindex done — scanned ${files.length}, embedded ${embedded} in ${dt}s`
  )
}

/** Reindex a single note by filename. Used by the watcher. */
export async function reindexNote(filename: string): Promise<void> {
  await awaitInit()
  if (!isEmbeddingsAvailable()) return
  const dir = getMemoriesDir()
  const fullPath = path.join(dir, filename)
  if (!fs.existsSync(fullPath)) {
    embedRemoveNote(filename)
    return
  }
  try {
    const stat = fs.statSync(fullPath)
    const mtime = Math.floor(stat.mtimeMs)
    if (isFresh(filename, mtime)) return
    const note = readNote(filename)
    if (note) await embedIndexNote(filename, note.rawBody, mtime)
  } catch (err) {
    console.error('[memory] reindex error for', filename, err)
  }
}
