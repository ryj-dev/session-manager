/**
 * Observer store — session digests, the digest queue, and the suggestions
 * inbox that back the "continuously curious" background agent.
 *
 * V2: the v1 raw event log and mined pattern tables are GONE (dropped on first
 * open after upgrade — they were the app's most sensitive data store, and the
 * curator no longer reads them). The primary signal is now per-session Haiku
 * digests generated from the transcripts Claude Code already writes to disk;
 * this module stores the durable digest queue, the digests themselves, and the
 * suggestion inbox.
 *
 * SQLite (better-sqlite3, already a dependency for memory embeddings) rather
 * than JSON: the queue must survive app quits (catch-up at next launch is a
 * design requirement) and digests accumulate per Claude conversation. It lives
 * in its own DB file so it can be deleted independently of the embeddings index.
 *
 * Pure module — no electron imports, so the path is passed in and tests can
 * point it anywhere.
 */

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export type SuggestionKind =
  | 'scheduled-task'
  | 'todo'
  | 'skill'
  | 'memory-link'
  | 'todo-cleanup'
  // V2 reflective-curator vocabulary:
  | 'memory-note'
  | 'claude-md'
  | 'use-feature'
  | 'pipeline-candidate'

export const SUGGESTION_KINDS: readonly SuggestionKind[] = [
  'scheduled-task', 'todo', 'skill', 'memory-link', 'todo-cleanup',
  'memory-note', 'claude-md', 'use-feature', 'pipeline-candidate',
]

export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed' | 'never'

export interface SuggestionRow {
  id: string
  /** Vestigial v1 column (mined-pattern provenance). Always null for v2 rows;
   *  kept so historical rows still render. */
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

// ── Digest queue + digests ──────────────────────────────────────────────────

export type DigestQueueState = 'open' | 'ready' | 'done' | 'skipped'

export interface DigestQueueRow {
  /** The app session id (PTY id) — one row per app session sighting. */
  sessionId: string
  /** The Claude conversation id — the transcript's identity. Digest watermarks
   *  key off THIS, so a conversation resumed under a new app session id
   *  continues its digest instead of starting over. */
  claudeSessionId: string
  projectPath: string | null
  transcriptPath: string
  /** open → session live · ready → ended, awaiting digest · done/skipped → final. */
  state: DigestQueueState
  createdAt: number
  updatedAt: number
  endedAt: number | null
  /** Failed digest attempts; rows are given up as 'skipped' after a few. */
  attempts: number
}

export interface DigestRow {
  claudeSessionId: string
  project: string | null
  createdAt: number
  updatedAt: number
  /** Transcript turns covered so far — the incremental-digest watermark. */
  turns: number
  /** The digest text. Incremental updates append dated paragraphs. */
  content: string
}

/**
 * The subset of better-sqlite3 this module actually uses.
 *
 * Named so the driver can be swapped: better-sqlite3 is a native addon built
 * against ELECTRON's ABI (`electron-builder install-app-deps`), so plain
 * `node --test` cannot load it at all. Tests therefore install an adapter over
 * Node's built-in `node:sqlite` — the only way the queue lifecycle and the
 * job-debt arithmetic get covered outside a running app. Production untouched.
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

    CREATE TABLE IF NOT EXISTS digest_queue (
      session_id         TEXT PRIMARY KEY,
      claude_session_id  TEXT NOT NULL,
      project_path       TEXT,
      transcript_path    TEXT NOT NULL,
      state              TEXT NOT NULL DEFAULT 'open',
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      ended_at           INTEGER,
      attempts           INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_digest_queue_state ON digest_queue(state, updated_at);

    CREATE TABLE IF NOT EXISTS digests (
      claude_session_id  TEXT PRIMARY KEY,
      project            TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      turns              INTEGER NOT NULL DEFAULT 0,
      content            TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_digests_updated ON digests(updated_at);

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)

  // V1 → V2 upgrade: destroy the raw event log and mined patterns. This was
  // deliberately destructive by design decision — the event store recorded
  // shell commands and file paths, and v2 has no reader for any of it.
  if (getMeta('schema.v2') !== 'done') {
    try {
      db.exec('DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS patterns;')
      // Reclaim the space — the events table dominated the file.
      try { db.exec('VACUUM') } catch { /* WAL busy — space reclaimed later */ }
      setMeta('schema.v2', 'done')
      console.log('[observer] v1 events/patterns tables dropped (v2 schema)')
    } catch (err) {
      console.error('[observer] v1 table drop failed (will retry next launch):', err)
    }
  }

  console.log('[observer] store ready at', dbPath)
}

export function isObserverDbReady(): boolean {
  return db !== null
}

export function closeObserverDb(): void {
  try { db?.close() } catch { /* already closed */ }
  db = null
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

// ── Digest queue ────────────────────────────────────────────────────────────

function rowToQueue(r: Record<string, unknown>): DigestQueueRow {
  return {
    sessionId: String(r.session_id),
    claudeSessionId: String(r.claude_session_id),
    projectPath: (r.project_path as string | null) ?? null,
    transcriptPath: String(r.transcript_path),
    state: r.state as DigestQueueState,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    endedAt: r.ended_at == null ? null : Number(r.ended_at),
    attempts: Number(r.attempts ?? 0),
  }
}

/**
 * Record that a live session has a transcript worth digesting. Upserts an
 * 'open' row keyed by the app session id; the transcript path and Claude id
 * follow /resume changes. A finalised row ('done'/'skipped') is REOPENED —
 * an archived session resumed under the same app id keeps talking into the
 * same transcript, and the per-conversation turn watermark in `digests`
 * guarantees the already-digested prefix is never digested twice.
 */
export function upsertQueueOpen(input: {
  sessionId: string
  claudeSessionId: string
  projectPath: string | null
  transcriptPath: string
  now?: number
}): void {
  if (!db) return
  const now = input.now ?? Date.now()
  const existing = db.prepare('SELECT * FROM digest_queue WHERE session_id = ?').get(input.sessionId) as
    | Record<string, unknown>
    | undefined
  if (!existing) {
    db.prepare(`
      INSERT INTO digest_queue (session_id, claude_session_id, project_path, transcript_path, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'open', ?, ?)
    `).run(input.sessionId, input.claudeSessionId, input.projectPath, input.transcriptPath, now, now)
    return
  }
  const conversationChanged = rowToQueue(existing).claudeSessionId !== input.claudeSessionId
  db.prepare(`
    UPDATE digest_queue
       SET claude_session_id = ?, project_path = ?, transcript_path = ?,
           state = 'open', updated_at = ?, ended_at = NULL,
           attempts = CASE WHEN ? THEN 0 ELSE attempts END
     WHERE session_id = ?
  `).run(input.claudeSessionId, input.projectPath, input.transcriptPath, now, conversationChanged ? 1 : 0, input.sessionId)
}

/** Mark a session's queue row ready for digesting (the session ended). A
 *  no-op for sessions the queue never saw (no transcript = nothing to digest). */
export function markQueueReady(sessionId: string, now: number = Date.now()): void {
  if (!db) return
  db.prepare(`
    UPDATE digest_queue SET state = 'ready', ended_at = ?, updated_at = ?
     WHERE session_id = ? AND state = 'open'
  `).run(now, now, sessionId)
}

/** Launch catch-up: every row still 'open' belonged to a previous app run —
 *  those sessions are gone, so their transcripts are ready to digest. Returns
 *  how many rows were flipped. */
export function markStaleOpenReady(now: number = Date.now()): number {
  if (!db) return 0
  return db.prepare(`
    UPDATE digest_queue SET state = 'ready', ended_at = COALESCE(ended_at, ?), updated_at = ?
     WHERE state = 'open'
  `).run(now, now).changes
}

export function setQueueState(sessionId: string, state: DigestQueueState, now: number = Date.now()): void {
  if (!db) return
  db.prepare('UPDATE digest_queue SET state = ?, updated_at = ? WHERE session_id = ?')
    .run(state, now, sessionId)
}

export function bumpQueueAttempts(sessionId: string): number {
  if (!db) return 0
  db.prepare('UPDATE digest_queue SET attempts = attempts + 1 WHERE session_id = ?').run(sessionId)
  const row = db.prepare('SELECT attempts FROM digest_queue WHERE session_id = ?').get(sessionId) as
    | { attempts: number }
    | undefined
  return row?.attempts ?? 0
}

export function getQueueRow(sessionId: string): DigestQueueRow | null {
  if (!db) return null
  const row = db.prepare('SELECT * FROM digest_queue WHERE session_id = ?').get(sessionId) as
    | Record<string, unknown>
    | undefined
  return row ? rowToQueue(row) : null
}

export function listQueueRows(filter?: { state?: DigestQueueState; limit?: number }): DigestQueueRow[] {
  if (!db) return []
  const rows = filter?.state
    ? db.prepare('SELECT * FROM digest_queue WHERE state = ? ORDER BY updated_at ASC LIMIT ?')
        .all(filter.state, filter.limit ?? 100)
    : db.prepare('SELECT * FROM digest_queue ORDER BY updated_at ASC LIMIT ?').all(filter?.limit ?? 100)
  return rows.map((r) => rowToQueue(r as Record<string, unknown>))
}

export function countQueueByState(state: DigestQueueState): number {
  if (!db) return 0
  return (db.prepare('SELECT COUNT(*) AS c FROM digest_queue WHERE state = ?').get(state) as { c: number }).c
}

/** Finalised queue rows older than the retention window are pruned; digests
 *  themselves are kept (they are the curator's memory of the period). */
export function pruneFinishedQueueRows(now: number = Date.now(), retentionDays = 30): number {
  if (!db) return 0
  return db
    .prepare("DELETE FROM digest_queue WHERE state IN ('done','skipped') AND updated_at < ?")
    .run(now - retentionDays * 86_400_000).changes
}

// ── Digests ─────────────────────────────────────────────────────────────────

function rowToDigest(r: Record<string, unknown>): DigestRow {
  return {
    claudeSessionId: String(r.claude_session_id),
    project: (r.project as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    turns: Number(r.turns ?? 0),
    content: String(r.content ?? ''),
  }
}

export function getDigest(claudeSessionId: string): DigestRow | null {
  if (!db) return null
  const row = db.prepare('SELECT * FROM digests WHERE claude_session_id = ?').get(claudeSessionId) as
    | Record<string, unknown>
    | undefined
  return row ? rowToDigest(row) : null
}

/** Insert or extend a digest. `content` REPLACES the stored text (the caller
 *  appends its dated paragraph for incremental digests); `turns` moves the
 *  incremental watermark forward. */
export function upsertDigest(input: {
  claudeSessionId: string
  project: string | null
  turns: number
  content: string
  now?: number
}): void {
  if (!db) return
  const now = input.now ?? Date.now()
  db.prepare(`
    INSERT INTO digests (claude_session_id, project, created_at, updated_at, turns, content)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(claude_session_id) DO UPDATE SET
      project = excluded.project, updated_at = excluded.updated_at,
      turns = excluded.turns, content = excluded.content
  `).run(input.claudeSessionId, input.project, now, now, input.turns, input.content)
}

export function listDigests(filter?: { updatedAfter?: number; limit?: number }): DigestRow[] {
  if (!db) return []
  const rows = filter?.updatedAfter != null
    ? db.prepare('SELECT * FROM digests WHERE updated_at > ? ORDER BY updated_at DESC LIMIT ?')
        .all(filter.updatedAfter, filter?.limit ?? 50)
    : db.prepare('SELECT * FROM digests ORDER BY updated_at DESC LIMIT ?').all(filter?.limit ?? 50)
  return rows.map((r) => rowToDigest(r as Record<string, unknown>))
}

export function countDigests(): number {
  if (!db) return 0
  return (db.prepare('SELECT COUNT(*) AS c FROM digests').get() as { c: number }).c
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
  title: string
  rationale: string
  kind: SuggestionKind
  proposal: Record<string, unknown>
  createdAt?: number
}): void {
  if (!db) return
  db.prepare(`
    INSERT INTO suggestions (id, pattern_id, created_at, title, rationale, kind, proposal_json, status)
    VALUES (?, NULL, ?, ?, ?, ?, ?, 'pending')
    ON CONFLICT(id) DO NOTHING
  `).run(s.id, s.createdAt ?? Date.now(), s.title, s.rationale, s.kind, JSON.stringify(s.proposal))
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

/**
 * Titles the curator must not re-propose: everything the user resolved
 * recently, plus every 'never' regardless of age. With mined patterns gone,
 * this list (injected into the curator prompt) plus its own journal is how
 * "the user already said no" persists across runs.
 */
export function recentlyResolvedTitles(opts?: { recentDays?: number; limit?: number }): Array<{
  title: string
  kind: SuggestionKind
  status: SuggestionStatus
}> {
  if (!db) return []
  const cutoff = Date.now() - (opts?.recentDays ?? 45) * 86_400_000
  const rows = db.prepare(`
    SELECT title, kind, status FROM suggestions
     WHERE status = 'never' OR (status IN ('accepted','dismissed') AND resolved_at >= ?)
     ORDER BY resolved_at DESC LIMIT ?
  `).all(cutoff, opts?.limit ?? 40) as Array<{ title: string; kind: SuggestionKind; status: SuggestionStatus }>
  return rows
}

/** Basename of a project directory — the grouping key digests are tagged with.
 *  (Moved here from the deleted v1 tokens.ts — the one survivor.) */
export function projectKey(projectPath: string | null | undefined): string | null {
  if (!projectPath) return null
  return projectPath.split(/[\\/]/).filter(Boolean).pop() ?? null
}
