/**
 * Local semantic search for memory notes.
 *
 * Pipeline: section-based chunking → bge-small-en-v1.5 (384-dim, ONNX)
 *           → sqlite-vec virtual table → cosine search.
 *
 * Pure module — no electron imports. Takes paths as arguments so both the
 * main process and the MCP server can use it against the same DB file.
 */

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'

const EMBED_DIM = 384
const MAX_CHUNK_TOKENS = 400 // leaves headroom under bge's 512-token limit
const CHARS_PER_TOKEN = 4 // crude estimate; good enough for chunk sizing
const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * CHARS_PER_TOKEN

const QUERY_PREFIX =
  'Represent this sentence for searching relevant passages: '

// ─── State ──────────────────────────────────────────────────────────────────

interface EmbeddingsHandle {
  db: Database.Database
  modelPath: string
  embedder: any | null // Lazy-loaded transformers.js pipeline
  embedderPromise: Promise<any> | null
  available: boolean
  errorMessage: string | null
  insertChunk: Database.Statement
  deleteChunks: Database.Statement
  selectMtime: Database.Statement
}

let handle: EmbeddingsHandle | null = null

export interface InitOptions {
  dbPath: string
  modelPath: string // dir containing config.json, tokenizer.json, onnx/model_quantized.onnx
}

export function initEmbeddings(opts: InitOptions): void {
  if (handle) return
  try {
    fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true })
    const db = new Database(opts.dbPath)
    db.pragma('journal_mode = WAL')
    sqliteVec.load(db)

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING vec0(
        embedding float[${EMBED_DIM}]
      );
      CREATE TABLE IF NOT EXISTS chunk_meta (
        rowid INTEGER PRIMARY KEY,
        filename TEXT NOT NULL,
        chunk_idx INTEGER NOT NULL,
        text TEXT NOT NULL,
        file_mtime INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunk_filename ON chunk_meta(filename);
    `)

    handle = {
      db,
      modelPath: opts.modelPath,
      embedder: null,
      embedderPromise: null,
      available: true,
      errorMessage: null,
      insertChunk: db.prepare(
        `INSERT INTO chunk_meta(rowid, filename, chunk_idx, text, file_mtime)
         VALUES (?, ?, ?, ?, ?)`
      ),
      deleteChunks: db.prepare(`DELETE FROM chunk_meta WHERE filename = ?`),
      selectMtime: db.prepare(
        `SELECT file_mtime FROM chunk_meta WHERE filename = ? LIMIT 1`
      )
    }

    // Self-heal: prior versions of indexNote() only deleted from chunk_meta,
    // leaking rows in the vec0 chunks table. Purge any chunks rowid that
    // doesn't have a chunk_meta entry. Cheap on startup.
    try {
      const orphans = db
        .prepare(
          `SELECT rowid FROM chunks WHERE rowid NOT IN (SELECT rowid FROM chunk_meta)`
        )
        .all() as { rowid: number | bigint }[]
      if (orphans.length > 0) {
        const delOrphan = db.prepare(`DELETE FROM chunks WHERE rowid = ?`)
        const purge = db.transaction(() => {
          for (const r of orphans) delOrphan.run(BigInt(r.rowid))
        })
        purge()
        console.log(`[embeddings] purged ${orphans.length} orphan chunk(s)`)
      }
    } catch (purgeErr) {
      console.warn('[embeddings] orphan purge failed (non-fatal):', purgeErr)
    }
  } catch (err) {
    console.error('[embeddings] init failed — semantic search disabled:', err)
    handle = {
      db: null as unknown as Database.Database,
      modelPath: opts.modelPath,
      embedder: null,
      embedderPromise: null,
      available: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      insertChunk: null as unknown as Database.Statement,
      deleteChunks: null as unknown as Database.Statement,
      selectMtime: null as unknown as Database.Statement
    }
  }
}

export function isEmbeddingsAvailable(): boolean {
  return handle?.available === true
}

export function getEmbeddingsError(): string | null {
  return handle?.errorMessage ?? null
}

// ─── Embedder ───────────────────────────────────────────────────────────────

async function getEmbedder(): Promise<any> {
  if (!handle || !handle.available) throw new Error('embeddings not initialized')
  if (handle.embedder) return handle.embedder
  if (handle.embedderPromise) return handle.embedderPromise

  handle.embedderPromise = (async () => {
    // Dynamic import: keeps cold-start fast, avoids loading transformers
    // when semantic search is never used in a session.
    const { pipeline, env } = await import('@huggingface/transformers')
    env.allowRemoteModels = false
    env.allowLocalModels = true
    env.localModelPath = path.dirname(handle!.modelPath)
    const modelId = path.basename(handle!.modelPath)

    const embedder = await pipeline('feature-extraction', modelId, {
      // ONNX quantized weights → fast CPU inference, ~25MB on disk
      dtype: 'q8' as any
    })
    handle!.embedder = embedder
    return embedder
  })().catch((err) => {
    console.error('[embeddings] failed to load model:', err)
    handle!.available = false
    handle!.errorMessage = err instanceof Error ? err.message : String(err)
    handle!.embedderPromise = null
    throw err
  })

  return handle.embedderPromise
}

async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  const embedder = await getEmbedder()
  const out = await embedder(texts, { pooling: 'mean', normalize: true })
  // transformers.js returns a Tensor with .tolist(): number[][]
  const list: number[][] = out.tolist()
  return list.map((row) => Float32Array.from(row))
}

// ─── Chunking ───────────────────────────────────────────────────────────────

export function chunkNote(text: string): string[] {
  const sections = splitOnHeadings(text)
  const chunks: string[] = []
  for (const section of sections) {
    if (section.length <= MAX_CHUNK_CHARS) {
      const trimmed = section.trim()
      if (trimmed) chunks.push(trimmed)
    } else {
      // Section too long — split on blank lines (paragraphs)
      for (const piece of splitLong(section, MAX_CHUNK_CHARS)) {
        const trimmed = piece.trim()
        if (trimmed) chunks.push(trimmed)
      }
    }
  }
  return chunks
}

function splitOnHeadings(text: string): string[] {
  // Split before each `^## ` line; keep the heading with its section.
  const lines = text.split('\n')
  const sections: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (/^##\s/.test(line) && current.length > 0) {
      sections.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) sections.push(current.join('\n'))
  return sections
}

function splitLong(section: string, maxChars: number): string[] {
  const paragraphs = section.split(/\n\s*\n/)
  const out: string[] = []
  let buf = ''
  for (const p of paragraphs) {
    if (!p.trim()) continue
    if (buf.length + p.length + 2 > maxChars && buf) {
      out.push(buf)
      buf = ''
    }
    if (p.length > maxChars) {
      // Single paragraph oversized — hard split on char boundary
      if (buf) {
        out.push(buf)
        buf = ''
      }
      for (let i = 0; i < p.length; i += maxChars) {
        out.push(p.slice(i, i + maxChars))
      }
    } else {
      buf = buf ? `${buf}\n\n${p}` : p
    }
  }
  if (buf) out.push(buf)
  return out
}

// ─── Indexing ───────────────────────────────────────────────────────────────

/** Returns true if the file's chunks are already up-to-date (same mtime). */
export function isFresh(filename: string, mtime: number): boolean {
  if (!handle?.available) return true // pretend fresh so callers skip work
  const row = handle.selectMtime.get(filename) as { file_mtime: number } | undefined
  return row !== undefined && row.file_mtime === mtime
}

export async function indexNote(
  filename: string,
  text: string,
  mtime: number
): Promise<void> {
  if (!handle?.available) return
  if (isFresh(filename, mtime)) return

  const chunks = chunkNote(text)
  if (chunks.length === 0) {
    handle.deleteChunks.run(filename)
    return
  }

  let embeddings: Float32Array[]
  try {
    embeddings = await embedTexts(chunks)
  } catch {
    return // model failed — already logged in getEmbedder
  }

  const tx = handle.db.transaction(() => {
    // Delete from both tables to keep their rowid spaces in sync. The vec0
    // virtual table doesn't cascade from chunk_meta, so failing to delete here
    // leaks orphan rows that collide on UNIQUE when nextRowid() rewinds after
    // a process restart (counter is rebuilt from MAX(chunk_meta) but chunks
    // still holds the old rowids).
    const existing = handle!.db
      .prepare(`SELECT rowid FROM chunk_meta WHERE filename = ?`)
      .all(filename) as { rowid: number | bigint }[]
    const delVec = handle!.db.prepare(`DELETE FROM chunks WHERE rowid = ?`)
    for (const r of existing) delVec.run(BigInt(r.rowid))
    handle!.deleteChunks.run(filename)

    const insertVec = handle!.db.prepare(
      `INSERT INTO chunks(rowid, embedding) VALUES (?, ?)`
    )
    for (let i = 0; i < chunks.length; i++) {
      // sqlite-vec's vec0 virtual table requires BigInt for rowid; plain JS
      // numbers are treated as floats and get rejected.
      const rowid = BigInt(nextRowid())
      insertVec.run(rowid, Buffer.from(embeddings[i].buffer))
      handle!.insertChunk.run(rowid, filename, i, chunks[i], mtime)
    }
  })
  tx()
}

export function removeNote(filename: string): void {
  if (!handle?.available) return
  const rows = handle.db
    .prepare(`SELECT rowid FROM chunk_meta WHERE filename = ?`)
    .all(filename) as { rowid: number | bigint }[]
  const tx = handle.db.transaction(() => {
    const del = handle!.db.prepare(`DELETE FROM chunks WHERE rowid = ?`)
    for (const r of rows) {
      del.run(BigInt(r.rowid))
    }
    handle!.deleteChunks.run(filename)
  })
  tx()
}

// Globally unique rowid generator. Seeded once per process from the max
// rowid across BOTH tables — chunk_meta on its own can rewind if files have
// been deleted, but chunks may still hold higher rowids from earlier
// indexings that the old (buggy) indexNote() left behind.
let rowidCounter: number | null = null
function nextRowid(): number {
  if (!handle) throw new Error('not initialized')
  if (rowidCounter === null) {
    const metaRow = handle.db
      .prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM chunk_meta`)
      .get() as { m: number }
    const chunksRow = handle.db
      .prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM chunks`)
      .get() as { m: number | bigint }
    const chunksMax = typeof chunksRow.m === 'bigint' ? Number(chunksRow.m) : chunksRow.m
    rowidCounter = Math.max(metaRow.m, chunksMax)
  }
  rowidCounter += 1
  return rowidCounter
}

// ─── Query ──────────────────────────────────────────────────────────────────

export interface SemanticHit {
  filename: string
  chunkIdx: number
  text: string
  distance: number
}

export async function searchSemantic(
  query: string,
  limit: number = 50
): Promise<SemanticHit[]> {
  if (!handle?.available) return []
  if (!query.trim()) return []

  let qVec: Float32Array
  try {
    const [v] = await embedTexts([QUERY_PREFIX + query])
    qVec = v
  } catch {
    return []
  }

  const rows = handle.db
    .prepare(
      `SELECT c.rowid, m.filename, m.chunk_idx, m.text, c.distance
       FROM chunks c
       JOIN chunk_meta m ON m.rowid = c.rowid
       WHERE c.embedding MATCH ?
         AND k = ?
       ORDER BY c.distance`
    )
    .all(Buffer.from(qVec.buffer), limit) as Array<{
    rowid: number
    filename: string
    chunk_idx: number
    text: string
    distance: number
  }>

  return rows.map((r) => ({
    filename: r.filename,
    chunkIdx: r.chunk_idx,
    text: r.text,
    distance: r.distance
  }))
}

// ─── Reciprocal Rank Fusion ─────────────────────────────────────────────────

/**
 * Fuse two ranked lists by reciprocal rank fusion.
 * `k` is the standard RRF constant; 60 works well across most setups.
 * Higher score = better.
 */
export function rrf<T>(
  lists: Array<{ items: T[]; weight?: number }>,
  keyOf: (item: T) => string,
  k: number = 60
): Array<{ item: T; score: number }> {
  const scores = new Map<string, { item: T; score: number }>()
  for (const { items, weight = 1 } of lists) {
    for (let rank = 0; rank < items.length; rank++) {
      const item = items[rank]
      const key = keyOf(item)
      const contrib = weight / (k + rank + 1)
      const existing = scores.get(key)
      if (existing) existing.score += contrib
      else scores.set(key, { item, score: contrib })
    }
  }
  return [...scores.values()].sort((a, b) => b.score - a.score)
}

// ─── Shutdown ───────────────────────────────────────────────────────────────

export function closeEmbeddings(): void {
  if (!handle) return
  try {
    handle.db?.close()
  } catch {
    /* best-effort */
  }
  handle = null
  rowidCounter = null
}
