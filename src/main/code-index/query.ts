/**
 * Code index query paths: search-code / find-symbol / find-usages / status.
 *
 * Three ranked lists — symbol match, FTS5 (bm25, header-weighted), vector —
 * fused with the same rrf() the memory index uses, then boosted. Scope is
 * clamped HERE, server-side: a session asking for `fleet` never sees an
 * excluded repo, and `project` resolves from the caller's cwd through git,
 * so a caller cannot widen its own scope past what settings allow.
 *
 * Every snippet passes redactSecrets() on the way out: gitignored files are
 * never indexed, but a committed key in an old repo is exactly what fleet
 * scope would otherwise cheerfully surface into another project's session.
 */

import { getDb, isCodeIndexDbAvailable, isFtsAvailable, getCodeIndexError, dbStats } from './db'
import { normalizeToRepoRoot } from './discovery'
import { isIndexing, walkStatsFor } from './indexer'
import { isSegmenterAvailable } from './segment'
import { embedTexts, isEmbeddingsAvailable, rrf } from '../memory/embeddings'
import { redactSecrets } from '../observer/tokens'

export type CodeScope = 'project' | 'fleet'

const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '
const SNIPPET_MAX_CHARS = 700
const CANDIDATES_PER_LIST = 50

// Ranking boosts, multiplicative over the fused RRF score. Kept in one table
// because ranking heuristics rot fastest when nobody can find them.
const BOOSTS = {
  callerRepo: 1.5, // results from the caller's own project first
  recentEdit: 1.2, // file mtime within the last 30 days
  recentEditWindowMs: 30 * 24 * 3600 * 1000
}

export interface QueryPolicy {
  /** Canonical repo roots excluded from indexing and every scope. */
  excludedRepos: string[]
}

export interface CodeHit {
  repo: string
  repoRoot: string
  path: string
  startLine: number
  endLine: number
  symbol: string | null
  kind: string | null
  snippet: string
  score: number
  crossRepo: boolean
}

export interface SymbolHit {
  repo: string
  path: string
  kind: string
  name: string
  signature: string
  startLine: number
  endLine: number
  parentName: string | null
  exact: boolean
  crossRepo: boolean
}

export interface UsageHit {
  repo: string
  path: string
  line: number
  snippet: string
  isDefinition: boolean
  crossRepo: boolean
}

export interface CodeStatusRepo {
  root: string
  name: string
  files: number
  symbols: number
  chunks: number
  embeddedPct: number
  truncated: boolean
  skippedOversize: number | null
  indexedAt: number | null
  isCaller: boolean
}

export interface CodeStatusReport {
  available: boolean
  error: string | null
  indexing: boolean
  ftsAvailable: boolean
  segmenterAvailable: boolean
  embeddingsAvailable: boolean
  callerRepo: string | null
  totalBytes: number
  repos: CodeStatusRepo[]
}

// ─── Scope resolution ───────────────────────────────────────────────────────

export function resolveCallerRepo(callerCwd: string): string | null {
  if (!callerCwd) return null
  try {
    return normalizeToRepoRoot(callerCwd)
  } catch {
    return null
  }
}

/** Indexed repo roots visible to this caller at this scope. */
function scopeRoots(scope: CodeScope, callerRepo: string | null, policy: QueryPolicy): string[] {
  const db = getDb()
  const excluded = new Set(policy.excludedRepos)
  const all = (db.prepare(`SELECT root FROM repos`).all() as Array<{ root: string }>)
    .map((r) => r.root)
    .filter((r) => !excluded.has(r))
  if (scope === 'fleet') return all
  return callerRepo && all.includes(callerRepo) ? [callerRepo] : []
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

// ─── search-code ────────────────────────────────────────────────────────────

export interface SearchCodeParams {
  query: string
  callerCwd: string
  scope: CodeScope
  limit?: number
  kind?: string
  pathFilter?: string
}

interface ChunkRow {
  rowid: number
  repo_root: string
  repo_name: string
  rel_path: string
  start_line: number
  end_line: number
  text: string
  mtime: number
  symbol_name: string | null
  symbol_kind: string | null
}

export async function searchCode(
  params: SearchCodeParams,
  policy: QueryPolicy
): Promise<{ hits: CodeHit[]; callerRepo: string | null }> {
  if (!isCodeIndexDbAvailable()) return { hits: [], callerRepo: null }
  const db = getDb()
  const callerRepo = resolveCallerRepo(params.callerCwd)
  const roots = scopeRoots(params.scope, callerRepo, policy)
  if (roots.length === 0 || !params.query.trim()) return { hits: [], callerRepo }
  const rootsIn = `f.repo_root IN (${placeholders(roots.length)})`

  // List 1 — symbol name match (exact, then prefix), mapped to chunks.
  const symbolRowids: number[] = db
    .prepare(
      `SELECT cm.rowid AS rowid,
              (s.name = ?) AS exact
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       JOIN chunks_meta cm ON cm.file_id = s.file_id
         AND cm.start_line <= s.start_line AND cm.end_line >= s.start_line
       WHERE (s.name = ? OR s.name LIKE ? || '%') AND ${rootsIn}
       GROUP BY cm.rowid
       ORDER BY exact DESC, LENGTH(s.name) ASC
       LIMIT ${CANDIDATES_PER_LIST}`
    )
    .all(params.query, params.query, params.query, ...roots)
    .map((r) => Number((r as { rowid: number }).rowid))

  // List 2 — FTS5 bm25, header weighted 3× over body text.
  let ftsRowids: number[] = []
  if (isFtsAvailable()) {
    const tokens = params.query.match(/[A-Za-z0-9_$]+/g) ?? []
    if (tokens.length > 0) {
      const match = tokens.map((t) => `"${t}"`).join(' ')
      try {
        ftsRowids = db
          .prepare(
            `SELECT ft.rowid AS rowid
             FROM chunks_fts ft
             JOIN chunks_meta cm ON cm.rowid = ft.rowid
             JOIN files f ON f.id = cm.file_id
             WHERE chunks_fts MATCH ? AND ${rootsIn}
             ORDER BY bm25(chunks_fts, 3.0, 1.0)
             LIMIT ${CANDIDATES_PER_LIST}`
          )
          .all(match, ...roots)
          .map((r) => Number((r as { rowid: number }).rowid))
      } catch {
        ftsRowids = [] // FTS syntax edge case — other lists still rank
      }
    }
  }

  // List 3 — vector search over backfilled embeddings (may be empty early).
  let vecRowids: number[] = []
  if (isEmbeddingsAvailable()) {
    try {
      const [qVec] = await embedTexts([QUERY_PREFIX + params.query])
      vecRowids = db
        .prepare(
          `SELECT v.rowid AS rowid
           FROM chunks_vec v
           JOIN chunks_meta cm ON cm.rowid = v.rowid
           JOIN files f ON f.id = cm.file_id
           WHERE v.embedding MATCH ? AND k = ${CANDIDATES_PER_LIST} AND ${rootsIn}
           ORDER BY v.distance`
        )
        .all(Buffer.from(qVec.buffer), ...roots)
        .map((r) => Number((r as { rowid: number }).rowid))
    } catch {
      vecRowids = [] // model unavailable — symbol+FTS still rank
    }
  }

  const fused = rrf<number>(
    [
      { items: symbolRowids, weight: 1.2 }, // exact-name intent ranks first
      { items: ftsRowids, weight: 1 },
      { items: vecRowids, weight: 1 }
    ],
    (rowid) => String(rowid)
  )
  if (fused.length === 0) return { hits: [], callerRepo }

  // Hydrate fused candidates, apply boosts and post-filters.
  const rowids = fused.map((f) => f.item)
  const rows = db
    .prepare(
      `SELECT cm.rowid AS rowid, f.repo_root, r.name AS repo_name, f.rel_path,
              cm.start_line, cm.end_line, cm.text, f.mtime,
              s.name AS symbol_name, s.kind AS symbol_kind
       FROM chunks_meta cm
       JOIN files f ON f.id = cm.file_id
       JOIN repos r ON r.root = f.repo_root
       LEFT JOIN symbols s ON s.id = cm.symbol_id
       WHERE cm.rowid IN (${placeholders(rowids.length)})`
    )
    .all(...rowids) as ChunkRow[]
  const byRowid = new Map(rows.map((r) => [r.rowid, r]))

  const now = Date.now()
  const hits: CodeHit[] = []
  for (const { item: rowid, score } of fused) {
    const row = byRowid.get(rowid)
    if (!row) continue
    if (params.kind && row.symbol_kind !== params.kind) continue
    if (params.pathFilter && !row.rel_path.includes(params.pathFilter)) continue
    let boosted = score
    if (callerRepo && row.repo_root === callerRepo) boosted *= BOOSTS.callerRepo
    if (now - row.mtime < BOOSTS.recentEditWindowMs) boosted *= BOOSTS.recentEdit
    hits.push({
      repo: row.repo_name,
      repoRoot: row.repo_root,
      path: row.rel_path,
      startLine: row.start_line,
      endLine: row.end_line,
      symbol: row.symbol_name,
      kind: row.symbol_kind,
      snippet: makeSnippet(row.text),
      score: boosted,
      crossRepo: callerRepo !== null && row.repo_root !== callerRepo
    })
  }
  hits.sort((a, b) => b.score - a.score)
  return { hits: hits.slice(0, params.limit ?? 15), callerRepo }
}

/** Chunk text minus its synthesised header line, redacted and capped. */
function makeSnippet(chunkText: string): string {
  const nl = chunkText.indexOf('\n')
  const body = nl === -1 ? chunkText : chunkText.slice(nl + 1)
  const capped = body.length > SNIPPET_MAX_CHARS ? `${body.slice(0, SNIPPET_MAX_CHARS)}\n…` : body
  return redactSecrets(capped)
}

// ─── find-symbol ────────────────────────────────────────────────────────────

export function findSymbol(
  params: { name: string; callerCwd: string; scope: CodeScope; limit?: number },
  policy: QueryPolicy
): { hits: SymbolHit[]; callerRepo: string | null } {
  if (!isCodeIndexDbAvailable()) return { hits: [], callerRepo: null }
  const db = getDb()
  const callerRepo = resolveCallerRepo(params.callerCwd)
  const roots = scopeRoots(params.scope, callerRepo, policy)
  if (roots.length === 0 || !params.name.trim()) return { hits: [], callerRepo }

  const rows = db
    .prepare(
      `SELECT r.name AS repo_name, f.repo_root, f.rel_path,
              s.kind, s.name, s.signature, s.start_line, s.end_line, s.parent_name,
              (s.name = ?) AS exact
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       JOIN repos r ON r.root = f.repo_root
       WHERE (s.name = ? OR s.name LIKE '%' || ? || '%')
         AND f.repo_root IN (${placeholders(roots.length)})
       ORDER BY exact DESC,
                (f.repo_root = ?) DESC,
                LENGTH(s.name) ASC
       LIMIT ?`
    )
    .all(
      params.name,
      params.name,
      params.name,
      ...roots,
      callerRepo ?? '',
      params.limit ?? 25
    ) as Array<{
    repo_name: string
    repo_root: string
    rel_path: string
    kind: string
    name: string
    signature: string
    start_line: number
    end_line: number
    parent_name: string | null
    exact: number
  }>

  return {
    hits: rows.map((r) => ({
      repo: r.repo_name,
      path: r.rel_path,
      kind: r.kind,
      name: r.name,
      signature: redactSecrets(r.signature),
      startLine: r.start_line,
      endLine: r.end_line,
      parentName: r.parent_name,
      exact: r.exact === 1,
      crossRepo: callerRepo !== null && r.repo_root !== callerRepo
    })),
    callerRepo
  }
}

// ─── find-usages ────────────────────────────────────────────────────────────

/**
 * Text-match references via FTS (honest label: not AST resolution). Scans
 * matching chunks for lines containing the identifier; marks lines that a
 * symbol row identifies as the definition itself.
 */
export function findUsages(
  params: { name: string; callerCwd: string; scope: CodeScope; limit?: number },
  policy: QueryPolicy
): { hits: UsageHit[]; callerRepo: string | null } {
  if (!isCodeIndexDbAvailable() || !isFtsAvailable()) return { hits: [], callerRepo: null }
  const db = getDb()
  const callerRepo = resolveCallerRepo(params.callerCwd)
  const roots = scopeRoots(params.scope, callerRepo, policy)
  const name = params.name.trim()
  if (roots.length === 0 || !name || !/^[A-Za-z0-9_$]+$/.test(name)) {
    return { hits: [], callerRepo }
  }
  const limit = params.limit ?? 50

  let chunkRows: ChunkRow[] = []
  try {
    chunkRows = db
      .prepare(
        `SELECT cm.rowid AS rowid, f.repo_root, r.name AS repo_name, f.rel_path,
                cm.start_line, cm.end_line, cm.text, f.mtime,
                NULL AS symbol_name, NULL AS symbol_kind
         FROM chunks_fts ft
         JOIN chunks_meta cm ON cm.rowid = ft.rowid
         JOIN files f ON f.id = cm.file_id
         JOIN repos r ON r.root = f.repo_root
         WHERE chunks_fts MATCH ? AND f.repo_root IN (${placeholders(roots.length)})
         ORDER BY (f.repo_root = ?) DESC
         LIMIT 200`
      )
      .all(`"${name}"`, ...roots, callerRepo ?? '') as ChunkRow[]
  } catch {
    return { hits: [], callerRepo }
  }

  // Definition spans for this name, to label definition lines.
  const defSpans = db
    .prepare(
      `SELECT f.repo_root, f.rel_path, s.start_line
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.name = ? AND f.repo_root IN (${placeholders(roots.length)})`
    )
    .all(name, ...roots) as Array<{ repo_root: string; rel_path: string; start_line: number }>
  const defKeys = new Set(defSpans.map((d) => `${d.repo_root}\0${d.rel_path}\0${d.start_line}`))

  const wordRe = new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`)
  const hits: UsageHit[] = []
  const seenLines = new Set<string>()
  for (const row of chunkRows) {
    // First line of chunk text is the synthesised header — content follows.
    const lines = row.text.split('\n').slice(1)
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      if (!wordRe.test(lines[i])) continue
      const line = row.start_line + i
      const key = `${row.repo_root}\0${row.rel_path}\0${line}`
      if (seenLines.has(key)) continue
      seenLines.add(key)
      hits.push({
        repo: row.repo_name,
        path: row.rel_path,
        line,
        snippet: redactSecrets(lines[i].trim().slice(0, 300)),
        isDefinition: defKeys.has(key),
        crossRepo: callerRepo !== null && row.repo_root !== callerRepo
      })
    }
    if (hits.length >= limit) break
  }
  return { hits, callerRepo }
}

// ─── status ─────────────────────────────────────────────────────────────────

export function codeIndexStatus(callerCwd: string, policy: QueryPolicy): CodeStatusReport {
  const callerRepo = isCodeIndexDbAvailable() ? resolveCallerRepo(callerCwd) : null
  if (!isCodeIndexDbAvailable()) {
    return {
      available: false,
      error: getCodeIndexError(),
      indexing: false,
      ftsAvailable: false,
      segmenterAvailable: isSegmenterAvailable(),
      embeddingsAvailable: isEmbeddingsAvailable(),
      callerRepo,
      totalBytes: 0,
      repos: []
    }
  }
  const db = getDb()
  const excluded = new Set(policy.excludedRepos)
  const rows = db
    .prepare(
      `SELECT r.root, r.name, r.indexed_at, r.truncated,
              COUNT(DISTINCT f.id) AS files,
              (SELECT COUNT(*) FROM symbols s JOIN files f2 ON f2.id = s.file_id WHERE f2.repo_root = r.root) AS symbols,
              (SELECT COUNT(*) FROM chunks_meta cm JOIN files f3 ON f3.id = cm.file_id WHERE f3.repo_root = r.root) AS chunks,
              (SELECT COUNT(*) FROM chunks_meta cm JOIN files f4 ON f4.id = cm.file_id WHERE f4.repo_root = r.root AND cm.embedded = 1) AS embedded
       FROM repos r
       LEFT JOIN files f ON f.repo_root = r.root
       GROUP BY r.root
       ORDER BY r.name`
    )
    .all() as Array<{
    root: string
    name: string
    indexed_at: number | null
    truncated: number
    files: number
    symbols: number
    chunks: number
    embedded: number
  }>

  return {
    available: true,
    error: null,
    indexing: isIndexing(),
    ftsAvailable: isFtsAvailable(),
    segmenterAvailable: isSegmenterAvailable(),
    embeddingsAvailable: isEmbeddingsAvailable(),
    callerRepo,
    totalBytes: dbStats().bytes,
    repos: rows
      .filter((r) => !excluded.has(r.root))
      .map((r) => ({
        root: r.root,
        name: r.name,
        files: r.files,
        symbols: r.symbols,
        chunks: r.chunks,
        embeddedPct: r.chunks === 0 ? 0 : Math.round((r.embedded / r.chunks) * 100),
        truncated: r.truncated === 1,
        skippedOversize: walkStatsFor(r.root)?.skippedOversize ?? null,
        indexedAt: r.indexed_at,
        isCaller: callerRepo === r.root
      }))
  }
}
