import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideAutoStart, type ActivitySince } from './github-gate'
import type { GithubItem } from './github-store'

// The cases here are replays of real history from 2026-09-02, when the panel
// posted five reviews on Trilogy-Care/tc-assistant#349 off ONE review request.
// See the todo "GitHub auto-review: mention / my-pr-activity items have no
// re-trigger gate" for the full forensics.

const LOGIN = 'RyJTrilogyCare'

function item(over: Partial<GithubItem> = {}): GithubItem {
  return {
    id: '25401355925',
    kind: 'review-request',
    repo: 'Trilogy-Care/tc-assistant',
    prNumber: 349,
    title: 'feat(agent-io): let a triage run choose how much of the backlog it can hold',
    author: 'TC-Mehrnaz-Hesari',
    htmlUrl: 'https://github.com/Trilogy-Care/tc-assistant/pull/349',
    prState: 'open',
    updatedAt: '2026-09-02T02:02:09Z',
    unread: true,
    latestCommentUrl: null,
    headSha: '7f2f1940',
    notificationReason: 'review_requested',
    ...over,
  }
}

const never: ActivitySince = async () => {
  throw new Error('activitySince must not be consulted for this kind')
}
const bodies = (...b: string[]): ActivitySince => async () => b
const unreadable: ActivitySince = async () => null

// ── review-request ──────────────────────────────────────────────────────────

test('review-request: a live request starts', async () => {
  const d = await decideAutoStart(item({ reviewRequested: true }), undefined, LOGIN, never)
  assert.equal(d.start, true)
})

test('review-request: answered and not re-requested does not start', async () => {
  const d = await decideAutoStart(
    item({ reviewRequested: false }),
    item({ respondedAt: '2026-09-01T23:55:02Z' }),
    LOGIN,
    never,
  )
  assert.equal(d.start, false)
  assert.match(d.why, /not re-requested/)
})

test('review-request: an explicit re-request restarts it', async () => {
  const d = await decideAutoStart(
    item({ reviewRequested: true, headSha: 'aaaa1111' }),
    item({ respondedAt: '2026-09-01T23:55:02Z', respondedHeadSha: '22094532' }),
    LOGIN,
    never,
  )
  assert.equal(d.start, true)
})

test('review-request: head-SHA backstop holds when reviewRequested fails open', async () => {
  // The round-2 shape: login unresolved, so reviewRequested is undefined and the
  // requested_reviewers gate cannot fire. The SHA stamp still refuses a second
  // pass over the same commit.
  const d = await decideAutoStart(
    item({ reviewRequested: undefined, headSha: '22094532' }),
    item({ respondedAt: '2026-09-01T23:55:02Z', respondedHeadSha: '22094532' }),
    null,
    never,
  )
  assert.equal(d.start, false)
  assert.match(d.why, /already responded to/)
})

test('review-request: a new commit gets through the backstop', async () => {
  const d = await decideAutoStart(
    item({ reviewRequested: undefined, headSha: 'fff259d4' }),
    item({ respondedAt: '2026-09-02T00:22:55Z', respondedHeadSha: '22094532' }),
    null,
    never,
  )
  assert.equal(d.start, true)
})

// ── mention ─────────────────────────────────────────────────────────────────

test('mention: first activity on an unanswered thread starts', async () => {
  const d = await decideAutoStart(item({ kind: 'mention', notificationReason: 'mention' }), undefined, LOGIN, never)
  assert.equal(d.start, true)
})

test('mention: #349 round 4 — pushes with nobody naming us does not start', async () => {
  const d = await decideAutoStart(
    item({ kind: 'mention', notificationReason: 'mention' }),
    item({ respondedAt: '2026-09-02T01:07:05Z' }),
    LOGIN,
    bodies(),
  )
  assert.equal(d.start, false)
  assert.match(d.why, /no @RyJTrilogyCare/)
})

test('mention: #348 — another reviewer posting their own review does not start', async () => {
  const d = await decideAutoStart(
    item({ kind: 'mention', notificationReason: 'mention', prNumber: 348 }),
    item({ respondedAt: '2026-09-01T23:54:19Z' }),
    LOGIN,
    bodies('## Review\n\nReviewed at `bdde5028`. Suite green: 35 passed.'),
  )
  assert.equal(d.start, false)
})

test('mention: #349 round 5 — a comment naming us starts, even at an already-reviewed head', async () => {
  const d = await decideAutoStart(
    item({ kind: 'mention', notificationReason: 'mention', headSha: '7f2f1940' }),
    item({ respondedAt: '2026-09-02T02:30:42Z', respondedHeadSha: '7f2f1940' }),
    LOGIN,
    bodies('## Round 2 pushed — and an apology for the gap\n\n@RyJTrilogyCare @MorganLi-TrilogyCare'),
  )
  assert.equal(d.start, true)
  assert.match(d.why, /wrote @RyJTrilogyCare/)
})

test('mention: the login match is case-insensitive', async () => {
  const d = await decideAutoStart(
    item({ kind: 'mention', notificationReason: 'mention' }),
    item({ respondedAt: '2026-09-02T01:07:05Z' }),
    LOGIN,
    bodies('thoughts @ryjtrilogycare?'),
  )
  assert.equal(d.start, true)
})

test('mention: team mentions fail open — the body carries @org/team, not the login', async () => {
  const d = await decideAutoStart(
    item({ kind: 'mention', notificationReason: 'team_mention' }),
    item({ respondedAt: '2026-09-02T01:07:05Z' }),
    LOGIN,
    never,
  )
  assert.equal(d.start, true)
})

test('mention: unreadable activity fails open', async () => {
  const d = await decideAutoStart(
    item({ kind: 'mention', notificationReason: 'mention' }),
    item({ respondedAt: '2026-09-02T01:07:05Z' }),
    LOGIN,
    unreadable,
  )
  assert.equal(d.start, true)
  assert.match(d.why, /failing open/)
})

test('mention: unknown login fails open', async () => {
  const d = await decideAutoStart(
    item({ kind: 'mention', notificationReason: 'mention' }),
    item({ respondedAt: '2026-09-02T01:07:05Z' }),
    null,
    never,
  )
  assert.equal(d.start, true)
})

// ── my-pr-activity ──────────────────────────────────────────────────────────

test('my-pr-activity stays ungated, including at an already-answered head', async () => {
  const d = await decideAutoStart(
    item({ kind: 'my-pr-activity', notificationReason: 'author' }),
    item({ respondedAt: '2026-09-02T02:30:42Z', respondedHeadSha: '7f2f1940' }),
    LOGIN,
    never,
  )
  assert.equal(d.start, true)
})
