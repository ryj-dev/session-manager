import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DatabaseSync } from 'node:sqlite'

import {
  appendEvent,
  closeObserverDb,
  eventsAfter,
  findPromotablePatterns,
  getMeta,
  getMetaNumber,
  getPattern,
  initObserverDb,
  inTransaction,
  listPatterns,
  upsertPatternObservations,
  setMetaNumber,
  setSqliteDriver,
} from './observer/db.ts'
import { runMiningPass, hasMiningBacklog } from './observer/mining.ts'
import {
  accrue,
  jobStatuses,
  registerJob,
  resetJobsForTest,
  setIdleGate,
  triggerJobNow,
} from './observer/jobs.ts'

// db.ts takes its path as a parameter precisely so this file can exist: the
// incremental machinery (watermark, cross-batch carry, day-based promotion,
// debt) is all state that only shows its bugs across MULTIPLE passes and
// restarts, which is exactly what a live app never lets you reproduce.

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

/** A tool event at a fixed instant, so day bucketing is deterministic. */
function toolEvent(tool: string, arg: string | null, ts: number, sessionId = 's1'): void {
  appendEvent({
    kind: 'tool',
    sessionId,
    project: 'proj',
    ts,
    payload: arg ? { tool, arg } : { tool },
  })
}

/** 10:00 local on the given day offset from a fixed base — avoids midnight
 *  boundaries making dayKey flap. */
const BASE = new Date(2026, 0, 5, 10, 0, 0).getTime()
const dayAt = (n: number): number => new Date(2026, 0, 5 + n, 10, 0, 0).getTime()

beforeEach(() => { resetJobsForTest() })
after(() => {
  closeObserverDb()
  rmSync(DIR, { recursive: true, force: true })
})

// ── Watermark: resume across an interrupted pass ────────────────────────────

test('mining resumes at the watermark and never re-counts an event', () => {
  freshDb()
  for (let i = 0; i < 6; i++) toolEvent('Bash', 'npm run build', BASE + i * 1000)

  const first = runMiningPass({ now: BASE })
  assert.equal(first.processed, 6)
  const pattern = listPatterns({ status: 'candidate' }).find((p) => p.signature === 'bash:npm run build')
  assert.ok(pattern, 'frequency pattern should exist')
  assert.equal(pattern.support, 6)

  // Second pass with nothing new: the watermark must hold the line. Before the
  // pass was transactional this is where double-counting showed up.
  const second = runMiningPass({ now: BASE + 1000 })
  assert.equal(second.processed, 0)
  assert.equal(getPattern(pattern.id)?.support, 6)

  // New events are counted exactly once, on top of the old total.
  for (let i = 0; i < 3; i++) toolEvent('Bash', 'npm run build', BASE + 10_000 + i * 1000)
  const third = runMiningPass({ now: BASE + 20_000 })
  assert.equal(third.processed, 3)
  assert.equal(getPattern(pattern.id)?.support, 9)
})

test('a watermark rolled back to zero re-mines from the start, not from nowhere', () => {
  // The failure mode the watermark protects against, made explicit: rewinding
  // it is the same as a crash between the pattern write and the watermark
  // write, and it MUST double-count. That is why the two are one transaction.
  const path = freshDb()
  for (let i = 0; i < 4; i++) toolEvent('Bash', 'npm test', BASE + i * 1000)
  runMiningPass({ now: BASE })
  const id = listPatterns()[0].id
  assert.equal(getPattern(id)?.support, 4)

  setMetaNumber('mining.watermark', 0)
  runMiningPass({ now: BASE + 1000 })
  assert.equal(getPattern(id)?.support, 8, 'rewinding the watermark double-counts — as designed')

  // And the watermark survives a restart, so a reopen does not re-mine.
  const after = getMetaNumber('mining.watermark', 0)
  reopen(path)
  assert.equal(getMetaNumber('mining.watermark', 0), after)
  runMiningPass({ now: BASE + 2000 })
  assert.equal(getPattern(id)?.support, 8)
})

test('hasMiningBacklog reports unprocessed events', () => {
  freshDb()
  assert.equal(hasMiningBacklog(), false)
  toolEvent('Read', '/repo/a.ts', BASE)
  assert.equal(hasMiningBacklog(), true)
  runMiningPass({ now: BASE })
  assert.equal(hasMiningBacklog(), false)
})

// ── Cross-batch n-gram carry ────────────────────────────────────────────────

/** The sequence signatures currently stored. */
function sequenceSignatures(): string[] {
  return listPatterns({ limit: 500 }).filter((p) => p.type === 'sequence').map((p) => p.signature)
}

test('the session tail is carried across a batch boundary', () => {
  freshDb()
  // Pass 1 ends mid-sequence: …build, test.
  toolEvent('Bash', 'npm run build', BASE)
  toolEvent('Bash', 'npm test', BASE + 1000)
  runMiningPass({ now: BASE + 2000 })

  const carry = JSON.parse(getMeta('mining.carry') ?? '{}') as Record<string, string[]>
  assert.deepEqual(carry.s1, ['bash:npm run build', 'bash:npm test'],
    'the tail of each session stream must survive the pass that ended on it')
})

test('an n-gram straddling two passes is counted, not lost at the boundary', () => {
  freshDb()
  // Pass 1 ends mid-sequence.
  toolEvent('Bash', 'npm run build', BASE)
  toolEvent('Bash', 'npm test', BASE + 1000)
  runMiningPass({ now: BASE + 2000 })

  // Pass 2 completes it (test→commit), then repeats the whole cycle so the
  // pair clears MIN_OCCURRENCES. Without the carry the straddling occurrence
  // is missing and the pair is seen once — below the threshold, so it is never
  // written at all. That absence is what this asserts against.
  toolEvent('Bash', 'git commit', BASE + 3000)
  toolEvent('Bash', 'npm run build', BASE + 4000)
  toolEvent('Bash', 'npm test', BASE + 5000)
  toolEvent('Bash', 'git commit', BASE + 6000)
  runMiningPass({ now: BASE + 7000 })

  const straddling = listPatterns({ limit: 500 })
    .find((p) => p.type === 'sequence' && p.signature === 'bash:npm test→bash:git commit')
  assert.ok(straddling, `cross-batch 2-gram missing; got ${sequenceSignatures().join(' | ')}`)
  assert.equal(straddling.support, 2, 'the boundary occurrence plus the in-pass one')

  // A further pass with no new events must not re-emit anything from the carry.
  runMiningPass({ now: BASE + 8000 })
  assert.equal(getPattern(straddling.id)?.support, 2)
})

test('each session carries its own tail, so streams do not bleed together', () => {
  freshDb()
  // Two sessions interleaved in the log, each ending its batch mid-sequence.
  toolEvent('Bash', 'npm run build', BASE, 'sessionA')
  toolEvent('Bash', 'terraform plan', BASE + 500, 'sessionB')
  runMiningPass({ now: BASE + 1000 })

  const carry = JSON.parse(getMeta('mining.carry') ?? '{}') as Record<string, string[]>
  assert.deepEqual(carry.sessionA, ['bash:npm run build'])
  assert.deepEqual(carry.sessionB, ['bash:terraform plan'])

  toolEvent('Bash', 'npm test', BASE + 2000, 'sessionA')
  toolEvent('Bash', 'npm run build', BASE + 3000, 'sessionA')
  toolEvent('Bash', 'npm test', BASE + 4000, 'sessionA')
  runMiningPass({ now: BASE + 5000 })

  const signatures = sequenceSignatures()
  assert.ok(signatures.includes('bash:npm run build→bash:npm test'), signatures.join(' | '))
  // sessionB's command must never be spliced into sessionA's sequence.
  assert.ok(!signatures.some((s) => s.includes('terraform')), signatures.join(' | '))
})

// ── Promotion window: 4 distinct days inside 14 ─────────────────────────────

test('promotion needs 4 DISTINCT days, not 4 occurrences', () => {
  freshDb()
  // 20 runs, all on one afternoon. A frantic day is not a habit.
  for (let i = 0; i < 20; i++) toolEvent('Bash', 'npm run build', BASE + i * 60_000)
  runMiningPass({ now: BASE })

  const sameDay = findPromotablePatterns({ minDistinctDays: 4, windowDays: 14, limit: 10, now: BASE })
  assert.equal(sameDay.length, 0, 'one busy day must not promote')

  // Spread across 4 days instead. Two occurrences per day so each survives the
  // MIN_OCCURRENCES filter inside a single pass.
  freshDb()
  for (let d = 0; d < 4; d++) {
    toolEvent('Bash', 'npm run build', dayAt(d))
    toolEvent('Bash', 'npm run build', dayAt(d) + 60_000)
    runMiningPass({ now: dayAt(d) })
  }
  const promotable = findPromotablePatterns({ minDistinctDays: 4, windowDays: 14, limit: 10, now: dayAt(4) })
  const frequency = promotable.filter((p) => p.type === 'frequency')
  assert.equal(frequency.length, 1, 'four distinct days should promote')
  assert.equal(frequency[0].distinctDays, 4)
  // The same token also promotes as a time-of-day pattern — all 8 runs land in
  // the same 3-hour bucket. That is the miner working, not a duplicate.
  assert.equal(promotable.filter((p) => p.type === 'time-of-day').length, 1)
})

test('three distinct days is one short, and the fourth tips it over', () => {
  freshDb()
  for (let d = 0; d < 3; d++) {
    toolEvent('Bash', 'npm run lint', dayAt(d))
    toolEvent('Bash', 'npm run lint', dayAt(d) + 60_000)
    runMiningPass({ now: dayAt(d) })
  }
  assert.equal(
    findPromotablePatterns({ minDistinctDays: 4, windowDays: 14, limit: 10, now: dayAt(3) }).length,
    0,
  )

  toolEvent('Bash', 'npm run lint', dayAt(3))
  toolEvent('Bash', 'npm run lint', dayAt(3) + 60_000)
  runMiningPass({ now: dayAt(3) })
  assert.equal(
    findPromotablePatterns({ minDistinctDays: 4, windowDays: 14, limit: 10, now: dayAt(3) })
      .filter((p) => p.type === 'frequency').length,
    1,
  )
})

test('days outside the window do not count toward promotion', () => {
  freshDb()
  // Four days, but spread so that only two fall inside a 14-day window.
  for (const d of [0, 1, 20, 21]) {
    toolEvent('Bash', 'npm run e2e', dayAt(d))
    toolEvent('Bash', 'npm run e2e', dayAt(d) + 60_000)
    runMiningPass({ now: dayAt(d) })
  }
  const pattern = listPatterns()[0]
  assert.equal(pattern.distinctDays, 4, 'all four days are recorded...')
  assert.equal(
    findPromotablePatterns({ minDistinctDays: 4, windowDays: 14, limit: 10, now: dayAt(21) }).length,
    0,
    '...but only the two inside the window count',
  )
})

// ── The delegation miner ────────────────────────────────────────────────────
// The one miner that is stateful rather than token-counting: it accumulates
// the SHAPE of "one session drove several others" across passes. Everything
// that can go wrong here only shows up over multiple passes.

/** A delegated spawn: note the event's own sessionId is the CHILD. */
function spawnEvent(child: string, parent: string, ts: number): void {
  appendEvent({
    kind: 'session', sessionId: child, project: 'proj', ts,
    payload: { action: 'spawn', sessionKind: 'user', parentSessionId: parent },
  })
}

/** The parent messaging one of its children. */
function messageEvent(parent: string, ts: number): void {
  appendEvent({
    kind: 'mcp', sessionId: parent, project: 'proj', ts,
    payload: { server: 'session-manager', tool: 'send-message' },
  })
}

const delegations = (): ReturnType<typeof listPatterns> =>
  listPatterns({ limit: 500 }).filter((p) => p.type === 'delegation')

test('a spawn-and-drive workflow is recorded as one delegation', () => {
  freshDb()
  spawnEvent('impl', 'parent', BASE)
  spawnEvent('review', 'parent', BASE + 1000)
  for (let i = 0; i < 5; i++) messageEvent('parent', BASE + 2000 + i * 1000)

  // Still in flight: the pass runs while the work is recent, so nothing emits.
  runMiningPass({ now: BASE + 10_000 })
  assert.equal(delegations().length, 0, 'an in-flight delegation must not emit')

  // An hour later it has gone quiet, so the next pass settles it.
  runMiningPass({ now: BASE + 3_600_000 })
  const [pattern] = delegations()
  assert.ok(pattern, 'a settled delegation should be recorded')
  assert.equal(pattern.signature, 'delegation:fanout=2:rounds=4-9')
  assert.match(pattern.label, /Spawns 2 child sessions.*exchanges 4-9 messages/)
})

test('a settled delegation is emitted exactly once', () => {
  freshDb()
  spawnEvent('child', 'parent', BASE)
  messageEvent('parent', BASE + 1000)
  runMiningPass({ now: BASE + 3_600_000 })
  const id = delegations()[0].id
  assert.equal(getPattern(id)?.support, 1)

  // Later passes must not re-emit it from carried state.
  runMiningPass({ now: BASE + 7_200_000 })
  runMiningPass({ now: BASE + 10_800_000 })
  assert.equal(getPattern(id)?.support, 1)
})

test('a delegation straddling several passes accumulates, not fragments', () => {
  freshDb()
  // Spawn in pass 1, messages in pass 2, more in pass 3 — all one workflow.
  spawnEvent('impl', 'parent', BASE)
  spawnEvent('review', 'parent', BASE + 1000)
  runMiningPass({ now: BASE + 2000 })

  for (let i = 0; i < 3; i++) messageEvent('parent', BASE + 60_000 + i * 1000)
  runMiningPass({ now: BASE + 120_000 })

  for (let i = 0; i < 4; i++) messageEvent('parent', BASE + 180_000 + i * 1000)
  runMiningPass({ now: BASE + 240_000 })

  assert.equal(delegations().length, 0, 'not settled while activity continues')

  runMiningPass({ now: BASE + 3_600_000 })
  const settled = delegations()
  assert.equal(settled.length, 1, 'one workflow, not one per pass')
  // 7 messages total, across three passes — the carry has to survive each one.
  assert.equal(settled[0].signature, 'delegation:fanout=2:rounds=4-9')
})

test('concurrent delegations from different parents stay separate', () => {
  freshDb()
  spawnEvent('a1', 'parentA', BASE)
  spawnEvent('b1', 'parentB', BASE + 500)
  spawnEvent('b2', 'parentB', BASE + 600)
  messageEvent('parentA', BASE + 1000)
  runMiningPass({ now: BASE + 3_600_000 })

  const sigs = delegations().map((p) => p.signature).sort()
  assert.deepEqual(sigs, ['delegation:fanout=1:rounds=1', 'delegation:fanout=2:rounds=0'])
})

test('a hand-started session is not a delegation', () => {
  freshDb()
  // No parentSessionId: the user pressed the hotkey.
  appendEvent({
    kind: 'session', sessionId: 'solo', project: 'proj', ts: BASE,
    payload: { action: 'spawn', sessionKind: 'user' },
  })
  messageEvent('solo', BASE + 1000)
  runMiningPass({ now: BASE + 3_600_000 })
  assert.equal(delegations().length, 0)
})

test('a once-per-pass agent spawn is kept, so it can accumulate days', () => {
  freshDb()
  // You spawn a given agent once in a two-hour window, not twice. At the
  // default threshold of 2 this row is discarded on every pass and can never
  // accumulate the distinct days it needs to promote.
  appendEvent({
    kind: 'session', sessionId: 'c1', project: 'proj', ts: BASE,
    payload: { action: 'spawn', sessionKind: 'agent', agentName: 'code-reviewer', parentSessionId: 'p1' },
  })
  runMiningPass({ now: BASE + 1000 })

  const spawned = listPatterns({ limit: 100 })
    .find((p) => p.signature === 'session:spawn:agent:code-reviewer:delegated')
  assert.ok(spawned, `agent spawn not stored; got ${listPatterns({ limit: 100 }).map((p) => p.signature).join(' | ')}`)
  assert.equal(spawned.support, 1)
})

test('session patterns get prose labels, not raw tokens', () => {
  freshDb()
  // The curator judges a pattern from its LABEL, and its output quotes that
  // label back at the user. `spawn:agent:code-reviewer:delegated` is precise
  // and unreadable; both the decision and the proposal suffer.
  appendEvent({
    kind: 'session', sessionId: 'c1', project: 'proj', ts: BASE,
    payload: { action: 'spawn', sessionKind: 'agent', agentName: 'code-reviewer', parentSessionId: 'p1' },
  })
  runMiningPass({ now: BASE + 1000 })
  const labels = listPatterns({ limit: 100 }).map((p) => p.label)
  assert.ok(
    labels.some((l) => l === 'Starts the `code-reviewer` agent from another session'),
    labels.join(' | '),
  )
  assert.ok(!labels.some((l) => l.includes('Repeatedly runs `spawn:')), labels.join(' | '))
})

test('a one-off shell command is still discarded as noise', () => {
  freshDb()
  // The relaxed threshold must NOT leak to the high-volume kinds, or the
  // pattern table fills with every command ever run once.
  toolEvent('Bash', 'some-one-off-command', BASE)
  runMiningPass({ now: BASE + 1000 })
  assert.equal(listPatterns({ limit: 100 }).length, 0)
})

test('a single delegation is kept — it does not need to repeat within a pass', () => {
  freshDb()
  // MIN_OCCURRENCES would discard this: delegations are rare and deliberate,
  // so requiring two inside one ~2h window would throw away almost all of them.
  spawnEvent('child', 'parent', BASE)
  runMiningPass({ now: BASE + 3_600_000 })
  assert.equal(delegations().length, 1)
})

test('a delegation that never goes quiet is emitted at the age cap', () => {
  freshDb()
  spawnEvent('child', 'parent', BASE)
  // A trickle of messages every 20 minutes, each one resetting the 30-minute
  // settle window, so quiescence never fires. 80 × 20min = ~27h, past the cap.
  let t = BASE
  for (let i = 0; i < 80; i++) {
    t += 20 * 60_000
    messageEvent('parent', t)
    runMiningPass({ now: t + 1000 })
  }
  assert.equal(delegations().length, 1, 'the age cap must force it out eventually')
  assert.equal(delegations()[0].signature, 'delegation:fanout=1:rounds=10+')
})

test('the same delegation shape on four days promotes', () => {
  freshDb()
  for (let d = 0; d < 4; d++) {
    spawnEvent(`impl-${d}`, `parent-${d}`, dayAt(d))
    spawnEvent(`review-${d}`, `parent-${d}`, dayAt(d) + 1000)
    for (let i = 0; i < 5; i++) messageEvent(`parent-${d}`, dayAt(d) + 2000 + i * 1000)
    runMiningPass({ now: dayAt(d) + 3_600_000 })
  }
  const promotable = findPromotablePatterns({ minDistinctDays: 4, windowDays: 14, limit: 10, now: dayAt(4) })
    .filter((p) => p.type === 'delegation')
  assert.equal(promotable.length, 1, 'a delegation habit should reach the curator')
  assert.equal(promotable[0].distinctDays, 4)
  // The label is prose, because this is the one pattern the curator has to
  // reason about as a workflow rather than repeat as a command.
  assert.match(promotable[0].label, /Spawns 2 child sessions/)
})

test('open delegations survive a restart', () => {
  const path = freshDb()
  spawnEvent('child', 'parent', BASE)
  runMiningPass({ now: BASE + 1000 })     // in flight, carried in meta

  reopen(path)
  messageEvent('parent', BASE + 2000)
  runMiningPass({ now: BASE + 3_600_000 })

  const settled = delegations()
  assert.equal(settled.length, 1)
  // rounds=1 proves the carried record was reloaded rather than restarted:
  // a fresh record would have seen the message with no open delegation to
  // attribute it to, and dropped it.
  assert.equal(settled[0].signature, 'delegation:fanout=1:rounds=1')
})

// ── The mining pass is atomic ───────────────────────────────────────────────

test('a failure mid-pass leaves neither the counts nor the watermark behind', () => {
  freshDb()
  for (let i = 0; i < 4; i++) toolEvent('Bash', 'npm run build', BASE + i * 1000)
  runMiningPass({ now: BASE })
  const id = listPatterns().find((p) => p.type === 'frequency')!.id
  const supportBefore = getPattern(id)!.support
  const watermarkBefore = getMetaNumber('mining.watermark', 0)

  // The shape the pass has: pattern upserts, then the watermark, then a throw
  // before the commit. Both halves must vanish — a half-applied pass is what
  // double-counts up to BATCH_LIMIT observations on the next run.
  assert.throws(() => inTransaction(() => {
    upsertPatternObservations({
      id, project: 'proj', type: 'frequency', signature: 'bash:npm run build',
      label: 'x', count: 100, days: ['2026-02-01'], firstSeen: BASE, lastSeen: BASE,
    })
    setMetaNumber('mining.watermark', watermarkBefore + 500)
    throw new Error('crash between the counts and the watermark')
  }), /crash between/)

  assert.equal(getPattern(id)?.support, supportBefore, 'the count must have rolled back')
  assert.equal(getMetaNumber('mining.watermark', 0), watermarkBefore, 'the watermark must have rolled back')
})

// ── Payload guard (the truncation tripwire) ─────────────────────────────────

test('an oversized payload is shrunk, never stored as broken JSON', () => {
  freshDb()
  // Well past the 2000-char payload cap. Slicing the serialised JSON used to
  // cut it mid-token, so the row parsed back as {} — an event with no tool
  // name at all, silently dropped by the miner.
  appendEvent({ kind: 'tool', sessionId: 's', project: 'p', ts: BASE, payload: { tool: 'Bash', arg: 'x'.repeat(9000) } })
  const [event] = eventsAfter(0, 10)
  assert.equal(event.payload.tool, 'Bash', 'the tool name must survive the size cap')
  assert.ok(typeof event.payload.arg === 'string' && event.payload.arg.length > 0)
})

// ── Debt accrual, the 2× cap, and persistence across restart ────────────────

function registerNoopJob(id = 'j', everyHours = 2): void {
  registerJob({ id, everyHours, quietMs: 0, run: () => {} })
}

test('debt accrues in app-open time only', () => {
  freshDb()
  registerNoopJob('mining', 2)

  accrue(0)                             // seeds lastTickAt
  accrue(60_000)
  accrue(120_000)
  assert.equal(getMetaNumber('job.mining.debtMs'), 120_000)
})

test('a single accrual is clamped, so a sleeping machine cannot bank hours', () => {
  freshDb()
  registerNoopJob('mining', 2)
  accrue(0)
  accrue(6 * HOUR)                      // laptop lid closed for six hours
  // Clamped to ~2 ticks: that time was not app-open in any meaningful sense.
  assert.equal(getMetaNumber('job.mining.debtMs'), 120_000)
})

test('debt is capped at 2x the interval', () => {
  freshDb()
  registerNoopJob('mining', 2)          // interval 2h → cap 4h
  let t = 0
  accrue(t)
  for (let i = 0; i < 400; i++) { t += 60_000; accrue(t) }   // ~6.6h of ticks
  assert.equal(getMetaNumber('job.mining.debtMs'), 4 * HOUR)

  // Still capped after more time — no stampede is ever queued up.
  for (let i = 0; i < 200; i++) { t += 60_000; accrue(t) }
  assert.equal(getMetaNumber('job.mining.debtMs'), 4 * HOUR)
})

test('debt survives a restart but does not grow while the app is closed', () => {
  const path = freshDb()
  registerNoopJob('mining', 2)
  let t = 0
  accrue(t)
  for (let i = 0; i < 30; i++) { t += 60_000; accrue(t) }
  const owed = getMetaNumber('job.mining.debtMs')
  assert.equal(owed, 30 * 60_000)

  // Quit, a week passes, reopen.
  reopen(path)
  resetJobsForTest()
  registerNoopJob('mining', 2)
  assert.equal(getMetaNumber('job.mining.debtMs'), owed, 'debt must persist across a restart')

  accrue(t + 7 * DAY)                   // first tick after reopening
  assert.equal(
    getMetaNumber('job.mining.debtMs'),
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
