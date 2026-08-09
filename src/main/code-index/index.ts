/**
 * Code index wiring — the only electron-aware module in code-index/.
 *
 * Owns lifecycle: DB init, segmenter grammar dir, the startup discovery+index
 * pass, and the observer quiet-time embedding backfill job. Everything is
 * gated on the experimental `codeIndex.enabled` setting; when disabled this
 * module never opens the DB, and queries report "disabled" via status.
 */

import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { loadSettings } from '../settings-store'
import { listRegistry } from '../session-registry'
import { registerJob } from '../observer/jobs'
import { initCodeIndexDb, closeCodeIndexDb, deleteCodeIndexDb, dbStats } from './db'
import { configureSegmenter } from './segment'
import { runDiscoveryAndIndex, embedBackfillBatch, isIndexing, type DiscoveryOpts } from './indexer'

export { dbStats as codeIndexDbStats } from './db'
export { isIndexing } from './indexer'

let started = false

export function isCodeIndexEnabled(): boolean {
  return loadSettings().codeIndex.enabled
}

function discoveryOpts(force?: boolean): DiscoveryOpts {
  const s = loadSettings()
  return {
    baseProjectsDir: s.baseProjectsDir,
    sessionCwds: listRegistry().map((e) => e.projectPath),
    excludedRepos: s.codeIndex.excludedRepos,
    maxFileBytes: s.codeIndex.maxFileKb * 1024,
    maxFiles: s.codeIndex.maxFilesPerRepo,
    force
  }
}

function sendProgress(p: { repo: string; done: number; total: number }): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.send('code-index:progress', p)
}

/**
 * Idempotent: safe to call at app start and again when the setting flips on
 * (settings:save). Does nothing while the feature is disabled.
 */
export function initCodeIndex(): void {
  if (started || !isCodeIndexEnabled()) return
  started = true

  initCodeIndexDb(join(app.getPath('userData'), 'code-index.db'))
  const resourcesBase = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
  configureSegmenter(join(resourcesBase, 'tree-sitter'))

  // Embedding backfill drains one quiet-gated batch per tick while a backlog
  // remains (returning false keeps the debt — same drain pattern as mining).
  registerJob({
    id: 'code-embed-backfill',
    everyHours: 0.5,
    quietMs: 120_000,
    run: async () => {
      if (!isCodeIndexEnabled()) return undefined
      const r = await embedBackfillBatch(400)
      return r === 'more' ? false : undefined
    }
  })

  // Symbol+FTS pass — usable within seconds; embeddings follow in the background.
  void runDiscoveryAndIndex(discoveryOpts(), sendProgress).catch((err) => {
    console.error('[code-index] startup indexing failed:', err)
  })
}

/** Cleanup-panel "reindex": full re-walk, hash-gated (force skips nothing). */
export async function reindexAllRepos(force = false): Promise<void> {
  if (!isCodeIndexEnabled()) return
  initCodeIndex()
  await runDiscoveryAndIndex(discoveryOpts(force), sendProgress)
}

/** Cleanup-panel delete: drop the whole index; re-created on next enable. */
export function deleteCodeIndex(): { bytes: number } {
  const result = deleteCodeIndexDb()
  started = false
  return result
}

export function shutdownCodeIndex(): void {
  closeCodeIndexDb()
  started = false
}

export function codeIndexStatusSummary(): {
  enabled: boolean
  indexing: boolean
  stats: ReturnType<typeof dbStats>
} {
  return { enabled: isCodeIndexEnabled(), indexing: isIndexing(), stats: dbStats() }
}
