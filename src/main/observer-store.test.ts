import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DatabaseSync } from 'node:sqlite'

import {
  closeObserverDb,
  countDigests,
  countPendingSuggestions,
  countQueueByState,
  getDigest,
  getMeta,
  getMetaNumber,
  getQueueRow,
  getSuggestion,
  initObserverDb,
  insertSuggestion,
  listDigests,
  listQueueRows,
  listSuggestions,
  markQueueReady,
  markStaleOpenReady,
  bumpQueueAttempts,
  projectKey,
  pruneFinishedQueueRows,
  recentlyResolvedTitles,
  resolveSuggestion,
  setMetaNumber,
  setQueueState,
  setSqliteDriver,
  upsertDigest,
  upsertQueueOpen,
} from './observer/db.ts'
import {
  accrue,
  jobStatuses,
  registerJob,
  resetJobsForTest,
  setIdleGate,
  triggerJobNow,
} from './observer/jobs.ts'

// db.ts takes its path as a parameter precisely so this file can exist: the
// durable digest-queue lifecycle (open → ready → done, launch catch-up, the
// v1→v2 table drop) and the job-debt arithmetic are all state that only shows
// its bugs across MULTIPLE passes and restarts, which is exactly what a live
// app never lets you reproduce.

// better-sqlite3 is a native addon built against ELECTRON's ABI, so plain
// `node --test` cannot load it. Node's built-in SQLite speaks the same dialect
// and covers the handful of calls db.ts makes; the shapes it does not have
// (pragma, transaction) are two lines each. This is a real database — the
// storage semantics under test are SQLite's, not a mock's.
setSqliteDriver((dbPath) => {
  const sqlite = new DatabaseSync(dbPath)
  return {
    pragma: (source) => sqlite.exec(`PRAGMA ${source}`),
    exec: (source) => sqlite.exec(source),
    prepare: (sql) => sqlite.prepare(sql) as never,
    transaction: ((fn) => ((...args) => {
      sqlite.exec('BEGIN')
      try {
        const result = fn(...args)
        sqlite.exec('COMMIT')
        return result
      } catch (err) {
        sqlite.exec('ROLLBACK')
        throw err
      }
    })) as never,
    close: () => sqlite.close(),
  }
})

const DIR = mkdtempSync(join(tmpdir(), 'sm-observer-'))
let seq = 0

function freshDb(): string {
  closeObserverDb()
  const path = join(DIR, `store-${seq++}.db`)
  initObserverDb(path)
  return path
}

/** Reopen the same file — an app restart. */
function reopen(path: string): void {
  closeObserverDb()
  initObserverDb(path)
}

const DAY = 86_400_000
const HOUR = 3_600_000
const T0 = new Date(2026, 0, 5, 10, 0, 0).getTime()

function openRow(sessionId: string, opts?: { claudeSessionId?: string; now?: number }): void {
  upsertQueueOpen({
    sessionId,
    claudeSessionId: opts?.claudeSessionId ?? `c-${sessionId}`,
    projectPath: '/Users/x/projects/proj',
    transcriptPath: `/tmp/${sessionId}.jsonl`,
    now: opts?.now ?? T0,
  })
}

beforeEach(() => { resetJobsForTest() })
after(() => {
  closeObserverDb()
  rmSync(DIR, { recursive: true, force: true })
})

// ── V1 → V2 migration ────────────────────────────────────────────────────────

test('v1 events/patterns tables are dropped on first v2 open', () => {
  closeObserverDb()
  const path = join(DIR, `store-${seq++}.db`)
  // Fabricate a v1 store: events + patterns with rows.
  const raw = new DatabaseSync(path)
  raw.exec(`
    CREATE TABLE events (id INTEGER PRIMARY KEY, payload TEXT);
    CREATE TABLE patterns (id TEXT PRIMARY KEY);
    INSERT INTO events (payload) VALUES ('secret command line');
    INSERT INTO patterns (id) VALUES ('p1');
  `)
  raw.close()

  initObserverDb(path)
  assert.equal(getMeta('schema.v2'), 'done')
  closeObserverDb()

  const check = new DatabaseSync(path)
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  const names = tables.map((t) => t.name)
  check.close()
  assert.ok(!names.includes('events'), 'events table must be gone')
  assert.ok(!names.includes('patterns'), 'patterns table must be gone')
  assert.ok(names.includes('digest_queue'))
  assert.ok(names.includes('suggestions'))
})

// ── Digest queue lifecycle ───────────────────────────────────────────────────

test('a session opens a queue row and ending it makes the row ready', () => {
  freshDb()
  openRow('s1')
  assert.equal(getQueueRow('s1')?.state, 'open')

  markQueueReady('s1', T0 + HOUR)
  const row = getQueueRow('s1')
  assert.equal(row?.state, 'ready')
  assert.equal(row?.endedAt, T0 + HOUR)
})

test('ending a session the queue never saw is a no-op, not a phantom row', () => {
  freshDb()
  markQueueReady('never-seen')
  assert.equal(getQueueRow('never-seen'), null)
})

test('launch catch-up flips every leftover open row to ready', () => {
  const path = freshDb()
  openRow('s1')
  openRow('s2')
  markQueueReady('s2', T0 + 1000) // s2 ended cleanly; s1 was live at app quit

  reopen(path) // the app restarts
  const flipped = markStaleOpenReady(T0 + DAY)
  assert.equal(flipped, 1)
  assert.equal(getQueueRow('s1')?.state, 'ready')
  assert.equal(getQueueRow('s1')?.endedAt, T0 + DAY)
  assert.equal(getQueueRow('s2')?.state, 'ready', 's2 keeps its own earlier end')
  assert.equal(getQueueRow('s2')?.endedAt, T0 + 1000)
})

test('a finalised row reopens when the same session becomes live again', () => {
  freshDb()
  openRow('s1')
  markQueueReady('s1')
  setQueueState('s1', 'done')

  // Archived → digested → user clicks the node and keeps talking.
  openRow('s1', { now: T0 + 2 * HOUR })
  const row = getQueueRow('s1')
  assert.equal(row?.state, 'open')
  assert.equal(row?.endedAt, null)
})

test('a /resume that changes the conversation id resets attempts', () => {
  freshDb()
  openRow('s1', { claudeSessionId: 'conv-a' })
  bumpQueueAttempts('s1')
  bumpQueueAttempts('s1')
  assert.equal(getQueueRow('s1')?.attempts, 2)

  openRow('s1', { claudeSessionId: 'conv-b', now: T0 + 1000 })
  const row = getQueueRow('s1')
  assert.equal(row?.claudeSessionId, 'conv-b')
  assert.equal(row?.attempts, 0, 'a new conversation gets a fresh retry budget')
})

test('finished queue rows are pruned after retention; ready rows are kept', () => {
  freshDb()
  openRow('done-old'); markQueueReady('done-old'); setQueueState('done-old', 'done', T0)
  openRow('ready-old'); markQueueReady('ready-old', T0)

  const pruned = pruneFinishedQueueRows(T0 + 40 * DAY, 30)
  assert.equal(pruned, 1)
  assert.equal(getQueueRow('done-old'), null)
  assert.equal(getQueueRow('ready-old')?.state, 'ready', 'undigested work is never pruned')
})

test('countQueueByState and listQueueRows filter correctly', () => {
  freshDb()
  openRow('a'); openRow('b'); openRow('c')
  markQueueReady('b'); markQueueReady('c')
  assert.equal(countQueueByState('open'), 1)
  assert.equal(countQueueByState('ready'), 2)
  assert.deepEqual(listQueueRows({ state: 'open' }).map((r) => r.sessionId), ['a'])
})

// ── Digests + the incremental watermark ──────────────────────────────────────

test('a digest is keyed by conversation and its turn watermark advances', () => {
  freshDb()
  upsertDigest({ claudeSessionId: 'conv', project: 'proj', turns: 8, content: 'first paragraph', now: T0 })
  assert.equal(getDigest('conv')?.turns, 8)

  upsertDigest({ claudeSessionId: 'conv', project: 'proj', turns: 20, content: 'first paragraph\n\n[cont] second', now: T0 + HOUR })
  const d = getDigest('conv')
  assert.equal(d?.turns, 20)
  assert.ok(d?.content.includes('second'))
  assert.equal(countDigests(), 1, 'an incremental digest extends, never duplicates')
})

test('listDigests({ updatedAfter }) is the curator cursor', () => {
  freshDb()
  upsertDigest({ claudeSessionId: 'old', project: null, turns: 5, content: 'old', now: T0 })
  upsertDigest({ claudeSessionId: 'new', project: null, turns: 5, content: 'new', now: T0 + DAY })
  const fresh = listDigests({ updatedAfter: T0 })
  assert.deepEqual(fresh.map((d) => d.claudeSessionId), ['new'])
})

test('projectKey reduces a path to its basename', () => {
  assert.equal(projectKey('/Users/x/projects/session-manager'), 'session-manager')
  assert.equal(projectKey('C:\\code\\thing'), 'thing')
  assert.equal(projectKey(null), null)
})

// ── Suggestions ──────────────────────────────────────────────────────────────

test('suggestion lifecycle: pending → accepted, counts stay honest', () => {
  freshDb()
  insertSuggestion({ id: 'sg1', title: 'Do a thing', rationale: 'why', kind: 'todo', proposal: { title: 'x' } })
  assert.equal(countPendingSuggestions(), 1)
  assert.equal(getSuggestion('sg1')?.status, 'pending')

  resolveSuggestion('sg1', 'accepted', 'Created todo "x"')
  assert.equal(countPendingSuggestions(), 0)
  assert.equal(getSuggestion('sg1')?.result, 'Created todo "x"')
})

test('recentlyResolvedTitles keeps never-rows forever and recent resolutions only', () => {
  const path = freshDb()
  insertSuggestion({ id: 'a', title: 'Muted forever', rationale: '', kind: 'todo', proposal: {} })
  insertSuggestion({ id: 'b', title: 'Recently dismissed', rationale: '', kind: 'todo', proposal: {} })
  insertSuggestion({ id: 'c', title: 'Still pending', rationale: '', kind: 'todo', proposal: {} })
  resolveSuggestion('a', 'never', null)
  resolveSuggestion('b', 'dismissed', null)
  reopen(path)

  const titles = recentlyResolvedTitles().map((r) => r.title)
  assert.ok(titles.includes('Muted forever'))
  assert.ok(titles.includes('Recently dismissed'))
  assert.ok(!titles.includes('Still pending'), 'pending rows are not "already answered"')
})

test('a v2 suggestion kind round-trips', () => {
  freshDb()
  insertSuggestion({
    id: 'sg2', title: 'Add a rule', rationale: '', kind: 'claude-md',
    proposal: { text: 'Always run the linter.' },
  })
  const row = listSuggestions({ status: 'pending' })[0]
  assert.equal(row.kind, 'claude-md')
  assert.deepEqual(row.proposal, { text: 'Always run the linter.' })
})

// ── Debt accrual, the 2× cap, and persistence across restart ────────────────

function registerNoopJob(id = 'j', everyHours = 2): void {
  registerJob({ id, everyHours, quietMs: 0, run: () => {} })
}

test('debt accrues in app-open time only', () => {
  freshDb()
  registerNoopJob('digests', 2)

  accrue(0)                             // seeds lastTickAt
  accrue(60_000)
  accrue(120_000)
  assert.equal(getMetaNumber('job.digests.debtMs'), 120_000)
})

test('a single accrual is clamped, so a sleeping machine cannot bank hours', () => {
  freshDb()
  registerNoopJob('digests', 2)
  accrue(0)
  accrue(6 * HOUR)                      // laptop lid closed for six hours
  // Clamped to ~2 ticks: that time was not app-open in any meaningful sense.
  assert.equal(getMetaNumber('job.digests.debtMs'), 120_000)
})

test('debt is capped at 2x the interval', () => {
  freshDb()
  registerNoopJob('digests', 2)         // interval 2h → cap 4h
  let t = 0
  accrue(t)
  for (let i = 0; i < 400; i++) { t += 60_000; accrue(t) }   // ~6.6h of ticks
  assert.equal(getMetaNumber('job.digests.debtMs'), 4 * HOUR)

  // Still capped after more time — no stampede is ever queued up.
  for (let i = 0; i < 200; i++) { t += 60_000; accrue(t) }
  assert.equal(getMetaNumber('job.digests.debtMs'), 4 * HOUR)
})

test('debt survives a restart but does not grow while the app is closed', () => {
  const path = freshDb()
  registerNoopJob('digests', 2)
  let t = 0
  accrue(t)
  for (let i = 0; i < 30; i++) { t += 60_000; accrue(t) }
  const owed = getMetaNumber('job.digests.debtMs')
  assert.equal(owed, 30 * 60_000)

  // Quit, a week passes, reopen.
  reopen(path)
  resetJobsForTest()
  registerNoopJob('digests', 2)
  assert.equal(getMetaNumber('job.digests.debtMs'), owed, 'debt must persist across a restart')

  accrue(t + 7 * DAY)                   // first tick after reopening
  assert.equal(
    getMetaNumber('job.digests.debtMs'),
    owed + 120_000,
    'the closed week must not be credited — only the clamped first tick',
  )
})

test('a job is blocked by debt until its interval is owed, then by the idle gate', () => {
  freshDb()
  setIdleGate({ allSessionsIdle: () => true, msSinceLastActivity: () => Number.POSITIVE_INFINITY })
  registerJob({ id: 'curator', everyHours: 1, quietMs: 5 * 60_000, run: () => {} })

  let t = 0
  accrue(t)
  assert.equal(jobStatuses()[0].blockedBy, 'debt')

  for (let i = 0; i < 60; i++) { t += 60_000; accrue(t) }   // one hour owed
  assert.equal(jobStatuses()[0].blockedBy, null, 'eligible once the interval is owed')

  setIdleGate({ allSessionsIdle: () => false, msSinceLastActivity: () => Number.POSITIVE_INFINITY })
  assert.equal(jobStatuses()[0].blockedBy, 'busy')

  setIdleGate({ allSessionsIdle: () => true, msSinceLastActivity: () => 1000 })
  assert.equal(jobStatuses()[0].blockedBy, 'quiet', 'a two-second gap between turns is not a lull')
})

// ── A skipped run keeps its debt ────────────────────────────────────────────

test('a run that skips does not clear the debt', async () => {
  freshDb()
  let calls = 0
  registerJob({ id: 'curator', everyHours: 1, quietMs: 0, run: () => { calls++; return false } })
  setMetaNumber('job.curator.debtMs', 90 * 60_000)

  assert.equal(triggerJobNow('curator'), true)
  await new Promise((r) => setImmediate(r))

  assert.equal(calls, 1)
  assert.equal(
    getMetaNumber('job.curator.debtMs'),
    90 * 60_000,
    '"Run curator now" on a skipped run used to cost a full interval of app-open time',
  )
})

test('a run that does work clears the debt', async () => {
  freshDb()
  registerJob({ id: 'curator', everyHours: 1, quietMs: 0, run: () => true })
  setMetaNumber('job.curator.debtMs', 90 * 60_000)

  triggerJobNow('curator')
  await new Promise((r) => setImmediate(r))
  assert.equal(getMetaNumber('job.curator.debtMs'), 0)
})

test('a run that throws clears the debt, so a broken job cannot spin', async () => {
  freshDb()
  registerJob({ id: 'curator', everyHours: 1, quietMs: 0, run: () => { throw new Error('boom') } })
  setMetaNumber('job.curator.debtMs', 90 * 60_000)

  triggerJobNow('curator')
  await new Promise((r) => setImmediate(r))
  assert.equal(getMetaNumber('job.curator.debtMs'), 0)
})
