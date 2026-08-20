import { useEffect, useMemo, useState, useCallback } from 'react'
import { useStore } from '../../store'
import type { GithubItem, GithubItemKind, GithubAuthStatus, GithubRangeFilter } from '../../store'

/**
 * GitHub PRs & reviews (Cmd+G)
 *
 * A full-screen overlay (modeled on ScheduledTasksView's shell) showing PR
 * notification threads mirrored from the main-process poller, grouped into
 * Review requests / Mentions / Activity on my PRs. Items arrive via the
 * 'github:changed' broadcast (wired in App.tsx) — this view never polls, it
 * just reads `githubItems` and calls IPC actions.
 *
 * The Claude actions spawn REAL sessions (they land in the graph like any
 * manual spawn): "Start review" and "Address comments" resolve the repo to a
 * local checkout, spawn `claude` there, and seed a prompt. Both prompts are
 * draft-first — Claude prepares its output and asks the user in-session before
 * posting anything to GitHub.
 */

// Per-kind sections hold READ items only — unread ones surface in the
// cross-kind "Unread activity" section at the top.
const KIND_META: Record<GithubItemKind, { title: string; hint: string }> = {
  'review-request': { title: 'Review requests', hint: 'seen — PRs where your review was requested' },
  mention: { title: 'Mentions', hint: 'seen — PRs where you were @mentioned' },
  'my-pr-activity': { title: 'Activity on my PRs', hint: 'seen — comments & reviews on PRs you authored' },
}

const STATE_CHIP: Record<GithubItem['prState'], { label: string; cls: string }> = {
  open: { label: 'open', cls: 'bg-green-500/15 text-green-300' },
  draft: { label: 'draft', cls: 'bg-zinc-500/15 text-zinc-400' },
  merged: { label: 'merged', cls: 'bg-purple-500/15 text-purple-300' },
  closed: { label: 'closed', cls: 'bg-red-500/15 text-red-300' },
}

const RANGE_LABELS: Record<GithubRangeFilter, string> = {
  day: '24h',
  week: 'Week',
  month: 'Month',
  all: 'All time',
}

/** Epoch-ms cutoff for a range filter; null = no cutoff. */
function rangeCutoffMs(range: GithubRangeFilter): number | null {
  const DAY = 24 * 60 * 60 * 1000
  switch (range) {
    case 'day': return Date.now() - DAY
    case 'week': return Date.now() - 7 * DAY
    case 'month': return Date.now() - 30 * DAY
    case 'all': return null
  }
}

function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

interface Props {
  visible: boolean
  onClose: () => void
}

export function GithubPanel({ visible, onClose }: Props): JSX.Element | null {
  const items = useStore((s) => s.githubItems)
  const status = useStore((s) => s.githubStatus)
  const setStatus = useStore((s) => s.setGithubStatus)
  const authLost = useStore((s) => s.githubAuthLost)
  const addSession = useStore((s) => s.addSession)
  const stateFilter = useStore((s) => s.githubStateFilter)
  const setStateFilter = useStore((s) => s.setGithubStateFilter)
  const rangeFilter = useStore((s) => s.githubRangeFilter)
  const setRangeFilter = useStore((s) => s.setGithubRangeFilter)

  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // item id with an in-flight action
  const [actionError, setActionError] = useState<string | null>(null)
  // Connect UI state
  const [tokenInput, setTokenInput] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [deviceCode, setDeviceCode] = useState<{ userCode: string; verificationUri: string } | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)

  // (Re-)probe auth whenever the panel opens or the poller reports auth loss.
  useEffect(() => {
    if (!visible) return
    window.api.githubStatus().then((s) => setStatus(s as GithubAuthStatus))
  }, [visible, authLost, setStatus])

  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [visible, onClose])

  // Apply the state + range filters, keeping a hidden count so the bar can say
  // what the filters are eating. Attention order: drafts awaiting your Submit
  // FIRST (never hidden by filters), then unread (also never hidden), then the
  // per-kind read history.
  const { drafts, unread, grouped, shown, hidden } = useMemo(() => {
    const cutoff = rangeCutoffMs(rangeFilter)
    const visible = items.filter((item) => {
      if (item.unread) return true
      if (item.draft) return true // a response awaiting approval is never hidden
      if (stateFilter === 'active' && (item.prState === 'merged' || item.prState === 'closed')) return false
      if (cutoff !== null && new Date(item.updatedAt).getTime() < cutoff) return false
      return true
    })
    const drafts: GithubItem[] = []
    const unread: GithubItem[] = []
    const map: Record<GithubItemKind, GithubItem[]> = { 'review-request': [], mention: [], 'my-pr-activity': [] }
    for (const item of visible) {
      if (item.draft) drafts.push(item)
      else if (item.unread) unread.push(item)
      else map[item.kind].push(item)
    }
    return { drafts, unread, grouped: map, shown: visible.length, hidden: items.length - visible.length }
  }, [items, stateFilter, rangeFilter])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = (await window.api.githubRefresh()) as { items: GithubItem[]; authLost: boolean }
      const store = useStore.getState()
      store.setGithubItems(res.items)
      store.setGithubAuthLost(res.authLost)
    } finally {
      setRefreshing(false)
    }
  }, [])

  const connectWithToken = useCallback(async () => {
    setConnecting(true)
    setConnectError(null)
    try {
      const s = (await window.api.githubConnectToken(tokenInput)) as GithubAuthStatus
      setStatus(s)
      setTokenInput('')
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err))
    } finally {
      setConnecting(false)
    }
  }, [tokenInput, setStatus])

  const connectWithDeviceFlow = useCallback(async () => {
    setConnecting(true)
    setConnectError(null)
    try {
      const start = (await window.api.githubDeviceStart()) as { userCode: string; verificationUri: string }
      setDeviceCode(start)
      const s = (await window.api.githubDeviceWait()) as GithubAuthStatus
      setStatus(s)
      setDeviceCode(null)
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err))
      setDeviceCode(null)
    } finally {
      setConnecting(false)
    }
  }, [setStatus])

  /** Spawn the review/fix agent via main — the SAME path auto-start uses
   *  (checkout resolution, per-item guard, github-respond prompt). The session
   *  lands in the graph via the 'session:spawned' broadcast; the panel closes
   *  so the user sees it. */
  const startAgent = useCallback(
    async (item: GithubItem) => {
      setBusy(item.id)
      setActionError(null)
      try {
        const result = await window.api.githubStartAgent(item.id)
        if ('skipped' in result) {
          setActionError(`Not started: ${result.skipped}.`)
          return
        }
        onClose()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(null)
      }
    },
    [onClose],
  )

  /** Submit / discard a pending draft (Submit posts via the main process —
   *  the only posting path; errors keep the draft for retry). */
  const submitDraft = useCallback(async (item: GithubItem) => {
    setBusy(item.id)
    setActionError(null)
    try {
      await window.api.githubSubmitDraft(item.id)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [])

  const discardDraft = useCallback(async (item: GithubItem) => {
    await window.api.githubDiscardDraft(item.id)
  }, [])

  /** Jump into a LIVE agent's terminal (focused view). Watching also defers
   *  auto-teardown: if it finishes while you're looking, it stays open. */
  const watchAgent = useCallback(
    (item: GithubItem) => {
      if (!item.agentSessionId) return
      const store = useStore.getState()
      store.setFocusedSessionId(item.agentSessionId)
      store.setViewMode('focused')
      onClose()
    },
    [onClose],
  )

  /** Re-open the (torn-down) agent's conversation as a normal graph session so
   *  the user can talk to it about its draft/response. */
  const discuss = useCallback(
    async (item: GithubItem) => {
      if (!item.agentClaudeSessionId || !item.agentCwd) return
      setBusy(item.id)
      setActionError(null)
      try {
        const result = await window.api.resumeSession(item.agentClaudeSessionId, item.agentCwd)
        addSession(result.id, result.projectPath, item.agentClaudeSessionId)
        // Land the user IN the conversation, not just back on the graph.
        const store = useStore.getState()
        store.setFocusedSessionId(result.id)
        store.setViewMode('focused')
        onClose()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(null)
      }
    },
    [addSession, onClose],
  )

  if (!visible) return null

  const total = items.length

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-zinc-950 text-zinc-200">
      {/* Header */}
      <header className="flex items-center gap-2.5 border-b border-zinc-800 px-4 py-2">
        <GithubGlyph />
        <h1 className="text-[13px] font-semibold tracking-tight text-zinc-100">GitHub</h1>
        {status?.connected && (
          <span className="rounded-full bg-zinc-800/80 px-2 py-0.5 text-[10px] text-zinc-400">
            {status.login} · {status.source === 'gh-cli' ? 'via GitHub CLI' : 'connected'}
          </span>
        )}
        {/* titlebar-no-drag: keep controls clickable through the window drag strip. */}
        <div className="titlebar-no-drag ml-auto flex items-center gap-2">
          {status?.connected && (
            <button
              onClick={() => void refresh()}
              disabled={refreshing}
              className="rounded bg-sky-500/15 px-2.5 py-1 text-[11px] font-medium text-sky-300 hover:bg-sky-500/25 disabled:opacity-50"
            >{refreshing ? 'Refreshing…' : 'Refresh'}</button>
          )}
          {status?.connected && status.source === 'stored' && (
            <button
              onClick={() => window.api.githubDisconnect().then((s) => setStatus(s as GithubAuthStatus))}
              className="rounded px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300"
            >Disconnect</button>
          )}
        </div>
      </header>

      {/* Auth-lost banner: the poller 401'd and no fallback token worked. */}
      {authLost && status?.connected !== true && (
        <div className="border-b border-amber-900/50 bg-amber-950/40 px-4 py-2 text-[12px] text-amber-300">
          GitHub connection lost — the token was revoked or rotated. Reconnect below.
        </div>
      )}

      {/* Scope warning etc. */}
      {status?.connected && status.error && (
        <div className="border-b border-amber-900/50 bg-amber-950/40 px-4 py-2 text-[12px] text-amber-300">{status.error}</div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {!status ? (
          <p className="mt-8 text-center text-[13px] text-zinc-500">Checking GitHub connection…</p>
        ) : !status.connected ? (
          <ConnectCard
            status={status}
            connecting={connecting}
            deviceCode={deviceCode}
            error={connectError}
            tokenInput={tokenInput}
            onTokenInput={setTokenInput}
            onConnectToken={() => void connectWithToken()}
            onConnectDevice={() => void connectWithDeviceFlow()}
          />
        ) : (
          <div className="mx-auto max-w-3xl space-y-6">
            {/* Filter bar */}
            <div className="flex items-center gap-3 text-[11px]">
              <PillGroup
                options={[{ v: 'active', label: 'Active' }, { v: 'all', label: 'All states' }]}
                value={stateFilter}
                onChange={(v) => setStateFilter(v as 'active' | 'all')}
              />
              <PillGroup
                options={(Object.keys(RANGE_LABELS) as GithubRangeFilter[]).map((v) => ({ v, label: RANGE_LABELS[v] }))}
                value={rangeFilter}
                onChange={(v) => setRangeFilter(v as GithubRangeFilter)}
              />
              {hidden > 0 && (
                <button
                  onClick={() => { setStateFilter('all'); setRangeFilter('all') }}
                  className="ml-auto text-zinc-600 hover:text-zinc-400"
                  title="Show everything"
                >{hidden} hidden — show all</button>
              )}
            </div>
            {actionError && (
              <div className="rounded border border-red-900/50 bg-red-950/40 px-3 py-2 text-[12px] text-red-300">{actionError}</div>
            )}
            {total === 0 && (
              <div className="flex flex-col items-center gap-2 pt-16 text-center">
                <span className="text-2xl text-zinc-700">⌁</span>
                <p className="text-[13px] text-zinc-400">No PR activity yet</p>
                <p className="text-[11px] text-zinc-600">Review requests, mentions and comments on your PRs land here (checked every minute).</p>
              </div>
            )}
            {total > 0 && shown === 0 && (
              <p className="pt-16 text-center text-[12px] text-zinc-600">
                All {total} items are outside the current filters.
              </p>
            )}
            {drafts.length > 0 && (
              <section>
                <h2 className="mb-2 flex items-baseline gap-2 text-[12px] font-semibold uppercase tracking-wide text-amber-300">
                  Drafts awaiting your review
                  <span className="text-[10px] font-normal normal-case text-zinc-600">prepared responses — nothing posts until you Submit</span>
                </h2>
                <div className="space-y-2">
                  {drafts.map((item) => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      showKind
                      busy={busy === item.id}
                      onOpen={() => {
                        void window.api.openExternal(item.htmlUrl)
                        void window.api.githubMarkRead(item.id)
                      }}
                      onStart={() => void startAgent(item)}
                      onSubmitDraft={() => void submitDraft(item)}
                      onDiscardDraft={() => void discardDraft(item)}
                      onDiscuss={() => void discuss(item)}
                      onWatch={() => watchAgent(item)}
                      onMarkRead={() => void window.api.githubMarkRead(item.id)}
                    />
                  ))}
                </div>
              </section>
            )}
            {unread.length > 0 && (
              <section>
                <h2 className="mb-2 flex items-baseline gap-2 text-[12px] font-semibold uppercase tracking-wide text-sky-300">
                  Unread activity
                  <span className="text-[10px] font-normal normal-case text-zinc-600">new since you last looked — always shown, whatever the filters</span>
                </h2>
                <div className="space-y-2">
                  {unread.map((item) => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      showKind
                      busy={busy === item.id}
                      onOpen={() => {
                        void window.api.openExternal(item.htmlUrl)
                        void window.api.githubMarkRead(item.id)
                      }}
                      onStart={() => void startAgent(item)}
                      onSubmitDraft={() => void submitDraft(item)}
                      onDiscardDraft={() => void discardDraft(item)}
                      onDiscuss={() => void discuss(item)}
                      onWatch={() => watchAgent(item)}
                      onMarkRead={() => void window.api.githubMarkRead(item.id)}
                    />
                  ))}
                </div>
              </section>
            )}
            {(Object.keys(KIND_META) as GithubItemKind[]).map((kind) =>
              grouped[kind].length === 0 ? null : (
                <section key={kind}>
                  <h2 className="mb-2 flex items-baseline gap-2 text-[12px] font-semibold uppercase tracking-wide text-zinc-400">
                    {KIND_META[kind].title}
                    <span className="text-[10px] font-normal normal-case text-zinc-600">{KIND_META[kind].hint}</span>
                  </h2>
                  <div className="space-y-2">
                    {grouped[kind].map((item) => (
                      <ItemCard
                        key={item.id}
                        item={item}
                        busy={busy === item.id}
                        onOpen={() => {
                          void window.api.openExternal(item.htmlUrl)
                          void window.api.githubMarkRead(item.id)
                        }}
                        onStart={() => void startAgent(item)}
                        onSubmitDraft={() => void submitDraft(item)}
                        onDiscardDraft={() => void discardDraft(item)}
                        onDiscuss={() => void discuss(item)}
                        onWatch={() => watchAgent(item)}
                        onMarkRead={() => void window.api.githubMarkRead(item.id)}
                      />
                    ))}
                  </div>
                </section>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filter pill group
// ---------------------------------------------------------------------------

function PillGroup({
  options, value, onChange,
}: {
  options: { v: string; label: string }[]
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <div className="flex overflow-hidden rounded border border-zinc-800">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-2 py-1 ${
            o.v === value ? 'bg-zinc-800 text-zinc-200' : 'bg-zinc-900/60 text-zinc-500 hover:text-zinc-300'
          }`}
        >{o.label}</button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Item card
// ---------------------------------------------------------------------------

const KIND_CHIP: Record<GithubItemKind, string> = {
  'review-request': 'review request',
  mention: 'mention',
  'my-pr-activity': 'my PR',
}

const VERDICT_LABEL: Record<string, string> = {
  approve: '✓ approve',
  'request-changes': '± request changes',
  comment: '💬 comment',
}

/** One-line summary of what a draft will do when submitted. */
function draftSummary(draft: NonNullable<GithubItem['draft']>): string {
  if (draft.type === 'review') {
    const n = draft.comments?.length ?? 0
    return `${VERDICT_LABEL[draft.verdict ?? 'comment']}${n ? ` · ${n} line comment${n === 1 ? '' : 's'}` : ''}`
  }
  const parts: string[] = []
  if (draft.commitsReady) parts.push('commits to push')
  const r = draft.replies?.length ?? 0
  if (r) parts.push(`${r} repl${r === 1 ? 'y' : 'ies'}`)
  if (!parts.length) parts.push('comment')
  return parts.join(' · ')
}

function ItemCard({
  item, busy, onOpen, onStart, onSubmitDraft, onDiscardDraft, onDiscuss, onWatch, onMarkRead, showKind = false,
}: {
  item: GithubItem
  busy: boolean
  onOpen: () => void
  onStart: () => void
  onSubmitDraft: () => void
  onDiscardDraft: () => void
  onDiscuss: () => void
  onWatch: () => void
  onMarkRead: () => void
  /** Show the kind chip — used in the mixed-kind sections. */
  showKind?: boolean
}): JSX.Element {
  const [draftOpen, setDraftOpen] = useState(false)
  const state = STATE_CHIP[item.prState]
  const actionable = item.prState === 'open' || item.prState === 'draft'
  const canDiscuss = Boolean(item.agentClaudeSessionId && item.agentCwd)
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        {item.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" title="unread" />}
        {showKind && (
          <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{KIND_CHIP[item.kind]}</span>
        )}
        <button onClick={onOpen} className="truncate text-left text-[13px] text-zinc-100 hover:text-sky-300" title={item.title}>
          {item.title}
        </button>
        <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] ${state.cls}`}>{state.label}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
        <span>{item.repo}#{item.prNumber}</span>
        <span>·</span>
        <span>{item.author}</span>
        <span>·</span>
        <span>{fmtAgo(item.updatedAt)}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {item.agentSessionId && (
            <button
              onClick={onWatch}
              className="flex items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300 hover:bg-amber-500/25"
              title="An agent is working on this now — open its terminal. If it finishes while you're watching, it stays open so you can talk to it."
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
              Watch live
            </button>
          )}
          {actionable && !item.draft && !item.agentSessionId && (
            <button
              onClick={onStart}
              disabled={busy}
              className="rounded bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-300 hover:bg-sky-500/25 disabled:opacity-50"
              title="Spawn a Claude agent for this item — its response lands here as a draft for you to approve (or is auto-submitted if you've enabled auto mode)"
            >{busy ? 'Spawning…' : item.kind === 'my-pr-activity' ? 'Address comments' : 'Start review'}</button>
          )}
          {item.unread && (
            <button onClick={onMarkRead} className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300">
              Mark read
            </button>
          )}
        </div>
      </div>

      {/* Pending draft: the agent's prepared response awaiting approval. */}
      {item.draft && (
        <div className="mt-2 rounded border border-amber-800/40 bg-amber-950/20 px-2.5 py-2">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="font-medium text-amber-300">Draft ready</span>
            <span className="text-zinc-500">{draftSummary(item.draft)}</span>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                onClick={() => setDraftOpen((v) => !v)}
                className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300"
              >{draftOpen ? 'Hide' : 'View'}</button>
              {canDiscuss && (
                <button
                  onClick={onDiscuss}
                  disabled={busy}
                  className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
                  title="Re-open the agent's conversation to discuss or revise this draft"
                >Discuss</button>
              )}
              <button
                onClick={onSubmitDraft}
                disabled={busy}
                className="rounded bg-green-500/15 px-2 py-0.5 text-[10px] font-medium text-green-300 hover:bg-green-500/25 disabled:opacity-50"
                title={item.draft.commitsReady ? 'Push the prepared commits and post the replies' : 'Post this to GitHub'}
              >{busy ? 'Submitting…' : 'Submit'}</button>
              <button
                onClick={onDiscardDraft}
                disabled={busy}
                className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-red-300"
              >Discard</button>
            </div>
          </div>
          {draftOpen && (
            <div className="mt-2 space-y-2 border-t border-amber-900/30 pt-2">
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-zinc-300">{item.draft.body}</pre>
              {(item.draft.comments ?? []).map((c, i) => (
                <div key={i} className="rounded bg-zinc-900/80 px-2 py-1.5 text-[11px]">
                  <span className="font-mono text-[10px] text-zinc-500">{c.path}:{c.line}</span>
                  <p className="mt-0.5 whitespace-pre-wrap text-zinc-300">{c.body}</p>
                </div>
              ))}
              {(item.draft.replies ?? []).map((r, i) => (
                <div key={i} className="rounded bg-zinc-900/80 px-2 py-1.5 text-[11px]">
                  <span className="font-mono text-[10px] text-zinc-500">reply to #{r.commentId}</span>
                  <p className="mt-0.5 whitespace-pre-wrap text-zinc-300">{r.body}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Close-out record: a submitted response (green) or an agent's explicit
          "no response needed" decision (muted — nothing was posted). */}
      {!item.draft && item.respondedAt && (
        <p
          className={`mt-1.5 flex items-center gap-2 text-[10px] ${
            item.respondedKind === 'dismissed' ? 'text-zinc-500' : 'text-green-400/70'
          }`}
        >
          <span>
            {item.respondedKind === 'dismissed' ? '⊘ no action needed' : '✓'} {item.respondedSummary} ·{' '}
            {fmtAgo(item.respondedAt)}
          </span>
          {canDiscuss && (
            <button
              onClick={onDiscuss}
              disabled={busy}
              className="rounded px-1.5 py-0.5 text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
              title="Re-open the agent's conversation about this response"
            >Discuss</button>
          )}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Connect card (not-connected state)
// ---------------------------------------------------------------------------

function ConnectCard({
  status, connecting, deviceCode, error, tokenInput, onTokenInput, onConnectToken, onConnectDevice,
}: {
  status: GithubAuthStatus
  connecting: boolean
  deviceCode: { userCode: string; verificationUri: string } | null
  error: string | null
  tokenInput: string
  onTokenInput: (v: string) => void
  onConnectToken: () => void
  onConnectDevice: () => void
}): JSX.Element {
  return (
    <div className="mx-auto mt-12 max-w-md space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
      <h2 className="text-[14px] font-semibold text-zinc-100">Connect to GitHub</h2>
      <p className="text-[12px] leading-relaxed text-zinc-400">
        The panel auto-detects a logged-in GitHub CLI (<code className="text-zinc-300">gh auth login</code>) — if you use gh,
        log in there and this connects itself. Otherwise connect below.
      </p>
      {status.error && <p className="text-[12px] text-amber-300">{status.error}</p>}

      {deviceCode ? (
        <div className="rounded border border-sky-900/60 bg-sky-950/30 p-3 text-center">
          <p className="text-[12px] text-zinc-400">Enter this code at <span className="text-sky-300">{deviceCode.verificationUri}</span></p>
          <p className="mt-2 select-all font-mono text-xl tracking-[0.3em] text-zinc-100">{deviceCode.userCode}</p>
          <p className="mt-2 text-[11px] text-zinc-500">Waiting for approval…</p>
        </div>
      ) : (
        <>
          {status.deviceFlowAvailable && (
            <button
              onClick={onConnectDevice}
              disabled={connecting}
              className="w-full rounded bg-sky-500/15 px-3 py-2 text-[12px] font-medium text-sky-300 hover:bg-sky-500/25 disabled:opacity-50"
            >Connect with GitHub (device flow)</button>
          )}
          <div className="space-y-2">
            <label className="block text-[11px] text-zinc-500">Or paste a personal access token (needs <code>repo</code> scope):</label>
            <div className="flex gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => onTokenInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && tokenInput.trim()) onConnectToken() }}
                placeholder="ghp_… / github_pat_…"
                className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:border-sky-600 focus:outline-none"
              />
              <button
                onClick={onConnectToken}
                disabled={connecting || tokenInput.trim().length === 0}
                className="rounded bg-sky-500/15 px-3 py-1.5 text-[12px] font-medium text-sky-300 hover:bg-sky-500/25 disabled:opacity-50"
              >{connecting ? 'Checking…' : 'Connect'}</button>
            </div>
          </div>
        </>
      )}
      {error && <p className="text-[12px] text-red-400">{error}</p>}
    </div>
  )
}

function GithubGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 fill-zinc-400" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}
