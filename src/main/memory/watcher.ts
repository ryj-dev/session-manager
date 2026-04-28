/**
 * File watcher for the memories directory.
 * Detects external changes (e.g. MCP server writes) and triggers index invalidation.
 */

import fs from 'fs'
import { getMemoriesDir } from './store'
import { invalidate } from './index'
import { reindexNote } from './embeddings-runtime'

let watcher: fs.FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const pendingChanges = new Set<string>()

const DEBOUNCE_MS = 200

export function startMemoryWatcher(): void {
  const dir = getMemoriesDir()

  try {
    watcher = fs.watch(dir, (eventType, filename) => {
      if (!filename || !filename.endsWith('.md')) return

      pendingChanges.add(filename)

      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        const changed = [...pendingChanges]
        pendingChanges.clear()

        for (const fn of changed) {
          invalidate(fn)
          // Fire-and-forget; embedding errors are logged inside.
          void reindexNote(fn)
        }
      }, DEBOUNCE_MS)
    })

    console.log('[memory] watcher started on', dir)
  } catch (err) {
    console.error('[memory] failed to start watcher:', err)
  }
}

export function stopMemoryWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (watcher) {
    watcher.close()
    watcher = null
    console.log('[memory] watcher stopped')
  }
}
