/**
 * Deterministic pattern mining — NO LLM.
 *
 * A cheap, incremental pass over the observer event log that produces the
 * candidate patterns the (occasional, expensive) reasoning layer later judges.
 * Keeping this stage purely statistical is the whole cost model: the LLM only
 * ever sees a handful of pre-qualified candidates, never the raw stream.
 *
 * Three miners, all per-project:
 *  - frequency   — a single action that recurs (`npm run build`, "open ⌘J")
 *  - sequence    — an n-gram of consecutive actions inside one session
 *  - time-of-day — an action that clusters into a daily window
 *
 * Incremental via a watermark (the last processed event id) stored in `meta`,
 * so an interrupted pass resumes exactly where it stopped and no observation is
 * ever double-counted. Sequence mining needs a little context across batch
 * boundaries, so the tail of each session's stream is carried in the watermark
 * record too.
 */

import { createHash } from 'node:crypto'
import {
  eventsAfter,
  getMeta,
  getMetaNumber,
  inTransaction,
  setMeta,
  setMetaNumber,
  upsertPatternObservations,
  pruneOldEvents,
  pruneStalePatterns,
} from './db'
// Pure token normalisation lives in ./tokens (a leaf module with no imports)
// so the collapse rules can be unit-tested without a database.
import {
  actionToken,
  delegatedSpawnParent,
  delegationSignature,
  fanoutBucket,
  isDelegationMessage,
  roundsBucket,
  TOD_BUCKET_HOURS,
} from './tokens'
export { actionToken, commandShape } from './tokens'

/** meta keys. */
const WATERMARK_KEY = 'mining.watermark'
const CARRY_KEY = 'mining.carry'
const LAST_RUN_KEY = 'mining.lastRunAt'
const DELEGATIONS_KEY = 'mining.delegations'

/**
 * How long a delegation must go quiet before it counts as finished.
 *
 * Completion is keyed on QUIESCENCE rather than on the children ending,
 * because `session:end` is not a reliable finish signal: it fires from
 * cleanupSession when the PTY goes away, and a child that has done its work
 * just sits at its prompt until something kills it — possibly hours later, or
 * at app quit. Waiting for it would mean most delegations never emit at all.
 */
const DELEGATION_SETTLE_MS = 30 * 60_000

/** A delegation still accumulating after this long is emitted anyway, so a
 *  session that trickles messages all day cannot stay open forever. */
const DELEGATION_MAX_AGE_MS = 24 * 3_600_000

/** Bound on carried state, so the meta blob cannot grow without limit. */
const MAX_OPEN_DELEGATIONS = 50

/** Events processed per pass. Bounded so a long-idle app catching up on a
 *  large backlog can't block the main process for more than a beat. */
const BATCH_LIMIT = 5000

/** n-gram lengths mined. 2 and 3 cover "build then test" and
 *  "edit → build → test" without exploding the candidate space. */
const NGRAM_SIZES = [2, 3]

/** An action must repeat at least this many times in one pass' window before
 *  it is even written as a candidate — filters pure noise at the source. */
const MIN_OCCURRENCES = 2

export interface MiningResult {
  processed: number
  patternsTouched: number
  watermark: number
  prunedEvents: number
  prunedPatterns: number
}

/** Human label for a pattern signature — what the user (and the curator) reads. */
function labelFor(type: PatternType, signature: string, meta: Record<string, unknown>): string {
  switch (type) {
    case 'frequency':
      return describeSessionSignature(signature) ?? `Repeatedly runs \`${prettyToken(signature)}\``
    case 'sequence':
      return `Repeats the sequence ${signature.split('→').map(prettyToken).map((t) => `\`${t}\``).join(' → ')}`
    case 'time-of-day': {
      const hour = Number(meta.bucketHour ?? 0)
      const end = (hour + TOD_BUCKET_HOURS) % 24
      const window = `around ${pad2(hour)}:00–${pad2(end)}:00`
      const session = describeSessionSignature(signature)
      return session ? `${session}, ${window}` : `Does \`${prettyToken(signature)}\` ${window}`
    }
    case 'delegation': {
      // Prose, not a token: this is the one pattern whose whole point is a
      // shape the curator has to reason about rather than a command to repeat.
      const fanout = String(meta.fanout ?? '?')
      const rounds = String(meta.rounds ?? '0')
      const plural = fanout === '1' ? '' : 's'
      return rounds === '0'
        ? `Spawns ${fanout} child session${plural} from one session and lets them run`
        : `Spawns ${fanout} child session${plural} from one session and exchanges ${rounds} messages with them`
    }
  }
}

function pad2(n: number): string { return String(n).padStart(2, '0') }

/** Strip the internal namespace prefix for display. */
function prettyToken(token: string): string {
  return token.replace(/^(bash|ui|mcp|session):/, '')
}

/**
 * Prose for a session-lifecycle signature, or null when it is not one.
 *
 * `session:spawn:agent:code-reviewer:delegated` is precise but reads as noise,
 * and the curator judges patterns from their LABEL — a cryptic one produces a
 * worse decision, or a proposal that quotes gibberish back at the user.
 */
function describeSessionSignature(signature: string): string | null {
  const parts = signature.split(':')
  if (parts[0] !== 'session' || parts.length < 3) return null
  const [, action, kind, ...rest] = parts
  const delegated = rest[rest.length - 1] === 'delegated'
  const agent = (delegated ? rest.slice(0, -1) : rest).join(':')
  const verb = action === 'spawn' ? 'Starts' : 'Ends'
  const what = agent ? `the \`${agent}\` agent` : `a ${kind} session`
  return delegated ? `${verb} ${what} from another session` : `${verb} ${what}`
}

function patternId(project: string | null, type: string, signature: string): string {
  return createHash('sha1').update(`${project ?? '*'}\u0000${type}\u0000${signature}`).digest('hex').slice(0, 16)
}

/** Local calendar day for an event — the unit distinct-day support counts in. */
function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

// ── Accumulator ─────────────────────────────────────────────────────────────

type PatternType = 'frequency' | 'sequence' | 'time-of-day' | 'delegation'

interface Bucket {
  project: string | null
  type: PatternType
  signature: string
  count: number
  days: Set<string>
  firstSeen: number
  lastSeen: number
  meta: Record<string, unknown>
}

function bump(
  buckets: Map<string, Bucket>,
  project: string | null,
  type: Bucket['type'],
  signature: string,
  ts: number,
  meta: Record<string, unknown> = {},
): void {
  const key = `${project ?? '*'}|${type}|${signature}`
  const existing = buckets.get(key)
  if (existing) {
    existing.count += 1
    existing.days.add(dayKey(ts))
    existing.firstSeen = Math.min(existing.firstSeen, ts)
    existing.lastSeen = Math.max(existing.lastSeen, ts)
    return
  }
  buckets.set(key, {
    project, type, signature,
    count: 1,
    days: new Set([dayKey(ts)]),
    firstSeen: ts,
    lastSeen: ts,
    meta,
  })
}

/**
 * How many times a pattern must occur WITHIN one pass to be worth storing.
 *
 * MIN_OCCURRENCES exists to keep one-off noise out of the table, and that is
 * right for commands and file edits — they arrive in bulk. It is wrong for the
 * deliberate, low-volume acts: you spawn a given agent once in a two-hour
 * window, not twice, and you run one implement/review delegation, not two. At
 * a threshold of 2 those are discarded on every pass and never accumulate the
 * distinct days they need to promote — the recurrence that matters is ACROSS
 * days, and the day count can only grow if the row is written at all.
 */
function minCountFor(b: Bucket): number {
  if (b.type === 'delegation') return 1
  if (b.signature.startsWith('session:')) return 1
  return MIN_OCCURRENCES
}

/** Per-session tail carried across batches so an n-gram straddling a batch
 *  boundary is still counted exactly once. */
type Carry = Record<string, string[]>

function readCarry(): Carry {
  try { return JSON.parse(getMeta(CARRY_KEY) ?? '{}') as Carry } catch { return {} }
}

/**
 * A delegation still being accumulated, keyed by the PARENT session id.
 *
 * Carried across passes because a delegation routinely outlives one mining
 * window: the spawn lands in this batch, the messages in the next.
 */
interface OpenDelegation {
  project: string | null
  firstSeen: number
  lastActivity: number
  /** Children spawned by this parent. */
  fanout: number
  /** Messages the parent sent while driving them. */
  rounds: number
}
type OpenDelegations = Record<string, OpenDelegation>

function readOpenDelegations(): OpenDelegations {
  try { return JSON.parse(getMeta(DELEGATIONS_KEY) ?? '{}') as OpenDelegations } catch { return {} }
}

// ── The pass ────────────────────────────────────────────────────────────────

/**
 * Process every event past the watermark into candidate patterns. Cheap enough
 * to run in-process on the main thread: one indexed sequential scan plus
 * in-memory counting, then one upsert per touched pattern.
 */
export function runMiningPass(opts: { now?: number } = {}): MiningResult {
  const now = opts.now ?? Date.now()
  const watermark = getMetaNumber(WATERMARK_KEY, 0)
  const events = eventsAfter(watermark, BATCH_LIMIT)

  // NOTE: a pass with no new events still has work to do. Delegations settle on
  // QUIESCENCE, so the pass that finishes one is precisely the pass where
  // nothing happened — returning early here meant a delegation only ever
  // settled if unrelated activity happened to arrive behind it.
  const hasEvents = events.length > 0

  const buckets = new Map<string, Bucket>()
  const carry = readCarry()
  const openDelegations = readOpenDelegations()
  /** Per-session rolling window of the last (maxN-1) tokens, seeded from carry. */
  const maxN = Math.max(...NGRAM_SIZES)
  const streams = new Map<string, { tokens: string[]; project: string | null }>()

  for (const e of events) {
    // 4. Delegation. Stateful rather than token-counting: it accumulates the
    //    SHAPE of "one session drove several others" — how many children, how
    //    many messages — which is a workflow, not an action, and cannot be
    //    expressed as an n-gram because the children mine as separate streams.
    const parent = delegatedSpawnParent(e)
    if (parent) {
      const open = openDelegations[parent] ??= {
        project: e.project, firstSeen: e.ts, lastActivity: e.ts, fanout: 0, rounds: 0,
      }
      open.fanout += 1
      open.lastActivity = Math.max(open.lastActivity, e.ts)
    } else if (e.sessionId && openDelegations[e.sessionId] && isDelegationMessage(e)) {
      const open = openDelegations[e.sessionId]
      open.rounds += 1
      open.lastActivity = Math.max(open.lastActivity, e.ts)
    }

    const token = actionToken(e)
    if (!token) continue

    // 1. Frequency. Prompts are punctuation, not an action worth counting.
    if (token !== 'prompt') {
      bump(buckets, e.project, 'frequency', token, e.ts)

      // 3. Time of day, on the same tokens. Only bucketed for real actions so
      //    the clock signal isn't drowned by session bookkeeping.
      if (!token.startsWith('session:')) {
        const hour = new Date(e.ts).getHours()
        const bucketHour = Math.floor(hour / TOD_BUCKET_HOURS) * TOD_BUCKET_HOURS
        bump(buckets, e.project, 'time-of-day', token, e.ts, { bucketHour })
      }
    }

    // 2. Sequences, within one session's stream.
    const sessionKey = e.sessionId ?? `-${e.project ?? '*'}`
    let stream = streams.get(sessionKey)
    if (!stream) {
      stream = { tokens: [...(carry[sessionKey] ?? [])], project: e.project }
      streams.set(sessionKey, stream)
    }
    stream.tokens.push(token)
    for (const n of NGRAM_SIZES) {
      if (stream.tokens.length < n) continue
      const gram = stream.tokens.slice(-n)
      // A sequence of one repeated token is the frequency pattern again.
      if (new Set(gram).size === 1) continue
      bump(buckets, e.project, 'sequence', gram.join('→'), e.ts)
    }
    if (stream.tokens.length > maxN) stream.tokens = stream.tokens.slice(-(maxN - 1))
  }

  // Settle finished delegations into pattern buckets. A delegation is done
  // when it has gone quiet (see DELEGATION_SETTLE_MS) — or when it has simply
  // been open too long. Dated by its FIRST spawn, so the distinct-day count
  // reflects when the work started, not when we noticed it stopped.
  for (const [parentId, open] of Object.entries(openDelegations)) {
    const quiet = now - open.lastActivity >= DELEGATION_SETTLE_MS
    if (!quiet && now - open.firstSeen < DELEGATION_MAX_AGE_MS) continue
    delete openDelegations[parentId]
    if (open.fanout === 0) continue
    bump(
      buckets,
      open.project,
      'delegation',
      delegationSignature(open.fanout, open.rounds),
      open.firstSeen,
      { fanout: fanoutBucket(open.fanout), rounds: roundsBucket(open.rounds) },
    )
  }

  // Keep only the most recently active, so a long-lived app cannot accumulate
  // unbounded carried state in one meta row.
  const trimmedDelegations: OpenDelegations = Object.fromEntries(
    Object.entries(openDelegations)
      .sort(([, a], [, b]) => b.lastActivity - a.lastActivity)
      .slice(0, MAX_OPEN_DELEGATIONS),
  )

  const newWatermark = hasEvents ? events[events.length - 1].id : watermark

  // ONE transaction for the whole pass. The counts and the watermark that says
  // "these events are counted" are a single fact, and writing them separately
  // meant a crash in between re-processed events already folded into the
  // pattern table — double-counting up to BATCH_LIMIT observations straight
  // into the support numbers the promotion rule reads. The carry belongs
  // inside for the same reason: without it, the tail of the last session's
  // stream is re-emitted and its cross-batch n-grams counted twice.
  const touched = inTransaction(() => {
    // Persist only patterns that actually repeated in this window — a
    // single occurrence is noise and would bloat the table.
    let n = 0
    for (const b of buckets.values()) {
      if (b.count < minCountFor(b)) continue
      upsertPatternObservations({
        id: patternId(b.project, b.type, b.signature),
        project: b.project,
        type: b.type,
        signature: b.signature,
        label: labelFor(b.type, b.signature, b.meta),
        count: b.count,
        days: [...b.days],
        firstSeen: b.firstSeen,
        lastSeen: b.lastSeen,
        meta: b.meta,
      })
      n++
    }

    // Carry each session's tail forward so cross-batch n-grams are counted
    // once. Only when this pass actually read events: `streams` is empty on an
    // idle pass, and writing it back would erase every session's tail.
    if (hasEvents) {
      const nextCarry: Carry = {}
      for (const [key, stream] of streams) nextCarry[key] = stream.tokens.slice(-(maxN - 1))
      setMeta(CARRY_KEY, JSON.stringify(nextCarry))
      setMetaNumber(WATERMARK_KEY, newWatermark)
    }
    // Outside that guard: an idle pass is exactly when a delegation settles,
    // so its carried state changes even with no events. In the transaction for
    // the same reason as the carry — an open delegation replayed after a crash
    // would double-count its fanout and rounds.
    setMeta(DELEGATIONS_KEY, JSON.stringify(trimmedDelegations))

    return n
  })

  // Outside the transaction: bookkeeping, not part of the "these events are
  // counted" fact. A lost lastRunAt costs a status line, not correctness.
  setMetaNumber(LAST_RUN_KEY, now)

  // Maintenance rides along with mining rather than on its own timer.
  const prunedEvents = pruneOldEvents(now)
  const prunedPatterns = pruneStalePatterns(now)

  console.log(
    `[observer] mining pass: ${events.length} events → ${touched} patterns` +
    ` (watermark ${watermark}→${newWatermark}, pruned ${prunedEvents} events / ${prunedPatterns} patterns)`,
  )

  return {
    processed: events.length,
    patternsTouched: touched,
    watermark: newWatermark,
    prunedEvents,
    prunedPatterns,
  }
}

export function lastMiningRunAt(): number {
  return getMetaNumber(LAST_RUN_KEY, 0)
}

/** True when unprocessed events remain — lets the job runner drain a backlog
 *  across consecutive ticks instead of waiting a full interval per batch. */
export function hasMiningBacklog(): boolean {
  return eventsAfter(getMetaNumber(WATERMARK_KEY, 0), 1).length > 0
}
