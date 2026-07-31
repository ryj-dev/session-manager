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
import { actionToken, TOD_BUCKET_HOURS } from './tokens'
export { actionToken, commandShape } from './tokens'

/** meta keys. */
const WATERMARK_KEY = 'mining.watermark'
const CARRY_KEY = 'mining.carry'
const LAST_RUN_KEY = 'mining.lastRunAt'

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
function labelFor(type: 'frequency' | 'sequence' | 'time-of-day', signature: string, meta: Record<string, unknown>): string {
  switch (type) {
    case 'frequency':
      return `Repeatedly runs \`${prettyToken(signature)}\``
    case 'sequence':
      return `Repeats the sequence ${signature.split('→').map(prettyToken).map((t) => `\`${t}\``).join(' → ')}`
    case 'time-of-day': {
      const hour = Number(meta.bucketHour ?? 0)
      const end = (hour + TOD_BUCKET_HOURS) % 24
      return `Does \`${prettyToken(signature)}\` around ${pad2(hour)}:00–${pad2(end)}:00`
    }
  }
}

function pad2(n: number): string { return String(n).padStart(2, '0') }

/** Strip the internal namespace prefix for display. */
function prettyToken(token: string): string {
  return token.replace(/^(bash|ui|mcp|session):/, '')
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

interface Bucket {
  project: string | null
  type: 'frequency' | 'sequence' | 'time-of-day'
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

/** Per-session tail carried across batches so an n-gram straddling a batch
 *  boundary is still counted exactly once. */
type Carry = Record<string, string[]>

function readCarry(): Carry {
  try { return JSON.parse(getMeta(CARRY_KEY) ?? '{}') as Carry } catch { return {} }
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

  if (events.length === 0) {
    setMetaNumber(LAST_RUN_KEY, now)
    return { processed: 0, patternsTouched: 0, watermark, prunedEvents: 0, prunedPatterns: 0 }
  }

  const buckets = new Map<string, Bucket>()
  const carry = readCarry()
  /** Per-session rolling window of the last (maxN-1) tokens, seeded from carry. */
  const maxN = Math.max(...NGRAM_SIZES)
  const streams = new Map<string, { tokens: string[]; project: string | null }>()

  for (const e of events) {
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

  const newWatermark = events[events.length - 1].id

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
      if (b.count < MIN_OCCURRENCES) continue
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

    // Carry each session's tail forward so cross-batch n-grams are counted once.
    const nextCarry: Carry = {}
    for (const [key, stream] of streams) nextCarry[key] = stream.tokens.slice(-(maxN - 1))
    setMeta(CARRY_KEY, JSON.stringify(nextCarry))

    setMetaNumber(WATERMARK_KEY, newWatermark)
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
