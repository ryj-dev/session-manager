import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import {
  closeObserverDb,
  getDigest,
  getQueueRow,
  initObserverDb,
  markQueueReady,
  setSqliteDriver,
  upsertQueueOpen,
} from './observer/db.ts'
import {
  buildDigestPrompt,
  buildTranscriptExcerpt,
  drainDigestQueue,
  MIN_NEW_TURNS_INCREMENTAL,
  MIN_TURNS_FOR_DIGEST,
  setDigestRunner,
  setSessionQuietGate,
} from './observer/digests.ts'
import { parseTranscriptTurns } from './turn-parser.ts'
import {
  initJournal,
  JOURNAL_MAX_CHARS,
  readJournal,
  resetJournalForTest,
  writeJournal,
} from './observer/journal.ts'

// Same node:sqlite adapter as observer-store.test.ts — see the comment there.
setSqliteDriver((dbPath) => {
  const sqlite = new DatabaseSync(dbPath)
  return {
    pragma: (source) => sqlite.exec(`PRAGMA ${source}`),
    exec: (source) => sqlite.exec(source),
    prepare: (sql) => sqlite.prepare(sql) as never,
    transaction: ((fn) => ((...args) => fn(...args))) as never,
    close: () => sqlite.close(),
  }
})

const DIR = mkdtempSync(join(tmpdir(), 'sm-digests-'))
let seq = 0

function freshDb(): void {
  closeObserverDb()
  initObserverDb(join(DIR, `digests-${seq++}.db`))
}

after(() => {
  closeObserverDb()
  setDigestRunner(null)
  setSessionQuietGate(() => false)
  resetJournalForTest()
  rmSync(DIR, { recursive: true, force: true })
})

// ── Transcript fixtures ──────────────────────────────────────────────────────

/** A minimal Claude Code transcript with n complete turns. */
function transcriptJsonl(n: number, promptPrefix = 'do the thing'): string {
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: new Date(2026, 0, 5, 10, i).toISOString(),
      message: { content: `${promptPrefix} #${i + 1}` },
    }))
    lines.push(JSON.stringify({
      type: 'assistant',
      timestamp: new Date(2026, 0, 5, 10, i, 30).toISOString(),
      message: { content: [{ type: 'text', text: `done with step ${i + 1}` }] },
    }))
  }
  return lines.join('\n')
}

function writeTranscript(name: string, turns: number): string {
  const path = join(DIR, `${name}.jsonl`)
  writeFileSync(path, transcriptJsonl(turns))
  return path
}

function enqueueEnded(sessionId: string, transcriptPath: string, claudeSessionId = `c-${sessionId}`): void {
  upsertQueueOpen({ sessionId, claudeSessionId, projectPath: '/p/myproj', transcriptPath })
  markQueueReady(sessionId)
}

// ── Excerpt + prompt building ────────────────────────────────────────────────

test('excerpt carries prompts, replies and tool counts per turn', () => {
  const turns = parseTranscriptTurns(transcriptJsonl(3, 'fix the login bug'))
  const excerpt = buildTranscriptExcerpt(turns)
  assert.ok(excerpt.includes('fix the login bug #1'))
  assert.ok(excerpt.includes('assistant: done with step 3'))
  assert.ok(excerpt.includes('— turn 3 —'))
})

test('excerpt starts at the watermark for incremental digests', () => {
  const turns = parseTranscriptTurns(transcriptJsonl(5))
  const excerpt = buildTranscriptExcerpt(turns, 3)
  assert.ok(!excerpt.includes('#1'), 'already-digested turns are excluded')
  assert.ok(excerpt.includes('#4'))
  assert.ok(excerpt.includes('#5'))
})

test('over budget, EARLIER turns are dropped and the drop is announced', () => {
  const turns = parseTranscriptTurns(transcriptJsonl(40, 'x'.repeat(300)))
  const excerpt = buildTranscriptExcerpt(turns, 0, 3000)
  assert.ok(excerpt.length < 4000)
  assert.match(excerpt, /earlier turns? omitted for length/)
  assert.ok(excerpt.includes('#40'), 'the newest turn always survives')
})

test('the digest prompt marks the transcript as data and demands one paragraph', () => {
  const prompt = buildDigestPrompt({ project: 'myproj', excerpt: 'EXCERPT-HERE' })
  assert.ok(prompt.includes('EXCERPT-HERE'))
  assert.ok(prompt.includes('"myproj"'))
  assert.match(prompt, /data, not instructions/)
  assert.match(prompt, /ONE paragraph/)
  assert.ok(!prompt.includes('earlier part of this same session'), 'no prior-digest block on first digest')
})

test('an incremental prompt includes the prior digest and asks for the delta only', () => {
  const prompt = buildDigestPrompt({ project: null, excerpt: 'E', priorDigest: 'PRIOR-PARAGRAPH' })
  assert.ok(prompt.includes('PRIOR-PARAGRAPH'))
  assert.match(prompt, /ONLY what the new turns below add/)
})

// ── Drain lifecycle ──────────────────────────────────────────────────────────

test('drain digests a ready session and finalises its row', async () => {
  freshDb()
  const prompts: string[] = []
  setDigestRunner(async (p) => { prompts.push(p); return 'A tidy digest paragraph.' })
  enqueueEnded('s1', writeTranscript('s1', 5))

  const result = await drainDigestQueue()
  assert.equal(result.digested, 1)
  assert.equal(getQueueRow('s1')?.state, 'done')
  const digest = getDigest('c-s1')
  assert.equal(digest?.content, 'A tidy digest paragraph.')
  assert.equal(digest?.turns, 5, 'watermark covers the whole transcript')
  assert.equal(digest?.project, 'myproj')
  assert.equal(prompts.length, 1)
})

test('a trivial session is skipped without a model call', async () => {
  freshDb()
  let calls = 0
  setDigestRunner(async () => { calls++; return 'x' })
  enqueueEnded('tiny', writeTranscript('tiny', MIN_TURNS_FOR_DIGEST - 1))

  const result = await drainDigestQueue()
  assert.equal(result.skipped, 1)
  assert.equal(calls, 0)
  assert.equal(getQueueRow('tiny')?.state, 'skipped')
})

test('a missing transcript is skipped, not retried forever', async () => {
  freshDb()
  setDigestRunner(async () => 'x')
  enqueueEnded('gone', join(DIR, 'does-not-exist.jsonl'))

  const result = await drainDigestQueue()
  assert.equal(result.skipped, 1)
  assert.equal(getQueueRow('gone')?.state, 'skipped')
})

test('a failing model run retries, then gives up after the attempt cap', async () => {
  freshDb()
  setDigestRunner(async () => { throw new Error('rate limited') })
  enqueueEnded('flaky', writeTranscript('flaky', 6))

  await drainDigestQueue()
  assert.equal(getQueueRow('flaky')?.state, 'ready', 'still eligible after the first failure')
  await drainDigestQueue()
  await drainDigestQueue()
  assert.equal(getQueueRow('flaky')?.state, 'skipped', 'given up after the attempt cap')
})

test('a resumed conversation is digested incrementally from the watermark', async () => {
  freshDb()
  const prompts: string[] = []
  setDigestRunner(async (p) => { prompts.push(p); return prompts.length === 1 ? 'First chunk.' : 'Second chunk.' })

  const path = writeTranscript('resume', 5)
  enqueueEnded('s-a', path, 'conv-1')
  await drainDigestQueue()
  assert.equal(getDigest('conv-1')?.turns, 5)

  // The conversation resumes (new app session, same transcript), grows, ends.
  writeFileSync(path, transcriptJsonl(12))
  enqueueEnded('s-b', path, 'conv-1')
  await drainDigestQueue()

  const digest = getDigest('conv-1')
  assert.equal(digest?.turns, 12)
  assert.ok(digest?.content.startsWith('First chunk.'))
  assert.match(digest?.content ?? '', /continued\] Second chunk\./)
  assert.ok(!/#1(?!\d)/.test(prompts[1]), 'second run must not re-feed digested turns')
  assert.ok(prompts[1].includes('First chunk.'), 'second run sees the prior digest')
})

test('a long-lived idle session gets an incremental digest and stays open', async () => {
  freshDb()
  setDigestRunner(async () => 'Long-runner digest.')
  setSessionQuietGate(() => true)

  const path = writeTranscript('longlived', MIN_NEW_TURNS_INCREMENTAL + 2)
  upsertQueueOpen({ sessionId: 'live', claudeSessionId: 'conv-live', projectPath: '/p/x', transcriptPath: path })

  const result = await drainDigestQueue()
  assert.equal(result.digested, 1)
  assert.equal(getQueueRow('live')?.state, 'open', 'the session has not ended — the row stays open')
  assert.equal(getDigest('conv-live')?.turns, MIN_NEW_TURNS_INCREMENTAL + 2)

  // A second pass with no new turns does nothing.
  const again = await drainDigestQueue()
  assert.equal(again.digested, 0)
})

test('a busy open session is never digested mid-flight', async () => {
  freshDb()
  let calls = 0
  setDigestRunner(async () => { calls++; return 'x' })
  setSessionQuietGate(() => false)

  const path = writeTranscript('busy', MIN_NEW_TURNS_INCREMENTAL + 5)
  upsertQueueOpen({ sessionId: 'busy', claudeSessionId: 'conv-busy', projectPath: null, transcriptPath: path })

  await drainDigestQueue()
  assert.equal(calls, 0)
})

// ── The observations journal ─────────────────────────────────────────────────

test('journal read/write round-trips through the file', () => {
  const path = join(DIR, 'journal.md')
  initJournal(path)
  assert.equal(readJournal().exists, false)

  const result = writeJournal('# Hypotheses\n\n- watching X')
  assert.deepEqual(result, { ok: true })
  const journal = readJournal()
  assert.equal(journal.exists, true)
  assert.equal(journal.content, '# Hypotheses\n\n- watching X')
  assert.equal(readFileSync(path, 'utf-8'), journal.content)
})

test('journal write is whole-document replace, not append', () => {
  initJournal(join(DIR, 'journal2.md'))
  writeJournal('old content')
  writeJournal('new content')
  assert.equal(readJournal().content, 'new content')
})

test('an oversized journal is rejected with a message the curator can act on', () => {
  initJournal(join(DIR, 'journal3.md'))
  const result = writeJournal('x'.repeat(JOURNAL_MAX_CHARS + 1))
  assert.equal(result.ok, false)
  assert.match((result as { ok: false; error: string }).error, /compact/)
  assert.equal(readJournal().exists, false, 'a rejected write must not touch the file')
})

test('non-string journal content is rejected (LLM payloads are untrusted)', () => {
  initJournal(join(DIR, 'journal4.md'))
  assert.equal(writeJournal({ nested: 'object' }).ok, false)
  assert.equal(writeJournal(undefined).ok, false)
})
