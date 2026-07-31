/**
 * The reasoning layer — occasional, LLM-backed, deliberately cheap.
 *
 * Deterministic mining (mining.ts) produces candidate patterns; nothing there
 * can tell whether "runs `npm run build` most mornings" is worth automating or
 * is just how software works. That judgement is the one place an LLM earns its
 * cost, so it runs at most ~once a day of app-open time, on Haiku, over a
 * handful of PRE-QUALIFIED candidates rather than the raw event stream.
 *
 * The run is a headless Claude session: same spawn machinery as a scheduled
 * task (`claude --permission-mode auto`, tool-restricted, no graph presence),
 * tagged `kind: 'observer'` in the session registry so it shows up in the ⌘P
 * overview and nowhere else. It writes results back through the
 * `observer-suggest` MCP tool → `/observer/suggest` → the suggestions table.
 *
 * The curator also does housekeeping in the same run (cheaper than a second
 * session): proposing wikilinks between related memory notes, and flagging open
 * todos that look already done. Both are PROPOSALS — it never writes to memory
 * or todos itself, which is why its tool list is read-only plus the one
 * suggest tool.
 */

import { randomUUID } from 'crypto'
import { spawnSession, type PtySession } from '../pty-manager'
import { armCuratorToken, clearCuratorToken, mintCuratorToken } from './curator-token'
import { CURATOR_MCP_TOOLS } from './role-gate'
import { MODEL_IDS } from '../model-tiers'
import * as registry from '../session-registry'
import {
  findPromotablePatterns,
  listSuggestions,
  patternHasResolvedSuggestion,
  setPatternStatus,
  type PatternRow,
} from './db'

/** Promotion rule: the same pattern on ≥4 distinct days inside 14 days. Days,
 *  not raw count, so one frantic afternoon can't manufacture a habit. */
const PROMOTE_MIN_DISTINCT_DAYS = 4
const PROMOTE_WINDOW_DAYS = 14

/** Candidates handed to one curator run. Small on purpose: a focused prompt
 *  produces better proposals than a 50-item dump, and it bounds the cost. */
const MAX_CANDIDATES_PER_RUN = 8

/** Don't pile up proposals the user hasn't looked at yet. */
const MAX_PENDING_SUGGESTIONS = 12

/**
 * `--allowedTools` argv for the run: the curator's MCP allowlist plus the
 * read-only built-ins.
 *
 * This is a HINT, not the boundary — `--allowedTools` pre-approves a list, it
 * does not deny what is missing, and the run uses `--permission-mode auto`.
 * Passing it still spares the run a round of permission prompts, but the
 * enforcement is registration-time gating in the MCP server (role-gate.ts).
 */
const CURATOR_TOOLS = [
  ...CURATOR_MCP_TOOLS.map((t) => `mcp__session-manager__${t}`),
  'Read', 'Grep', 'Glob',
]

/** Injected by the app so the curator's PTY gets the same listener wiring as
 *  every other session (renderer terminal + hook status). */
let attachListenersFn: ((id: string, session: PtySession) => void) | null = null
export function setCuratorAttachListeners(fn: (id: string, session: PtySession) => void): void {
  attachListenersFn = fn
}

/** The live curator session, if one is running. At most one at a time. */
let activeSessionId: string | null = null
export function activeCuratorSessionId(): string | null {
  return activeSessionId
}

/**
 * End the live run: clear the in-flight marker and burn the token.
 *
 * Called from BOTH the PTY exit handler and the Stop-hook teardown path. The
 * Stop hook fires first (the interactive session sits at its prompt forever
 * after finishing, so waiting for exit would leak a Haiku process per launch
 * AND wedge `activeSessionId` so every later run is skipped as in-flight).
 * Idempotent, and a no-op for a session that is not the live curator.
 */
export function endCuratorRun(sessionId: string): void {
  if (activeSessionId !== sessionId) return
  activeSessionId = null
  clearCuratorToken()
}

/** True when this session is the curator run currently in flight. */
export function isCuratorSession(sessionId: string): boolean {
  return activeSessionId !== null && activeSessionId === sessionId
}

function describeCandidate(p: PatternRow, index: number): string {
  const recentDays = p.days.slice(-8).join(', ')
  const scope = p.project ? `project \`${p.project}\`` : 'no specific project'
  return [
    `${index + 1}. patternId: ${p.id}`,
    `   what: ${p.label}`,
    `   kind: ${p.type} · scope: ${scope}`,
    `   seen ${p.support} times across ${p.distinctDays} distinct days (recent: ${recentDays})`,
  ].join('\n')
}

function buildCuratorPrompt(candidates: PatternRow[]): string {
  return `You are the CURATOR for the Session Manager app — a background agent that watches how the user works and proposes automations. You run unattended, roughly once a day. Be conservative and concrete: a bad suggestion costs the user more attention than a missing one.

## Part 1 — judge these usage patterns

These were mined deterministically from the user's own activity (tool use, shell commands, UI actions). Each has recurred on several distinct days.

${candidates.map(describeCandidate).join('\n\n')}

For EACH pattern, decide whether automating it would genuinely help. Reject a pattern when:
- it is inherent to using the tools at all (reading files, running the test suite once per change) — recurrence is not the same as automatable toil;
- automating it would need judgement the automation cannot have;
- it is already covered by an existing scheduled task (check with list-scheduled-tasks);
- you cannot describe a concrete, useful automation in one sentence.

**Rejecting is the expected outcome for most patterns. Do not force a suggestion.**

For each pattern you DO want to act on, call:
  observer-suggest({ patternId, title, rationale, kind, proposal })

where \`kind\` and \`proposal\` are one of:
- kind:"scheduled-task" → proposal: { name, prompt, projectPath, recurrence: {kind:"none"|"interval"|"daily", minutes?, hour?, minute?}, launch:"off"|"every"|"firstOfDay", model?:"haiku"|"sonnet"|"opus" }
  Use this when the work is a repeatable prompt that can run unattended.
- kind:"skill" → proposal: { name, description, body }
  Use this when the pattern is a repeated *way of working* better captured as a reusable slash-command skill than as a timed job.
  FIRST check the app's own feature docs with search-wiki (and read-wiki-article for anything that looks close). Session Manager already has a graph view, canvas, scheduled tasks, an agentic pipeline, memory, todos, messaging and more — a "skill" that reimplements a built-in feature is a bad suggestion, however often the pattern recurs.
- kind:"todo" → proposal: { title, body, tags:["project:<name>"] }
  Use this when the right move is to remind the user to do something themselves.
  Call list-tags first and reuse an EXISTING \`project:\` tag verbatim — the tags are case-sensitive, and an invented casing silently creates a second project.

\`title\` is one line the user reads in their inbox. \`rationale\` is 1–3 sentences saying what you observed and why automating it helps — cite the actual counts.

## Part 2 — curation housekeeping

Then do BOTH of these:

a) **Memory wikilinks.** Use list-memories and read-memory on the ~10 most recently modified notes. Where two notes are clearly about the same subject but do not link to each other, propose the link:
   observer-suggest({ title, rationale, kind:"memory-link", proposal: { from:"<filename.md>", to:"<filename.md>", section:"Related" } })
   Only propose a link you would defend — a shared word is not a shared subject.

b) **Stale todos.** Use list-todos({ done:false }) and read-todo. Where an open todo looks like it has ALREADY BEEN DONE (its described change is present in the codebase, or a later todo supersedes it), propose closing it:
   observer-suggest({ title, rationale, kind:"todo-cleanup", proposal: { todoId, action:"close" } })
   Evidence, not vibes: say what you checked. If you cannot verify, skip it.

## Rules
- You PROPOSE ONLY. You must not create scheduled tasks, edit memory notes, or close todos yourself — the user accepts or dismisses each suggestion from their inbox.
- Emit at most ${MAX_CANDIDATES_PER_RUN} suggestions in total across both parts.
- If nothing is worth suggesting, that is a good outcome: emit nothing and finish.
- Work quietly and finish. Do not ask questions — nobody is watching this session.

Begin.`
}

export interface CuratorRunResult {
  status: 'spawned' | 'skipped'
  reason?: string
  sessionId?: string
  candidates?: number
}

/**
 * One curator run. Selects promotable candidates, marks them so they are not
 * re-judged on the next pass, and spawns the headless session.
 *
 * Skips (cheaply, without spawning) when there is nothing to judge or when the
 * user already has a backlog of unread suggestions — the point is a trickle of
 * good proposals, not a queue.
 */
export function runCurator(opts: { projectPath: string }): CuratorRunResult {
  if (activeSessionId) return { status: 'skipped', reason: 'a curator run is already in flight' }

  const pending = listSuggestions({ status: 'pending', limit: MAX_PENDING_SUGGESTIONS + 1 }).length
  if (pending >= MAX_PENDING_SUGGESTIONS) {
    return { status: 'skipped', reason: `${pending} suggestions already pending review` }
  }

  const candidates = findPromotablePatterns({
    minDistinctDays: PROMOTE_MIN_DISTINCT_DAYS,
    windowDays: PROMOTE_WINDOW_DAYS,
    limit: MAX_CANDIDATES_PER_RUN,
  }).filter((p) => !patternHasResolvedSuggestion(p.id))

  // Housekeeping (memory links, stale todos) is worth a run on its own, but
  // only occasionally — without candidates we'd otherwise spawn a session
  // every single day to re-check the same notes. Require at least one pattern.
  if (candidates.length === 0) {
    return { status: 'skipped', reason: 'no patterns have crossed the promotion threshold' }
  }

  // Mark BEFORE spawning: if the run dies, these candidates are still off the
  // queue rather than being re-judged forever. They are revived only if the
  // user dismisses the resulting suggestion (which re-mutes them anyway).
  for (const p of candidates) setPatternStatus(p.id, 'promoted')

  const id = randomUUID()
  const token = mintCuratorToken()
  const args = [
    '--model', MODEL_IDS.haiku,
    '--permission-mode', 'auto',
    '--allowedTools', ...CURATOR_TOOLS,
    '--', buildCuratorPrompt(candidates),
  ]

  let session: PtySession
  try {
    // The stdio MCP server inherits this env (the same way it picks up
    // APP_SESSION_ID), which is what lets it gate its own registration and
    // forward the run token. Set BEFORE the token is armed, so a spawn failure
    // cannot leave a live token with no session behind it.
    session = spawnSession(id, opts.projectPath, 'claude', args, {
      SM_OBSERVER_ROLE: 'curator',
      SM_CURATOR_TOKEN: token,
    })
  } catch (err) {
    // Un-promote so the next run can retry these candidates.
    for (const p of candidates) setPatternStatus(p.id, 'candidate')
    console.error('[observer] curator spawn failed:', err)
    return { status: 'skipped', reason: `spawn failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  activeSessionId = id
  armCuratorToken(token)
  attachListenersFn?.(id, session)
  registry.setOrigin(id, {
    kind: 'observer',
    observerJob: 'curator',
    label: `Curator · judging ${candidates.length} pattern${candidates.length === 1 ? '' : 's'}`,
  })

  // Backstop only — the Stop-hook teardown (hook-server) normally gets here
  // first and kills the PTY. This still runs if the process dies on its own.
  session.process.onExit(() => {
    endCuratorRun(id)
    registry.forget(id)
  })

  console.log(`[observer] curator session ${id} judging ${candidates.length} candidates`)
  return { status: 'spawned', sessionId: id, candidates: candidates.length }
}

/** Mark a pattern as having produced a suggestion (called on ingest). */
export function markPatternSuggested(patternId: string): void {
  setPatternStatus(patternId, 'suggested')
}
