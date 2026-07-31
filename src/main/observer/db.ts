/**
 * Observer store — the append-only event log plus the derived pattern and
 * suggestion tables that back the "continuously curious" background agent.
 *
 * SQLite (better-sqlite3, already a dependency for memory embeddings) rather
 * than JSON: the event log grows to tens of thousands of rows and the mining
 * pass needs indexed range scans over (project, kind, ts). It lives in its own
 * DB file so it can be deleted independently of the embeddings index.
 *
 * PRIVACY: this log records WHAT was done, never WHAT WAS SAID. Tool names,
 * shell command strings, file paths and UI action names are stored; user
 * prompt bodies and assistant output never are (prompts are recorded only as a
 * length). Raw events are pruned after RAW_EVENT_RETENTION_DAYS; the derived
 * patterns and suggestions are aggregates and are kept.
 *
 * Pure module — no electron imports, so the path is passed in and tests (or a
 * future out-of-process miner) can point it anywhere.
 */

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/** Raw events older than this are deleted on each maintenance pass. */
export const RAW_EVENT_RETENTION_DAYS = 60

/** Cap on a stored payload string (a pasted heredoc can be enormous). */
const MAX_PAYLOAD_CHARS = 2000

/** Per-field cap applied when the whole payload busts MAX_PAYLOAD_CHARS. */
const MAX_PAYLOAD_FIELD_CHARS = 400

export type ObserverEventKind =
  /** A tool the assistant used. payload: { tool, arg? } */
  | 'tool'
  /** A user prompt was submitted. payload: { chars } — never the text. */
  | 'prompt'
  /** Session lifecycle. payload: { action: 'spawn' | 'end', sessionKind } */
  | 'session'
  /** A renderer UI action. payload: { action, detail? } */
  | 'ui'
  /** A session-manager MCP tool call. payload: { tool } */
  | 'mcp'

export interface ObserverEvent {
  id: number
  ts: number
  sessionId: string | null
  project: string | null
  kind: ObserverEventKind
  payload: Record<string, unknown>
}

export interface PatternRow {
  id: string
  project: string | null
  /** 'frequency' (a single recurring action), 'sequence' (an n-gram), or
   *  'time-of-day' (an action clustered into a daily window). */
  type: 'frequency' | 'sequence' | 'time-of-day'
  /** Stable identity of the thing that recurs, e.g. `bash:npm run build`. */
  signature: string
  /** Human-readable one-liner for the prompt + UI. */
  label: string
  support: number
  distinctDays: number
  /** Recent local YYYY-MM-DD dates the pattern was seen on (capped). */
  days: string[]
  firstSeen: number
  lastSeen: number
  /** candidate → crossed thresholds → 'promoted' → curator judged → 'suggested'.
   *  'muted' patterns are permanently skipped (user chose never-suggest). */
  status: 'candidate' | 'promoted' | 'suggested' | 'muted'
  meta: Record<string, unknown>
}

export type SuggestionKind = 'scheduled-task' | 'todo' | 'skill' | 'memory-link' | 'todo-cleanup'
export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed' | 'never'

export interface SuggestionRow {
  id: string
  patternId: string | null
  createdAt: number
  title: string
  rationale: string
  kind: SuggestionKind
  /** Shape depends on `kind` — see observer/apply.ts for the accepted forms. */
  proposal: Record<string, unknown>
  status: SuggestionStatus
  resolvedAt: number | null
  /** What happened when the suggestion was accepted (or why it failed). */
  result: string | null
}

/** Days a pattern keeps in its rolling window. Long enough for the
 *  "≥4 distinct days in 14" promotion rule with slack for a slow reader. */
const DAYS_WINDOW = 30

/**
 * The subset of better-sqlite3 this module actually uses.
 *
 * Named so the driver can be swapped: better-sqlite3 is a native addon built
 * against ELECTRON's ABI (`electron-builder install-app-deps`), so plain
 * `node --test` cannot load it at all. Tests therefore install an adapter over
 * Node's built-in `node:sqlite`, which is the only way the incremental
 * machinery here — watermarks, day-window promotion, the mining transaction —
 * gets covered outside a running app. Production is untouched.
 */
export interface SqliteLike {
  pragma(source: string): unknown
  exec(source: string): unknown
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number }
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  transaction<T extends (...args: never[]) => unknown>(fn: T): T
  close(): void
}

let openDatabase: (dbPath: string) => SqliteLike =
  (dbPath) => new Database(dbPath) as unknown as SqliteLike

/** Test seam — see SqliteLike. Call before initObserverDb. */
export function setSqliteDriver(open: (dbPath: string) => SqliteLike): void {
  openDatabase = open
}

let db: SqliteLike | null = null

export function initObserverDb(dbPath: string): void {
  if (db) return
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  db = openDatabase(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           INTEGER NOT NULL,
      session_id   TEXT,
      project      TEXT,
      kind         TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_events_project_kind_ts ON events(project, kind, ts);
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

    CREATE TABLE IF NOT EXISTS patterns (
      id            TEXT PRIMARY KEY,
      project       TEXT,
      type          TEXT NOT NULL,
      signature     TEXT NOT NULL,
      label         TEXT NOT NULL DEFAULT '',
      support       INTEGER NOT NULL DEFAULT 0,
      distinct_days INTEGER NOT NULL DEFAULT 0,
      days_json     TEXT NOT NULL DEFAULT '[]',
      first_seen    INTEGER NOT NULL,
      last_seen     INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'candidate',
      meta_json     TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_patterns_status ON patterns(status, last_seen);

    CREATE TABLE IF NOT EXISTS suggestions (
      id            TEXT PRIMARY KEY,
      pattern_id    TEXT,
      created_at    INTEGER NOT NULL,
      title         TEXT NOT NULL,
      rationale     TEXT NOT NULL DEFAULT '',
      kind          TEXT NOT NULL,
      proposal_json TEXT NOT NULL DEFAULT '{}',
      status        TEXT NOT NULL DEFAULT 'pending',
      resolved_at   INTEGER,
      result        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status, created_at);

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  console.log('[observer] store ready at', dbPath)
}

export function isObserverDbReady(): boolean {
  return db !== null
}

/**
 * Run `fn` inside a single SQLite transaction — all of its writes land, or
 * none of them do.
 *
 * The mining pass needs this: it writes pattern counts first and its watermark
 * last, so a crash in between re-processed events that had already been
 * counted, double-counting up to BATCH_LIMIT observations and inflating the
 * support numbers the promotion rule reads. Nothing else about the pass is
 * transactional, and it does not need to be — the writes are the whole state.
 *
 * A no-op passthrough when the store never opened, so callers do not have to
 * branch on it.
 */
export function inTransaction<T>(fn: () => T): T {
  if (!db) return fn()
  return db.transaction(fn)()
}

export function closeObserverDb(): void {
  try { db?.close() } catch { /* already closed */ }
  db = null
}

// ── Events ──────────────────────────────────────────────────────────────────

/**
 * Serialise an event payload, keeping it under the size cap WITHOUT ever
 * producing invalid JSON.
 *
 * Slicing the serialised string was a silent tripwire: an oversized payload
 * was cut mid-token, `JSON.parse` threw on read, and rowToEvent's catch turned
 * the row into `{}` — an event with no tool name and no argument, which
 * actionToken then drops. The events most likely to trip it (a pasted heredoc,
 * a very long command) are exactly the ones a size cap is meant to shorten
 * rather than erase.
 *
 * So shrink the VALUES instead, and fall back to an explicit marker rather
 * than to corruption.
 */
function serializePayload(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload)
  if (json.length <= MAX_PAYLOAD_CHARS) return json

  const shrunk: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    shrunk[key] = typeof value === 'string' ? value.slice(0, MAX_PAYLOAD_FIELD_CHARS) : value
  }
  const retry = JSON.stringify(shrunk)
  if (retry.length <= MAX_PAYLOAD_CHARS) return retry

  // Still oversized (many keys, or huge non-string values). Keep the shape
  // that matters to mining and drop the rest, visibly.
  return JSON.stringify({
    tool: typeof payload.tool === 'string' ? payload.tool : undefined,
    action: typeof payload.action === 'string' ? payload.action : undefined,
    truncated: true,
  })
}

/** Append one event. Never throws — observation must not break the app. */
export function appendEvent(e: {
  kind: ObserverEventKind
  sessionId?: string | null
  project?: string | null
  payload?: Record<string, unknown>
  ts?: number
}): void {
  if (!db) return
  try {
    const payload = serializePayload(e.payload ?? {})
    db.prepare(
      'INSERT INTO events (ts, session_id, project, kind, payload_json) VALUES (?, ?, ?, ?, ?)',
    ).run(e.ts ?? Date.now(), e.sessionId ?? null, e.project ?? null, e.kind, payload)
  } catch (err) {
    console.error('[observer] appendEvent failed:', err)
  }
}

function rowToEvent(r: Record<string, unknown>): ObserverEvent {
  let payload: Record<string, unknown> = {}
  try { payload = JSON.parse(String(r.payload_json)) } catch { /* corrupt row */ }
  return {
    id: Number(r.id),
    ts: Number(r.ts),
    sessionId: (r.session_id as string | null) ?? null,
    project: (r.project as string | null) ?? null,
    kind: r.kind as ObserverEventKind,
    payload,
  }
}

/** Events with id > afterId, oldest first. The mining watermark reads forward
 *  through this so an interrupted pass resumes exactly where it stopped. */
export function eventsAfter(afterId: number, limit: number): ObserverEvent[] {
  if (!db) return []
  return db
    .prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?')
    .all(afterId, limit)
    .map((r) => rowToEvent(r as Record<string, unknown>))
}

export function maxEventId(): number {
  if (!db) return 0
  const row = db.prepare('SELECT MAX(id) AS m FROM events').get() as { m: number | null }
  return row?.m ?? 0
}

export function countEvents(): number {
  if (!db) return 0
  return (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c
}

/** Delete raw events older than the retention window. Aggregates are kept. */
export function pruneOldEvents(now: number = Date.now()): number {
  if (!db) return 0
  const cutoff = now - RAW_EVENT_RETENTION_DAYS * 86_400_000
  const info = db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff)
  return info.changes
}

// ── Meta (watermarks + job bookkeeping) ─────────────────────────────────────

export function getMeta(key: string): string | null {
  if (!db) return null
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setMeta(key: string, value: string): void {
  if (!db) return
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

export function getMetaNumber(key: string, fallback = 0): number {
  const raw = getMeta(key)
  if (raw === null) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export function setMetaNumber(key: string, value: number): void {
  setMeta(key, String(value))
}

// ── Patterns ────────────────────────────────────────────────────────────────

function rowToPattern(r: Record<string, unknown>): PatternRow {
  const parse = <T,>(raw: unknown, fallback: T): T => {
    try { return JSON.parse(String(raw)) as T } catch { return fallback }
  }
  return {
    id: String(r.id),
    project: (r.project as string | null) ?? null,
    type: r.type as PatternRow['type'],
    signature: String(r.signature),
    label: String(r.label ?? ''),
    support: Number(r.support),
    distinctDays: Number(r.distinct_days),
    days: parse<string[]>(r.days_json, []),
    firstSeen: Number(r.first_seen),
    lastSeen: Number(r.last_seen),
    status: r.status as PatternRow['status'],
    meta: parse<Record<string, unknown>>(r.meta_json, {}),
  }
}

/**
 * Record `count` fresh observations of a pattern on the given days.
 *
 * Idempotency is the caller's job (the miner only feeds it events past the
 * watermark). A muted pattern is still counted — the user muted the SUGGESTION,
 * and silently dropping the observation would make the counts lie — but the
 * status is never reset, so it stays out of promotion.
 */
export function upsertPatternObservations(input: {
  id: string
  project: string | null
  type: PatternRow['type']
  signature: string
  label: string
  count: number
  days: string[]
  firstSeen: number
  lastSeen: number
  meta?: Record<string, unknown>
}): void {
  if (!db) return
  const existing = db.prepare('SELECT * FROM patterns WHERE id = ?').get(input.id) as
    | Record<string, unknown>
    | undefined

  if (!existing) {
    const days = [...new Set(input.days)].sort().slice(-DAYS_WINDOW)
    db.prepare(`
      INSERT INTO patterns (id, project, type, signature, label, support, distinct_days,
                            days_json, first_seen, last_seen, status, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?)
    `).run(
      input.id, input.project, input.type, input.signature, input.label,
      input.count, days.length, JSON.stringify(days),
      input.firstSeen, input.lastSeen, JSON.stringify(input.meta ?? {}),
    )
    return
  }

  const prev = rowToPattern(existing)
  const days = [...new Set([...prev.days, ...input.days])].sort().slice(-DAYS_WINDOW)
  db.prepare(`
    UPDATE patterns
       SET support = support + ?, distinct_days = ?, days_json = ?,
           last_seen = MAX(last_seen, ?), label = ?, meta_json = ?
     WHERE id = ?
  `).run(
    input.count, days.length, JSON.stringify(days), input.lastSeen,
    input.label, JSON.stringify({ ...prev.meta, ...(input.meta ?? {}) }), input.id,
  )
}

export function setPatternStatus(id: string, status: PatternRow['status']): void {
  if (!db) return
  db.prepare('UPDATE patterns SET status = ? WHERE id = ?').run(status, id)
}

export function getPattern(id: string): PatternRow | null {
  if (!db) return null
  const row = db.prepare('SELECT * FROM patterns WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToPattern(row) : null
}

export function countPatterns(): number {
  if (!db) return 0
  return (db.prepare('SELECT COUNT(*) AS c FROM patterns').get() as { c: number }).c
}

export function listPatterns(filter?: { status?: PatternRow['status']; limit?: number }): PatternRow[] {
  if (!db) return []
  const rows = filter?.status
    ? db.prepare('SELECT * FROM patterns WHERE status = ? ORDER BY support DESC LIMIT ?')
        .all(filter.status, filter.limit ?? 100)
    : db.prepare('SELECT * FROM patterns ORDER BY support DESC LIMIT ?').all(filter?.limit ?? 100)
  return rows.map((r) => rowToPattern(r as Record<string, unknown>))
}

/**
 * Candidates that have crossed the promotion threshold: seen on at least
 * `minDistinctDays` distinct days inside the last `windowDays`. Day-based
 * rather than raw-count so a single frantic afternoon can't manufacture a
 * "habit" — a real routine shows up across days.
 */
export function findPromotablePatterns(opts: {
  minDistinctDays: number
  windowDays: number
  limit: number
  now?: number
}): PatternRow[] {
  if (!db) return []
  const now = opts.now ?? Date.now()
  const cutoff = new Date(now - opts.windowDays * 86_400_000).toISOString().slice(0, 10)
  return listPatterns({ status: 'candidate', limit: 500 })
    .filter((p) => p.days.filter((d) => d >= cutoff).length >= opts.minDistinctDays)
    .sort((a, b) => b.support - a.support)
    .slice(0, opts.limit)
}

/** Decay: candidates untouched for a long time are dropped so the table can't
 *  grow without bound with one-off noise. Promoted/suggested/muted are kept. */
export function pruneStalePatterns(now: number = Date.now(), staleDays = 45): number {
  if (!db) return 0
  const info = db
    .prepare("DELETE FROM patterns WHERE status = 'candidate' AND last_seen < ? AND support < 5")
    .run(now - staleDays * 86_400_000)
  return info.changes
}

// ── Suggestions ─────────────────────────────────────────────────────────────

function rowToSuggestion(r: Record<string, unknown>): SuggestionRow {
  let proposal: Record<string, unknown> = {}
  try { proposal = JSON.parse(String(r.proposal_json)) } catch { /* corrupt row */ }
  return {
    id: String(r.id),
    patternId: (r.pattern_id as string | null) ?? null,
    createdAt: Number(r.created_at),
    title: String(r.title),
    rationale: String(r.rationale ?? ''),
    kind: r.kind as SuggestionKind,
    proposal,
    status: r.status as SuggestionStatus,
    resolvedAt: r.resolved_at == null ? null : Number(r.resolved_at),
    result: (r.result as string | null) ?? null,
  }
}

export function insertSuggestion(s: {
  id: string
  patternId: string | null
  title: string
  rationale: string
  kind: SuggestionKind
  proposal: Record<string, unknown>
  createdAt?: number
}): void {
  if (!db) return
  db.prepare(`
    INSERT INTO suggestions (id, pattern_id, created_at, title, rationale, kind, proposal_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    ON CONFLICT(id) DO NOTHING
  `).run(
    s.id, s.patternId, s.createdAt ?? Date.now(), s.title, s.rationale, s.kind,
    JSON.stringify(s.proposal),
  )
}

export function listSuggestions(filter?: { status?: SuggestionStatus; limit?: number }): SuggestionRow[] {
  if (!db) return []
  const rows = filter?.status
    ? db.prepare('SELECT * FROM suggestions WHERE status = ? ORDER BY created_at DESC LIMIT ?')
        .all(filter.status, filter.limit ?? 50)
    : db.prepare('SELECT * FROM suggestions ORDER BY created_at DESC LIMIT ?').all(filter?.limit ?? 50)
  return rows.map((r) => rowToSuggestion(r as Record<string, unknown>))
}

export function getSuggestion(id: string): SuggestionRow | null {
  if (!db) return null
  const row = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToSuggestion(row) : null
}

export function resolveSuggestion(id: string, status: SuggestionStatus, result: string | null): void {
  if (!db) return
  db.prepare('UPDATE suggestions SET status = ?, resolved_at = ?, result = ? WHERE id = ?')
    .run(status, Date.now(), result, id)
}

export function countPendingSuggestions(): number {
  if (!db) return 0
  return (db.prepare("SELECT COUNT(*) AS c FROM suggestions WHERE status = 'pending'").get() as { c: number }).c
}

/** True when a suggestion for this pattern was already dismissed or muted —
 *  the curator must not re-propose something the user has already said no to. */
export function patternHasResolvedSuggestion(patternId: string): boolean {
  if (!db) return false
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM suggestions WHERE pattern_id = ? AND status IN ('dismissed','never','accepted')")
    .get(patternId) as { c: number }
  return row.c > 0
}
