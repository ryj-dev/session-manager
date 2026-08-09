/**
 * Index pipeline: walk → hash-gate → segment → single-transaction upsert.
 *
 * Two phases by design. Symbols + FTS land synchronously here (seconds to a
 * minute per repo, usable immediately); embeddings are backfilled later by
 * the observer's quiet-time job via embedBackfillBatch — the `embedded` flag
 * on chunks_meta is the resume cursor, so an app quit mid-backfill loses
 * nothing.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setImmediate as yieldTick } from 'node:timers/promises'
import {
  getDb,
  isCodeIndexDbAvailable,
  isFtsAvailable,
  nextChunkRowid
} from './db'
import { listRepoFiles, changedSince, headCommit, langForPath, type WalkedFile } from './walker'
import { discoverRepos, type DiscoveryInputs } from './discovery'
import { segmentFile } from './segment'
import { embedTexts, isEmbeddingsAvailable } from '../memory/embeddings'

export interface IndexProgress {
  repo: string
  done: number
  total: number
}

export interface RepoIndexResult {
  files: number
  skipped: number
  removed: number
}

/** Per-repo walk stats from the most recent pass (not persisted). */
const lastWalkStats = new Map<string, { skippedOversize: number }>()
export function walkStatsFor(root: string): { skippedOversize: number } | null {
  return lastWalkStats.get(root) ?? null
}

let indexing = false
export function isIndexing(): boolean {
  return indexing
}

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex')
}

/** Delete a file's rows from meta + fts + vec + symbols + files (sync, in txn). */
function deleteFileRows(fileId: number | bigint): void {
  const db = getDb()
  const chunkRows = db
    .prepare(`SELECT rowid, header, text FROM chunks_meta WHERE file_id = ?`)
    .all(fileId) as Array<{ rowid: number | bigint; header: string; text: string }>
  const delVec = db.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`)
  const delFts = isFtsAvailable()
    ? db.prepare(`INSERT INTO chunks_fts(chunks_fts, rowid, header, text) VALUES('delete', ?, ?, ?)`)
    : null
  for (const r of chunkRows) {
    delVec.run(BigInt(r.rowid))
    delFts?.run(r.rowid, r.header, r.text)
  }
  db.prepare(`DELETE FROM chunks_meta WHERE file_id = ?`).run(fileId)
  db.prepare(`DELETE FROM symbols WHERE file_id = ?`).run(fileId)
  db.prepare(`DELETE FROM files WHERE id = ?`).run(fileId)
}

export function removeFile(repoRoot: string, relPath: string): void {
  if (!isCodeIndexDbAvailable()) return
  const db = getDb()
  const row = db
    .prepare(`SELECT id FROM files WHERE repo_root = ? AND rel_path = ?`)
    .get(repoRoot, relPath) as { id: number } | undefined
  if (!row) return
  db.transaction(() => deleteFileRows(row.id))()
}

export function removeRepo(repoRoot: string): void {
  if (!isCodeIndexDbAvailable()) return
  const db = getDb()
  const files = db.prepare(`SELECT id FROM files WHERE repo_root = ?`).all(repoRoot) as Array<{
    id: number
  }>
  db.transaction(() => {
    for (const f of files) deleteFileRows(f.id)
    db.prepare(`DELETE FROM repos WHERE root = ?`).run(repoRoot)
  })()
  lastWalkStats.delete(repoRoot)
}

/** Index one file: returns false when skipped (unchanged hash). */
export async function indexFile(repoRoot: string, repoName: string, file: WalkedFile): Promise<boolean> {
  const db = getDb()
  let content: string
  try {
    content = fs.readFileSync(file.absPath, 'utf8')
  } catch {
    return false
  }
  const hash = sha1(content)
  const existing = db
    .prepare(`SELECT id, content_hash FROM files WHERE repo_root = ? AND rel_path = ?`)
    .get(repoRoot, file.relPath) as { id: number; content_hash: string } | undefined
  if (existing && existing.content_hash === hash) return false

  // Parse outside the transaction (async); writes are one synchronous txn.
  const { symbols, chunks } = await segmentFile(repoName, file.relPath, file.lang, content)

  db.transaction(() => {
    if (existing) deleteFileRows(existing.id)
    const fileId = db
      .prepare(
        `INSERT INTO files(repo_root, rel_path, content_hash, mtime, size, lang, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(repoRoot, file.relPath, hash, file.mtime, file.size, file.lang, Date.now())
      .lastInsertRowid
    const insSym = db.prepare(
      `INSERT INTO symbols(file_id, kind, name, signature, start_line, end_line, parent_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const symbolIds: Array<number | bigint> = []
    for (const s of symbols) {
      symbolIds.push(
        insSym.run(fileId, s.kind, s.name, s.signature, s.startLine, s.endLine, s.parentName)
          .lastInsertRowid
      )
    }
    const insChunk = db.prepare(
      `INSERT INTO chunks_meta(rowid, file_id, symbol_id, header, text, start_line, end_line, embedded)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    )
    const insFts = isFtsAvailable()
      ? db.prepare(`INSERT INTO chunks_fts(rowid, header, text) VALUES (?, ?, ?)`)
      : null
    for (const c of chunks) {
      const rowid = nextChunkRowid()
      const symbolId = c.symbolIdx !== null ? symbolIds[c.symbolIdx] : null
      insChunk.run(rowid, fileId, symbolId, c.header, c.text, c.startLine, c.endLine)
      insFts?.run(rowid, c.header, c.text)
    }
  })()
  return true
}

export async function indexRepo(
  repoRoot: string,
  opts: { force?: boolean; maxFileBytes: number; maxFiles: number },
  onProgress?: (p: IndexProgress) => void
): Promise<RepoIndexResult> {
  const db = getDb()
  const name = path.basename(repoRoot)
  const head = headCommit(repoRoot)

  db.prepare(
    `INSERT INTO repos(root, name) VALUES (?, ?)
     ON CONFLICT(root) DO UPDATE SET name = excluded.name`
  ).run(repoRoot, name)
  const repoRow = db.prepare(`SELECT indexed_at, head_commit FROM repos WHERE root = ?`).get(repoRoot) as {
    indexed_at: number | null
    head_commit: string | null
  }

  // Incremental fast path: HEAD unchanged since last completed pass — only
  // working-tree changes (staged/unstaged/untracked) can be stale.
  const canIncremental =
    !opts.force && repoRow.indexed_at !== null && repoRow.head_commit !== null && repoRow.head_commit === head
  if (canIncremental) {
    const changed = changedSince(repoRoot)
    if (changed !== null) {
      let files = 0
      let removed = 0
      for (const relPath of new Set(changed)) {
        const absPath = path.join(repoRoot, relPath)
        let st: fs.Stats | null = null
        try {
          st = fs.statSync(absPath)
        } catch {
          st = null
        }
        if (!st || !st.isFile()) {
          removeFile(repoRoot, relPath)
          removed++
          continue
        }
        const lang = langForPath(relPath)
        if (lang === null) continue
        if (st.size > opts.maxFileBytes) continue
        const walked: WalkedFile = {
          relPath,
          absPath,
          size: st.size,
          mtime: Math.floor(st.mtimeMs),
          lang
        }
        if (await indexFile(repoRoot, name, walked)) files++
        await yieldTick()
      }
      db.prepare(`UPDATE repos SET indexed_at = ? WHERE root = ?`).run(Date.now(), repoRoot)
      return { files, skipped: 0, removed }
    }
    // git status failed — fall through to the full pass
  }

  // Full pass: hash-gated per file, removes rows for files no longer listed.
  const walk = listRepoFiles(repoRoot, { maxFileBytes: opts.maxFileBytes, maxFiles: opts.maxFiles })
  lastWalkStats.set(repoRoot, { skippedOversize: walk.skippedOversize })

  const listed = new Set(walk.files.map((f) => f.relPath))
  const known = db.prepare(`SELECT id, rel_path FROM files WHERE repo_root = ?`).all(repoRoot) as Array<{
    id: number
    rel_path: string
  }>
  let removed = 0
  for (const k of known) {
    if (!listed.has(k.rel_path)) {
      db.transaction(() => deleteFileRows(k.id))()
      removed++
    }
  }

  let files = 0
  let skipped = 0
  let done = 0
  for (const file of walk.files) {
    if (await indexFile(repoRoot, name, file)) files++
    else skipped++
    done++
    if (done % 25 === 0) onProgress?.({ repo: name, done, total: walk.files.length })
    await yieldTick() // keep the main-process event loop responsive
  }
  onProgress?.({ repo: name, done, total: walk.files.length })

  db.prepare(`UPDATE repos SET indexed_at = ?, head_commit = ?, truncated = ? WHERE root = ?`).run(
    Date.now(),
    head,
    walk.truncated ? 1 : 0,
    repoRoot
  )
  return { files, skipped, removed }
}

export interface DiscoveryOpts extends DiscoveryInputs {
  maxFileBytes: number
  maxFiles: number
  force?: boolean
}

/** App-start / reindex entry: discover repos, index each, drop excluded ones. */
export async function runDiscoveryAndIndex(
  opts: DiscoveryOpts,
  onProgress?: (p: IndexProgress) => void
): Promise<void> {
  if (!isCodeIndexDbAvailable() || indexing) return
  indexing = true
  try {
    const repos = discoverRepos(opts)
    const discovered = new Set(repos.map((r) => r.root))

    // Excluded/vanished repos must not linger in fleet results.
    const db = getDb()
    const knownRepos = db.prepare(`SELECT root FROM repos`).all() as Array<{ root: string }>
    for (const { root } of knownRepos) {
      const excluded = opts.excludedRepos.some((e) => e === root)
      const gone = !fs.existsSync(root)
      if (excluded || (gone && !discovered.has(root))) removeRepo(root)
    }

    for (const repo of repos) {
      try {
        await indexRepo(
          repo.root,
          { force: opts.force, maxFileBytes: opts.maxFileBytes, maxFiles: opts.maxFiles },
          onProgress
        )
      } catch (err) {
        console.warn(`[code-index] indexing failed for ${repo.root}:`, err)
      }
    }
  } finally {
    indexing = false
  }
}

// ─── Embedding backfill ─────────────────────────────────────────────────────

/**
 * Embed up to `maxChunks` pending chunks. Runs on the observer's quiet-time
 * job. Returns 'more' while a backlog remains so the job keeps its debt and
 * re-fires next quiet tick.
 */
export async function embedBackfillBatch(maxChunks: number): Promise<'done' | 'more' | 'unavailable'> {
  if (!isCodeIndexDbAvailable()) return 'unavailable'
  if (!isEmbeddingsAvailable()) return 'unavailable'
  const db = getDb()
  const pending = db
    .prepare(`SELECT rowid, text FROM chunks_meta WHERE embedded = 0 LIMIT ?`)
    .all(maxChunks) as Array<{ rowid: number | bigint; text: string }>
  if (pending.length === 0) return 'done'

  let vectors: Float32Array[]
  try {
    // embedTexts batches internally at 4 — the bound that keeps ONNX peak
    // memory safe in the main process (see memory/embeddings.ts).
    vectors = await embedTexts(pending.map((p) => p.text))
  } catch {
    return 'unavailable' // model failed — already logged by the embedder
  }

  const insVec = db.prepare(`INSERT OR REPLACE INTO chunks_vec(rowid, embedding) VALUES (?, ?)`)
  const markDone = db.prepare(`UPDATE chunks_meta SET embedded = 1 WHERE rowid = ?`)
  db.transaction(() => {
    for (let i = 0; i < pending.length; i++) {
      insVec.run(BigInt(pending[i].rowid), Buffer.from(vectors[i].buffer))
      markDone.run(pending[i].rowid)
    }
  })()

  const left = db.prepare(`SELECT COUNT(*) AS n FROM chunks_meta WHERE embedded = 0`).get() as {
    n: number
  }
  return left.n > 0 ? 'more' : 'done'
}
