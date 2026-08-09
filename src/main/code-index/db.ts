/**
 * Code index storage — a second retrieval corpus alongside memory notes.
 *
 * Own database (code-index.db), never shared with memory-embeddings.db:
 * different growth curve, deletable on its own, and a code-index migration
 * must never put the memory index at risk.
 *
 * Pure module — no electron imports. The main process is the only writer
 * and the only reader; the MCP child reaches this data over the embed
 * socket, never by opening the file.
 */

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'

export const EMBED_DIM = 384

interface CodeDbHandle {
  db: Database.Database
  dbPath: string
  available: boolean
  ftsAvailable: boolean
  errorMessage: string | null
}

let handle: CodeDbHandle | null = null

export function initCodeIndexDb(dbPath: string): void {
  if (handle) return
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    // Same asar redirect as memory/embeddings.ts — dlopen can't see into asar.
    const loadablePath = sqliteVec
      .getLoadablePath()
      .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    db.loadExtension(loadablePath)

    db.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        root        TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        indexed_at  INTEGER,
        head_commit TEXT,
        truncated   INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS files (
        id           INTEGER PRIMARY KEY,
        repo_root    TEXT NOT NULL,
        rel_path     TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        mtime        INTEGER NOT NULL,
        size         INTEGER NOT NULL,
        lang         TEXT,
        indexed_at   INTEGER NOT NULL,
        UNIQUE(repo_root, rel_path)
      );
      CREATE TABLE IF NOT EXISTS symbols (
        id          INTEGER PRIMARY KEY,
        file_id     INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        name        TEXT NOT NULL,
        signature   TEXT NOT NULL,
        start_line  INTEGER NOT NULL,
        end_line    INTEGER NOT NULL,
        parent_name TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
      CREATE TABLE IF NOT EXISTS chunks_meta (
        rowid      INTEGER PRIMARY KEY,
        file_id    INTEGER NOT NULL,
        symbol_id  INTEGER,
        header     TEXT NOT NULL,
        text       TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line   INTEGER NOT NULL,
        embedded   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks_meta(file_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_pending ON chunks_meta(embedded) WHERE embedded = 0;
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        embedding float[${EMBED_DIM}]
      );
    `)

    // FTS5 separately: better-sqlite3 bundles it, but if a build ever lacks
    // it the index should degrade to symbol+vector rather than not exist.
    let ftsAvailable = true
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          header, text,
          content='chunks_meta', content_rowid='rowid',
          tokenize = "unicode61 tokenchars '_$'"
        );
      `)
    } catch (ftsErr) {
      ftsAvailable = false
      console.warn('[code-index] FTS5 unavailable — keyword layer disabled:', ftsErr)
    }

    handle = { db, dbPath, available: true, ftsAvailable, errorMessage: null }

    // Self-heal: purge vec rows whose meta row is gone (interrupted reindex).
    try {
      const orphans = db
        .prepare(`SELECT rowid FROM chunks_vec WHERE rowid NOT IN (SELECT rowid FROM chunks_meta)`)
        .all() as { rowid: number | bigint }[]
      if (orphans.length > 0) {
        const delOrphan = db.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`)
        db.transaction(() => {
          for (const r of orphans) delOrphan.run(BigInt(r.rowid))
        })()
        console.log(`[code-index] purged ${orphans.length} orphan vec row(s)`)
      }
    } catch (purgeErr) {
      console.warn('[code-index] orphan purge failed (non-fatal):', purgeErr)
    }
  } catch (err) {
    console.error('[code-index] init failed — code index disabled:', err)
    handle = {
      db: null as unknown as Database.Database,
      dbPath,
      available: false,
      ftsAvailable: false,
      errorMessage: err instanceof Error ? err.message : String(err)
    }
  }
}

export function isCodeIndexDbAvailable(): boolean {
  return handle?.available === true
}

export function isFtsAvailable(): boolean {
  return handle?.ftsAvailable === true
}

export function getCodeIndexError(): string | null {
  return handle?.errorMessage ?? null
}

export function getDb(): Database.Database {
  if (!handle?.available) throw new Error('code index db not available')
  return handle.db
}

// Rowid allocator for chunks_meta/chunks_vec/chunks_fts (shared rowid space).
// vec0 requires BigInt rowids; seeded from the max across meta AND vec so an
// interrupted delete can never cause a UNIQUE collision after restart.
let rowidCounter: bigint | null = null
export function nextChunkRowid(): bigint {
  const db = getDb()
  if (rowidCounter === null) {
    const meta = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM chunks_meta`).get() as {
      m: number | bigint
    }
    const vec = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM chunks_vec`).get() as {
      m: number | bigint
    }
    rowidCounter = BigInt(meta.m) > BigInt(vec.m) ? BigInt(meta.m) : BigInt(vec.m)
  }
  rowidCounter += 1n
  return rowidCounter
}

export interface CodeIndexDbStats {
  bytes: number
  repos: number
  files: number
  chunks: number
  embedded: number
  symbols: number
}

export function dbStats(): CodeIndexDbStats {
  const empty = { bytes: 0, repos: 0, files: 0, chunks: 0, embedded: 0, symbols: 0 }
  if (!handle?.available) {
    try {
      return { ...empty, bytes: fs.statSync(handle?.dbPath ?? '').size }
    } catch {
      return empty
    }
  }
  const db = handle.db
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
  let bytes = 0
  try {
    bytes = fs.statSync(handle.dbPath).size
    bytes += fs.statSync(`${handle.dbPath}-wal`).size
  } catch {
    /* wal may not exist */
  }
  return {
    bytes,
    repos: one(`SELECT COUNT(*) AS n FROM repos`),
    files: one(`SELECT COUNT(*) AS n FROM files`),
    chunks: one(`SELECT COUNT(*) AS n FROM chunks_meta`),
    embedded: one(`SELECT COUNT(*) AS n FROM chunks_meta WHERE embedded = 1`),
    symbols: one(`SELECT COUNT(*) AS n FROM symbols`)
  }
}

export function closeCodeIndexDb(): void {
  if (!handle) return
  try {
    handle.db?.close()
  } catch {
    /* best-effort */
  }
  handle = null
  rowidCounter = null
}

/** Cleanup-panel delete: close, then remove db + wal + shm. */
export function deleteCodeIndexDb(): { bytes: number } {
  const dbPath = handle?.dbPath
  const stats = handle?.available ? dbStats() : { bytes: 0 }
  closeCodeIndexDb()
  if (dbPath) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(`${dbPath}${suffix}`)
      } catch {
        /* may not exist */
      }
    }
  }
  return { bytes: stats.bytes }
}
