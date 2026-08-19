// Unit tests for the session-archiving gates, process-tree classification and
// archived-message queue. Run with: npm test (node --test).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ArchivedMessageQueue,
  createActivity,
  evaluateGates,
  findBlockingDescendants,
  isWakeupToolUse,
  noteHookStatus,
  noteInput,
  noteOutput,
  notePostToolUse,
  noteUserPrompt,
  parsePsOutput,
  sweepActivity,
  DEFAULT_NOISE_BYTES_PER_SWEEP,
  type ArchiveGateConfig,
} from './archive-core.ts'

const CONFIG: ArchiveGateConfig = {
  thresholdMs: 30 * 60_000,
  noiseBytesPerSweep: DEFAULT_NOISE_BYTES_PER_SWEEP,
}
const T0 = 1_000_000
const PAST_THRESHOLD = T0 + CONFIG.thresholdMs + 1

/** An activity that satisfies gates 1/2/4 at PAST_THRESHOLD. */
function idleActivity(): ReturnType<typeof createActivity> {
  const a = createActivity(T0)
  noteHookStatus(a, 'idle', T0)
  return a
}

// ── Gate 1: hook status ──────────────────────────────────────────────────────

test('gate 1: only hook status idle is archivable', () => {
  for (const status of ['unknown', 'working', 'permission'] as const) {
    const a = createActivity(T0)
    noteHookStatus(a, status, T0)
    const v = evaluateGates(a, CONFIG, PAST_THRESHOLD)
    assert.equal(v.archivable, false, `status ${status} must block`)
  }
  assert.equal(evaluateGates(idleActivity(), CONFIG, PAST_THRESHOLD).archivable, true)
})

test('gate 1: a session that never produced hooks never archives', () => {
  const a = createActivity(T0)
  assert.equal(evaluateGates(a, CONFIG, PAST_THRESHOLD).archivable, false)
})

// ── Gate 2: quiet threshold ──────────────────────────────────────────────────

test('gate 2: not archivable before the threshold elapses', () => {
  const a = idleActivity()
  assert.equal(evaluateGates(a, CONFIG, T0 + CONFIG.thresholdMs - 1).archivable, false)
  assert.equal(evaluateGates(a, CONFIG, T0 + CONFIG.thresholdMs).archivable, true)
})

test('gate 2: user input resets the quiet clock', () => {
  const a = idleActivity()
  noteInput(a, T0 + 10 * 60_000)
  assert.equal(evaluateGates(a, CONFIG, PAST_THRESHOLD).archivable, false)
  assert.equal(evaluateGates(a, CONFIG, T0 + 10 * 60_000 + CONFIG.thresholdMs).archivable, true)
})

test('gate 2: a working hook resets the quiet clock; idle/permission do not', () => {
  const a = idleActivity()
  noteHookStatus(a, 'working', T0 + 5 * 60_000)
  noteHookStatus(a, 'idle', T0 + 5 * 60_000) // Stop right after — state, not activity
  assert.equal(evaluateGates(a, CONFIG, PAST_THRESHOLD).archivable, false)
  assert.equal(evaluateGates(a, CONFIG, T0 + 5 * 60_000 + CONFIG.thresholdMs).archivable, true)
})

test('gate 2: above-noise output during a sweep resets the quiet clock', () => {
  const a = idleActivity()
  noteOutput(a, CONFIG.noiseBytesPerSweep + 1)
  sweepActivity(a, CONFIG, T0 + 20 * 60_000)
  assert.equal(evaluateGates(a, CONFIG, PAST_THRESHOLD).archivable, false)
})

test('gate 2: sub-noise output (title/statusline chatter) does not block', () => {
  const a = idleActivity()
  noteOutput(a, 100)
  sweepActivity(a, CONFIG, T0 + 20 * 60_000)
  assert.equal(evaluateGates(a, CONFIG, PAST_THRESHOLD).archivable, true)
})

test('gate 2: sweeps consume the byte counter (noise does not accumulate)', () => {
  const a = idleActivity()
  for (let i = 0; i < 10; i++) {
    noteOutput(a, CONFIG.noiseBytesPerSweep) // exactly at the floor, per sweep
    sweepActivity(a, CONFIG, T0 + i * 30_000)
  }
  assert.equal(evaluateGates(a, CONFIG, PAST_THRESHOLD).archivable, true)
})

// ── Gate 4: pending background work (turn-ending wakeup tools) ───────────────

test('wakeup detection: turn-ending tools flag; ordinary tools do not', () => {
  assert.equal(isWakeupToolUse('ScheduleWakeup', {}), true)
  assert.equal(isWakeupToolUse('Monitor', {}), true)
  assert.equal(isWakeupToolUse('Workflow', {}), true)
  assert.equal(isWakeupToolUse('TaskCreate', {}), true)
  assert.equal(isWakeupToolUse('Read', {}), false)
  assert.equal(isWakeupToolUse('Edit', {}), false)
  assert.equal(isWakeupToolUse(undefined, {}), false)
})

test('wakeup detection: Agent defaults to background; explicit foreground does not flag', () => {
  assert.equal(isWakeupToolUse('Agent', {}), true)
  assert.equal(isWakeupToolUse('Agent', { run_in_background: true }), true)
  assert.equal(isWakeupToolUse('Agent', { run_in_background: false }), false)
})

test('wakeup detection: Bash flags only when explicitly backgrounded', () => {
  assert.equal(isWakeupToolUse('Bash', { command: 'ls' }), false)
  assert.equal(isWakeupToolUse('Bash', { command: 'npm run dev', run_in_background: true }), true)
})

test('gate 4: wakeup PostToolUse blocks; next user prompt clears', () => {
  const a = idleActivity()
  notePostToolUse(a, 'ScheduleWakeup', {})
  assert.equal(evaluateGates(a, CONFIG, PAST_THRESHOLD).archivable, false)
  const promptAt = T0 + 60_000
  noteUserPrompt(a, promptAt)
  noteHookStatus(a, 'idle', promptAt + 1000)
  assert.equal(evaluateGates(a, CONFIG, promptAt + CONFIG.thresholdMs - 1).archivable, false) // prompt reset the clock
  assert.equal(evaluateGates(a, CONFIG, promptAt + CONFIG.thresholdMs).archivable, true)
})

// ── Gate 3: process-tree classification ──────────────────────────────────────

const SID = '4dff90e7-87ec-4f05-a742-a1fb87a41eeb'
const INBOX = `/Users/u/Library/Application Support/session-manager/messages/${SID}/inbox.txt`
const SNAP = '/Users/u/.claude/shell-snapshots/snapshot-zsh-1787-x.sh'

test('ps parsing: pid/ppid/command extracted, malformed lines dropped', () => {
  const procs = parsePsOutput('  10  1 /usr/bin/foo --bar\nnot a proc line\n 11 10 tail -f x\n')
  assert.deepEqual(procs, [
    { pid: 10, ppid: 1, command: '/usr/bin/foo --bar' },
    { pid: 11, ppid: 10, command: 'tail -f x' },
  ])
})

test('gate 3: inbox-tail monitor (zsh wrapper + tail) is allowlisted', () => {
  const procs = parsePsOutput([
    `100 1 claude --session-id ${SID}`,
    `200 100 /bin/zsh -c source ${SNAP} && eval 'tail -f "${INBOX}"' < /dev/null`,
    `201 200 tail -f ${INBOX}`,
  ].join('\n'))
  assert.deepEqual(findBlockingDescendants(procs, 100, SID), [])
})

test('gate 3: run_in_background shell wrapper (dev server) blocks, with its subtree', () => {
  const procs = parsePsOutput([
    `100 1 claude`,
    `200 100 /bin/zsh -c source ${SNAP} && eval 'npm run dev' < /dev/null`,
    `201 200 node /proj/node_modules/.bin/vite`,
  ].join('\n'))
  const blockers = findBlockingDescendants(procs, 100, SID)
  assert.equal(blockers.length, 2)
  assert.ok(blockers[1].includes('vite'))
})

test('gate 3: stdio MCP servers (non-shell direct children) are ignored', () => {
  const procs = parsePsOutput([
    `100 1 claude`,
    `300 100 node /opt/homebrew/lib/node_modules/obsidian-mcp/build/main.js /vault`,
    `301 100 /Users/u/.local/bin/fff-mcp`,
    `302 100 node /Users/u/github/session-manager/out/main/mcp-server.js`,
  ].join('\n'))
  assert.deepEqual(findBlockingDescendants(procs, 100, SID), [])
})

test('gate 3: MCP-internal transient shells (sh -c git …) do NOT block', () => {
  const procs = parsePsOutput([
    `100 1 claude`,
    `300 100 /Users/u/.local/bin/fff-mcp`,
    `310 300 sh -c git status --porcelain`,
  ].join('\n'))
  assert.deepEqual(findBlockingDescendants(procs, 100, SID), [])
})

test('gate 3: a plain shell direct child (no snapshot marker) still blocks', () => {
  const procs = parsePsOutput([
    `100 1 claude`,
    `400 100 /bin/bash -c ./long-runner.sh`,
  ].join('\n'))
  assert.equal(findBlockingDescendants(procs, 100, SID).length, 1)
})

test('gate 3: another session\'s inbox tail is NOT allowlisted for this session', () => {
  const otherInbox = INBOX.replace(SID, 'other-session-id')
  const procs = parsePsOutput([
    `100 1 claude`,
    `200 100 /bin/zsh -c source ${SNAP} && eval 'tail -f "${otherInbox}"' < /dev/null`,
  ].join('\n'))
  assert.equal(findBlockingDescendants(procs, 100, SID).length, 1)
})

test('gate 3: unrelated processes outside the session tree are ignored', () => {
  const procs = parsePsOutput([
    `100 1 claude`,
    `999 1 /bin/zsh -il`,
  ].join('\n'))
  assert.deepEqual(findBlockingDescendants(procs, 100, SID), [])
})

// ── Archived-message queue ───────────────────────────────────────────────────

test('queue: drain returns messages in arrival order and clears', () => {
  const q = new ArchivedMessageQueue()
  q.enqueue('s1', 'first', 'parent', 1)
  q.enqueue('s1', 'second', null, 2)
  q.enqueue('s2', 'other', null, 3)
  assert.equal(q.size('s1'), 2)
  const drained = q.drain('s1')
  assert.deepEqual(drained.map((m) => m.message), ['first', 'second'])
  assert.deepEqual(drained.map((m) => m.fromSessionId), ['parent', null])
  assert.equal(q.size('s1'), 0)
  assert.deepEqual(q.drain('s1'), [])
  assert.equal(q.size('s2'), 1) // untouched
})

test('queue: forget drops pending messages for a torn-down session', () => {
  const q = new ArchivedMessageQueue()
  q.enqueue('s1', 'msg', null, 1)
  q.forget('s1')
  assert.deepEqual(q.drain('s1'), [])
})
