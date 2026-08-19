import { useCallback, useEffect, useState } from 'react'
import { useStore, type Suggestion, type SuggestionKind } from '../../store'

/**
 * Insights inbox — the observer's proposals, at the bottom of the ⌘P overview.
 *
 * The observer never acts on its own: it digests each finished session (one
 * Haiku paragraph of intent + friction), a reflective Sonnet curator reads the
 * digests + its own journal roughly daily, and files each proposal here.
 * Accepting executes the proposal through the app's existing machinery
 * (schedule-store, notes-manager, memory backlinks, skill install); "never"
 * feeds a do-not-re-propose list into every future curator prompt.
 *
 * The Journal tab shows the curator's own cross-run working notes, read-only —
 * it is curator-private state, excluded from memory search and the graph.
 *
 * Deliberately not a notification: it sits inside a panel the user opens, so a
 * background agent can be curious without being interrupting.
 */

const KIND_LABEL: Record<SuggestionKind, { text: string; className: string; verb: string }> = {
  'scheduled-task': { text: 'scheduled task', className: 'bg-amber-500/15 text-amber-300',   verb: 'Create it' },
  'skill':          { text: 'skill',          className: 'bg-sky-500/15 text-sky-300',       verb: 'Install it' },
  'todo':           { text: 'todo',           className: 'bg-emerald-500/15 text-emerald-300', verb: 'Add it' },
  'memory-link':    { text: 'memory link',    className: 'bg-violet-500/15 text-violet-300', verb: 'Link them' },
  'todo-cleanup':   { text: 'stale todo',     className: 'bg-zinc-500/15 text-zinc-300',     verb: 'Close it' },
  'memory-note':    { text: 'memory note',    className: 'bg-violet-500/15 text-violet-300', verb: 'Create note' },
  'claude-md':      { text: 'CLAUDE.md',      className: 'bg-rose-500/15 text-rose-300',     verb: 'Append it' },
  'use-feature':    { text: 'try a feature',  className: 'bg-teal-500/15 text-teal-300',     verb: 'Got it' },
  'pipeline-candidate': { text: 'pipeline candidate', className: 'bg-fuchsia-500/15 text-fuchsia-300', verb: 'Add to backlog' },
}

/** One-line preview of what accepting will actually do — the user should never
 *  have to accept a proposal to find out what it contains. */
function describeProposal(s: Suggestion): string | null {
  const p = s.proposal
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  switch (s.kind) {
    case 'scheduled-task': {
      const rec = (p.recurrence ?? {}) as Record<string, unknown>
      const when =
        rec.kind === 'interval' ? `every ${Number(rec.minutes) || 60} min`
          : rec.kind === 'daily' ? `daily at ${String(rec.hour ?? 9).padStart(2, '0')}:${String(rec.minute ?? 0).padStart(2, '0')}`
            : 'manual only'
      return `${str(p.name) ?? s.title} · ${when} · ${str(p.projectPath) ?? 'default project'}`
    }
    case 'skill':
      return `/${str(p.name) ?? 'skill'} — ${str(p.description) ?? ''}`
    case 'todo':
      return str(p.title) ?? s.title
    case 'memory-link':
      return `${str(p.from) ?? '?'} ↔ ${str(p.to) ?? '?'}`
    case 'todo-cleanup':
      return `Close todo ${str(p.todoId) ?? '?'}`
    case 'memory-note':
      return `${str(p.title) ?? s.title} (${str(p.type) ?? 'context'} note)`
    case 'claude-md':
      return str(p.text)
    case 'use-feature':
      return `Wiki: ${str(p.feature) ?? '?'} — ${str(p.why) ?? ''}`
    case 'pipeline-candidate':
      return str(p.title) ?? s.title
    default:
      return null
  }
}

/** The full proposal, for the "show details" disclosure. */
function proposalJson(s: Suggestion): string {
  try { return JSON.stringify(s.proposal, null, 2) } catch { return '{}' }
}

/**
 * The body of a proposed skill.
 *
 * Accepting a `skill` suggestion writes a slash command into
 * `~/.claude/commands/` that persists across restarts, and its body is
 * instructions an LLM wrote and every future session will follow. That is the
 * one proposal kind where the thing being installed IS prose the user must
 * read, so it is shown in full up front rather than behind "Show details" —
 * a one-line `/name — description` preview is not informed consent.
 */
function skillBody(s: Suggestion): string | null {
  if (s.kind !== 'skill') return null
  const body = s.proposal.body
  return typeof body === 'string' && body.trim() ? body.trim() : null
}

/** Same reasoning for claude-md: accepting appends prose to ~/.claude/CLAUDE.md
 *  that EVERY future session follows — show it in full, not behind a preview. */
function claudeMdText(s: Suggestion): string | null {
  if (s.kind !== 'claude-md') return null
  const text = s.proposal.text
  return typeof text === 'string' && text.trim() ? text.trim() : null
}

export function InsightsInbox(): JSX.Element {
  const inbox = useStore((s) => s.observerInbox)
  const refresh = useStore((s) => s.refreshObserverInbox)
  const accept = useStore((s) => s.acceptSuggestion)
  const dismiss = useStore((s) => s.dismissSuggestion)
  const runJob = useStore((s) => s.runObserverJob)

  const [busyId, setBusyId] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ id: string; message: string; ok: boolean } | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showResolved, setShowResolved] = useState(false)
  const [tab, setTab] = useState<'suggestions' | 'journal'>('suggestions')
  const [journal, setJournal] = useState<{ exists: boolean; content: string; updatedAt: number | null } | null>(null)

  useEffect(() => { void refresh() }, [refresh])

  // The curator's observations journal — read-only view, fetched on tab open.
  useEffect(() => {
    if (tab !== 'journal') return
    window.api.observerJournal()
      .then((j) => setJournal(j as { exists: boolean; content: string; updatedAt: number | null }))
      .catch(() => setJournal(null))
  }, [tab])

  const act = useCallback(async (
    id: string,
    fn: () => Promise<{ ok: boolean; message: string }>,
  ) => {
    setBusyId(id)
    try {
      const result = await fn()
      setFlash({ id, message: result.message, ok: result.ok })
    } finally {
      setBusyId(null)
    }
  }, [])

  const pending = inbox?.suggestions.filter((s) => s.status === 'pending') ?? []
  const resolved = inbox?.suggestions.filter((s) => s.status !== 'pending') ?? []

  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-[12px] font-semibold text-zinc-300">Insights</h2>
        {pending.length > 0 && (
          <span className="rounded bg-fuchsia-500/20 px-1.5 py-px text-[10px] font-medium text-fuchsia-300 tabular-nums">
            {pending.length}
          </span>
        )}
        <div className="flex items-center gap-0.5 rounded bg-zinc-900 p-0.5">
          {(['suggestions', 'journal'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded px-2 py-0.5 text-[10px] capitalize ${
                tab === t ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-600 hover:text-zinc-400'
              }`}
            >{t === 'journal' ? 'Journal' : 'Suggestions'}</button>
          ))}
        </div>
        <span className="truncate text-[10px] text-zinc-600">
          {tab === 'journal'
            ? "The curator's own working notes across runs — hypotheses, evidence, rejected ideas"
            : 'What the curator thinks is worth your time — nothing happens until you accept'}
        </span>
        <button
          onClick={() => { void runJob('curator').then(() => setTimeout(() => void refresh(), 2000)) }}
          className="ml-auto shrink-0 rounded px-2 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"
          title="Run the curator now instead of waiting for its next scheduled pass"
        >Run curator now</button>
      </div>

      {tab === 'journal' ? (
        <div>
          {journal?.exists && journal.content.trim() ? (
            <>
              {journal.updatedAt && (
                <p className="mb-1.5 text-[10px] text-zinc-600">
                  Last updated {new Date(journal.updatedAt).toLocaleString()} · private to the curator, excluded from memory search
                </p>
              )}
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-800 bg-zinc-900/40 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                {journal.content}
              </pre>
            </>
          ) : (
            <p className="rounded border border-dashed border-zinc-800 px-3 py-2.5 text-[11px] text-zinc-600">
              No journal yet. The curator writes its observations here on each run — what it is
              tracking, why it rejected ideas, what it wants to confirm next time.
            </p>
          )}
        </div>
      ) : pending.length === 0 ? (
        <p className="rounded border border-dashed border-zinc-800 px-3 py-2.5 text-[11px] text-zinc-600">
          Nothing to review. The curator proposes something only when it observes a recurring
          goal, friction, or missing knowledge across your recent sessions.
        </p>
      ) : (
        <div className="space-y-2">
          {pending.map((s) => {
            const kind = KIND_LABEL[s.kind] ?? { text: s.kind, className: 'bg-zinc-500/15 text-zinc-300', verb: 'Accept' }
            const preview = describeProposal(s)
            const body = skillBody(s)
            const mdText = claudeMdText(s)
            const isBusy = busyId === s.id
            const msg = flash?.id === s.id ? flash : null
            return (
              <div key={s.id} className="rounded border border-zinc-800/80 bg-zinc-900/40 p-3">
                <div className="flex items-start gap-2">
                  <span className={`mt-px shrink-0 rounded px-1.5 py-px text-[10px] font-medium ${kind.className}`}>
                    {kind.text}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-medium text-zinc-100">{s.title}</p>
                    {s.rationale && <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">{s.rationale}</p>}
                    {preview && (
                      <p className="mt-1 truncate font-mono text-[10px] text-zinc-500" title={preview}>{preview}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-[10px] text-zinc-600">
                    {new Date(s.createdAt).toLocaleDateString()}
                  </span>
                </div>

                {body && (
                  <div className="mt-2">
                    <p className="mb-1 text-[10px] text-zinc-500">
                      Accepting installs this as <span className="font-mono text-zinc-400">/sm-…</span> in{' '}
                      <span className="font-mono">~/.claude/commands</span> and keeps it across restarts.
                      Every session that runs it will follow these instructions — read them first:
                    </p>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-800 bg-black/40 p-2 font-mono text-[10px] leading-relaxed text-zinc-300">
                      {body}
                    </pre>
                  </div>
                )}

                {mdText && (
                  <div className="mt-2">
                    <p className="mb-1 text-[10px] text-zinc-500">
                      Accepting appends this to <span className="font-mono text-zinc-400">~/.claude/CLAUDE.md</span> —
                      every future session in every project will follow it. Read it first:
                    </p>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-800 bg-black/40 p-2 font-mono text-[10px] leading-relaxed text-zinc-300">
                      {mdText}
                    </pre>
                  </div>
                )}

                {expandedId === s.id && (
                  <pre className="mt-2 max-h-56 overflow-auto rounded bg-black/40 p-2 font-mono text-[10px] leading-relaxed text-zinc-400">
                    {proposalJson(s)}
                  </pre>
                )}

                {msg && (
                  <p className={`mt-2 text-[11px] ${msg.ok ? 'text-green-400' : 'text-red-400'}`}>{msg.message}</p>
                )}

                <div className="mt-2 flex items-center gap-1.5">
                  <button
                    disabled={isBusy}
                    onClick={() => void act(s.id, () => accept(s.id))}
                    className="rounded bg-sky-500/15 px-2.5 py-1 text-[11px] font-medium text-sky-300 hover:bg-sky-500/25 disabled:opacity-40"
                  >{isBusy ? 'Working…' : kind.verb}</button>
                  <button
                    disabled={isBusy}
                    onClick={() => void act(s.id, () => dismiss(s.id, false))}
                    className="rounded px-2.5 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 disabled:opacity-40"
                  >Dismiss</button>
                  <button
                    disabled={isBusy}
                    onClick={() => void act(s.id, () => dismiss(s.id, true))}
                    className="rounded px-2.5 py-1 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-40"
                    title="Mute this pattern permanently"
                  >Never suggest this</button>
                  <button
                    onClick={() => setExpandedId(expandedId === s.id ? null : s.id)}
                    className="ml-auto rounded px-2 py-1 text-[10px] text-zinc-600 hover:text-zinc-400"
                  >{expandedId === s.id ? 'Hide' : 'Show'} details</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'suggestions' && resolved.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowResolved((v) => !v)}
            className="text-[10px] text-zinc-600 hover:text-zinc-400"
          >
            {showResolved ? 'Hide' : 'Show'} {resolved.length} resolved suggestion{resolved.length === 1 ? '' : 's'}
          </button>
          {showResolved && (
            <div className="mt-1.5 space-y-1">
              {resolved.map((s) => (
                <div key={s.id} className="flex items-center gap-2 rounded px-2 py-1 text-[11px]">
                  <span className={`shrink-0 text-[10px] ${
                    s.status === 'accepted' ? 'text-green-400' : s.status === 'never' ? 'text-zinc-600' : 'text-zinc-500'
                  }`}>
                    {s.status === 'accepted' ? '✓' : s.status === 'never' ? '⊘' : '×'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-zinc-500">{s.title}</span>
                  {s.result && <span className="shrink-0 truncate text-[10px] text-zinc-600">{s.result}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
