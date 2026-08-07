/**
 * Prompt-time memory injection.
 *
 * On UserPromptSubmit (mode-gated: off / first prompt only / every prompt),
 * the prompt is embedded and matched against the memory-note index; the top
 * hits are injected into Claude's context via the sync hook's
 * additionalContext, and announced in the transcript via systemMessage. The
 * renderer is told which notes were injected so the announcement line's
 * titles can be made clickable (xterm link provider → full-note expansion).
 *
 * The sync hook reply blocks Claude's prompt processing, so the whole lookup
 * runs under a hard time budget: a warm query is an embed of one short string
 * (~tens of ms) plus a sqlite-vec KNN (<1ms); a cold model load would blow
 * the budget, so it simply misses that prompt and is warm for the next one.
 *
 * In 'every' mode the query blends the current prompt with the session's
 * recent prompts — a terse follow-up ("yes do that") carries no topic on its
 * own, but the conversation it continues does. Current prompt goes first so
 * it dominates the embedding.
 */

import { readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { searchSemantic } from './memory/embeddings'
import { getIndex } from './memory/index'
import { atomicWriteSync } from './atomic-write'

export type MemoryInjectionMode = 'off' | 'first' | 'every'
export type MemoryInjectionThreshold = 'super-strict' | 'strict' | 'balanced' | 'lenient'

/** Distance ceilings per user-facing strictness preset. sqlite-vec returns
 *  L2 distance over normalized embeddings (d = sqrt(2 − 2·cos)), so LOWER
 *  distance = MORE similar, and a stricter preset is a lower ceiling.
 *  Cosine-similarity equivalents: 0.55 ≈ 85%, 0.65 ≈ 79%, 0.75 ≈ 72%,
 *  0.85 ≈ 64%. Injection wants precision over recall — unsolicited context
 *  that's wrong is worse than none — so even 'lenient' only reaches the
 *  todos search threshold, and the default sits tighter. */
const DISTANCE_THRESHOLDS: Record<MemoryInjectionThreshold, number> = {
  'super-strict': 0.55,
  strict: 0.65,
  balanced: 0.75,
  lenient: 0.85,
}

/** Max notes injected per single prompt. */
const MAX_NOTES_PER_PROMPT = 3

/** Excerpt cap per note in the injected context (the matched chunk, not the
 *  full note — Claude can read-memory the rest). */
const EXCERPT_CHARS = 700

/** Hard cap on how long the lookup may block the prompt. */
const SEARCH_BUDGET_MS = 1200

/** Titles are truncated to this length in the transcript announcement so the
 *  `[label]` token stays on one line (wrapped tokens can't be linkified). */
const LABEL_CHARS = 36

/** Query cap before embedding — bge truncates at 512 tokens anyway. */
const QUERY_CHARS = 1500

/** How many previous prompts are blended into the query in 'every' mode. */
const HISTORY_PROMPTS = 2

export interface InjectedMemory {
  filename: string
  title: string
  /** Exact token (without brackets) shown in the transcript announcement. */
  label: string
  type: string
  excerpt: string
  body: string
}

export interface MemoryInjection {
  additionalContext: string
  systemMessage: string
  entries: InjectedMemory[]
}

interface SessionState {
  /** Filenames already injected — never re-injected in the same session. */
  injected: Set<string>
  /** Recent prompt texts, newest last. */
  history: string[]
  /** UserPromptSubmit count seen by this module. */
  promptCount: number
}

const sessions = new Map<string, SessionState>()

// ── Dedupe persistence ───────────────────────────────────────────────────────
// The injected-set survives app restarts: a resumed conversation (same Claude
// session id) already carries every previously injected note in its context,
// so re-injecting after a restart is pure duplication. Prompt history and
// prompt counts stay in-memory — only the dedupe/cap state matters here.

interface PersistedState {
  sessions: Record<string, { injected: string[]; updated: string }>
}

/** Oldest persisted sessions are pruned past this count. */
const MAX_PERSISTED_SESSIONS = 200

let persisted: PersistedState | null = null

function persistPath(): string {
  const dir = join(app.getPath('userData'), 'state')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'memory-injection.json')
}

function loadPersisted(): PersistedState {
  if (persisted) return persisted
  try {
    const parsed = JSON.parse(readFileSync(persistPath(), 'utf-8'))
    persisted = { sessions: parsed?.sessions ?? {} }
  } catch {
    persisted = { sessions: {} }
  }
  return persisted
}

function savePersisted(trackKey: string, state: SessionState): void {
  const store = loadPersisted()
  store.sessions[trackKey] = {
    injected: [...state.injected],
    updated: new Date().toISOString(),
  }
  const keys = Object.keys(store.sessions)
  if (keys.length > MAX_PERSISTED_SESSIONS) {
    keys
      .sort((a, b) => store.sessions[a].updated.localeCompare(store.sessions[b].updated))
      .slice(0, keys.length - MAX_PERSISTED_SESSIONS)
      .forEach((k) => delete store.sessions[k])
  }
  try {
    atomicWriteSync(persistPath(), JSON.stringify(store, null, 2))
  } catch (err) {
    console.warn('[memory-injection] persist failed:', err)
  }
}

/** Wipe all dedupe state — in-memory and the persisted cache. The cleanup
 *  panel deletes the file; this stops the in-memory copy resurrecting it on
 *  the next save. Sessions may re-receive previously injected notes. */
export function resetMemoryInjectionState(): void {
  sessions.clear()
  persisted = { sessions: {} }
}

function stateFor(trackKey: string): SessionState {
  let s = sessions.get(trackKey)
  if (!s) {
    const saved = loadPersisted().sessions[trackKey]
    s = { injected: new Set(saved?.injected ?? []), history: [], promptCount: 0 }
    sessions.set(trackKey, s)
  }
  return s
}

function label(title: string): string {
  return title.length <= LABEL_CHARS ? title : `${title.slice(0, LABEL_CHARS - 1)}…`
}

/**
 * Load the embedding model ahead of the first prompt. Called at startup when
 * injection is enabled; without it the first prompt's lookup would lose the
 * race against the lazy model load and inject nothing.
 */
export function warmMemoryInjection(): void {
  void searchSemantic('warmup', 1).catch(() => {})
}

export async function buildMemoryInjection(
  trackKey: string,
  prompt: string,
  opts: {
    mode: MemoryInjectionMode
    /** Max notes injected across the whole session; null = unlimited. */
    sessionCap: number | null
    /** Strictness preset → cosine-distance ceiling. */
    threshold: MemoryInjectionThreshold
  }
): Promise<MemoryInjection | null> {
  if (opts.mode === 'off') return null
  const current = prompt.trim()
  if (!current) return null

  const state = stateFor(trackKey)
  state.promptCount++

  // History is recorded even on prompts that end up not searching, so a later
  // prompt in 'every' mode still sees the conversation's recent topic.
  const prior = state.history.slice(-HISTORY_PROMPTS)
  state.history.push(current)
  if (state.history.length > HISTORY_PROMPTS) {
    state.history = state.history.slice(-HISTORY_PROMPTS)
  }

  if (opts.mode === 'first' && state.promptCount > 1) return null
  if (opts.sessionCap !== null && state.injected.size >= opts.sessionCap) return null

  // Current prompt first so it dominates the embedding; prior prompts supply
  // topic context for terse follow-ups.
  const query =
    opts.mode === 'every'
      ? [current, ...prior.reverse()].join('\n').slice(0, QUERY_CHARS)
      : current.slice(0, QUERY_CHARS)

  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), SEARCH_BUDGET_MS)
  )
  // Overfetch: the chunk store also holds todo + wiki embeddings, and multiple
  // chunks of one note; both collapse in the filter below.
  const hits = await Promise.race([searchSemantic(query, 24), timeout])
  if (!hits) return null

  const threshold = DISTANCE_THRESHOLDS[opts.threshold] ?? DISTANCE_THRESHOLDS.balanced
  // One-line visibility into why a prompt did or didn't inject — the only
  // way to tune the strictness presets against a real corpus.
  console.log(
    `[memory-injection] top hits (threshold ${threshold}): ` +
      (hits.slice(0, 3).map((h) => `${h.filename}=${h.distance.toFixed(3)}`).join(', ') || 'none')
  )

  const idx = getIndex()
  const remaining =
    opts.sessionCap === null
      ? MAX_NOTES_PER_PROMPT
      : Math.min(MAX_NOTES_PER_PROMPT, opts.sessionCap - state.injected.size)

  const entries: InjectedMemory[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    if (hit.distance > threshold) break // hits are distance-ascending
    const note = idx.get(hit.filename) // memory notes only — drops todo:/wiki: chunks
    if (!note) continue
    if (seen.has(hit.filename) || state.injected.has(hit.filename)) continue
    seen.add(hit.filename)
    entries.push({
      filename: note.filename,
      title: note.title,
      label: label(note.title),
      type: note.type,
      excerpt: hit.text.slice(0, EXCERPT_CHARS),
      body: note.text,
    })
    if (entries.length >= remaining) break
  }
  if (entries.length === 0) return null
  for (const e of entries) state.injected.add(e.filename)
  savePersisted(trackKey, state)

  const blocks = entries.map(
    (e) => `"${e.title}" (${e.filename}, type ${e.type}):\n${e.excerpt}`
  )
  const additionalContext =
    `Relevant memory notes (auto-injected by Session Manager, matched semantically against this prompt — ` +
    `treat as background context and ignore anything irrelevant):\n\n` +
    blocks.join('\n\n') +
    `\n\nFull notes are available via the read-memory MCP tool.`

  const systemMessage = `Relevant memories injected: ${entries.map((e) => `[${e.label}]`).join(' ')}`

  return { additionalContext, systemMessage, entries }
}
