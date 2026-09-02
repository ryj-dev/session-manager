import { BrowserWindow, Notification } from 'electron'
import * as githubStore from './github-store'
import type { GithubItem, GithubItemKind } from './github-store'
import { getActiveToken, getViewerLogin, invalidateAuth, apiHeaders, GITHUB_API } from './github-auth'
import { decideAutoStart, type GateDecision } from './github-gate'

// Polls the GitHub Notifications API and mirrors PR-relevant threads into
// github-store. Honours GitHub's conditional-request contract: If-Modified-Since
// on every poll, X-Poll-Interval as the server-directed cadence floor (a 304
// costs no rate limit). A 401 invalidates the cached token (gh CLI tokens can
// rotate underneath us) and flags auth-lost so the panel shows a reconnect
// prompt instead of going silently stale.

const DEFAULT_POLL_SECONDS = 60
// The notification `reason`s we surface, mapped to panel sections.
const REASON_TO_KIND: Record<string, GithubItemKind> = {
  review_requested: 'review-request',
  mention: 'mention',
  team_mention: 'mention',
  author: 'my-pr-activity',
}

// Every Nth tick drops If-Modified-Since and re-reads the full list. Read
// state changed OUTSIDE the app (viewing a thread on github.com) may not
// advance the list's Last-Modified, so pure conditional polling could 304
// forever and never mirror it — GitHub is the source of truth for read-state,
// so we must periodically ask it outright.
const FULL_SYNC_EVERY_N_TICKS = 10

// Auto-start wiring, INJECTED by index.ts (the spawner lives in hook-server;
// importing it here would close a hook-server → github-actions → github-poller
// cycle — same reason scheduler never imports hook-server's callers).
type GithubAutoSpawner = (itemId: string, opts: { skipSelfEcho?: boolean }) => Promise<unknown>
type GithubAutoModeFor = (kind: GithubItemKind) => 'off' | 'draft' | 'auto'
let autoSpawner: GithubAutoSpawner | null = null
let autoModeFor: GithubAutoModeFor | null = null

export function configureGithubAutoStart(spawner: GithubAutoSpawner, modeFor: GithubAutoModeFor): void {
  autoSpawner = spawner
  autoModeFor = modeFor
}

/** Everything since `since` on the PR that a human could have addressed to us:
 *  issue comments, review comments and review bodies. GitHub's
 *  `subject.latest_comment_url` is null on most active threads (verified
 *  2026-09-02 across the live feed), so the mention gate cannot rely on it —
 *  it reads the PR's own activity instead. Null = could not be determined;
 *  callers fail open. */
function activitySinceFor(token: string, item: GithubItem, selfLogin: string) {
  return async (since: string): Promise<string[] | null> => {
    const base = `${GITHUB_API}/repos/${item.repo}`
    type Activity = { body?: string; user?: { login?: string }; submitted_at?: string }
    const get = async (url: string): Promise<Activity[] | null> => {
      try {
        const res = await fetch(url, { headers: apiHeaders(token) })
        if (!res.ok) return null
        return (await res.json()) as Activity[]
      } catch {
        return null
      }
    }
    const [issueComments, reviewComments, reviews] = await Promise.all([
      get(`${base}/issues/${item.prNumber}/comments?per_page=100&since=${encodeURIComponent(since)}`),
      get(`${base}/pulls/${item.prNumber}/comments?per_page=100&since=${encodeURIComponent(since)}`),
      get(`${base}/pulls/${item.prNumber}/reviews?per_page=100`),
    ])
    if (issueComments === null || reviewComments === null || reviews === null) return null
    // A full page of reviews means older ones fell off the front of the list —
    // we cannot prove nothing was missed, so refuse to answer rather than
    // answer wrong (the gate reads null as "fail open").
    if (reviews.length >= 100) return null
    const recent = [...issueComments, ...reviewComments, ...reviews.filter((r) => (r.submitted_at ?? '') > since)]
    // Our own posts are not someone asking us for something.
    return recent.filter((c) => c.user?.login !== selfLogin).map((c) => c.body ?? '')
  }
}

/** Fire the review/fix agent for fresh unread items whose kind has auto-start
 *  enabled. The spawner itself enforces the per-item session guard, self-echo
 *  suppression, and checkout resolution. Every item logs its gate inputs and
 *  the decision — a gate that silently fails open is otherwise undiagnosable
 *  after the fact (the store only ever holds the latest values). */
async function autoStartFresh(token: string, fresh: GithubItem[], login: string | null): Promise<void> {
  if (!autoSpawner || !autoModeFor) return
  for (const item of fresh) {
    const at = `${item.repo}#${item.prNumber}`
    if (!item.unread) continue
    if ((item.prState !== 'open' && item.prState !== 'draft') || item.draft) continue
    if (autoModeFor(item.kind) === 'off') continue

    const stored = githubStore.getItem(item.id)
    const inputs =
      `kind=${item.kind} reason=${item.notificationReason ?? '?'} ` +
      `reviewRequested=${item.reviewRequested ?? '?'} head=${item.headSha?.slice(0, 8) ?? '?'} ` +
      `respondedAt=${stored?.respondedAt ?? '-'} respondedHead=${stored?.respondedHeadSha?.slice(0, 8) ?? '-'}`
    let decision: GateDecision
    try {
      decision = await decideAutoStart(
        item,
        stored,
        login,
        activitySinceFor(token, item, login ?? ''),
      )
    } catch (err) {
      decision = { start: true, why: `gate threw (${String(err)}) — failing open` }
    }
    console.log(`[github-poller] auto-start ${decision.start ? 'ALLOW' : 'SKIP'} ${at}: ${decision.why} | ${inputs}`)
    if (!decision.start) continue

    autoSpawner(item.id, { skipSelfEcho: item.kind === 'my-pr-activity' })
      .then((r) => {
        const skipped = (r as { skipped?: string }).skipped
        if (skipped) console.log(`[github-poller] auto-start skipped for ${at}: ${skipped}`)
      })
      .catch((err) => console.warn(`[github-poller] auto-start failed for ${at}:`, err))
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
let lastModified: string | null = null
let pollSeconds = DEFAULT_POLL_SECONDS
let authLost = false
let ticking = false
let tickCount = 0

export function isAuthLost(): boolean {
  return authLost
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function broadcastItems(): void {
  sendToRenderer('github:changed', githubStore.getItems())
}

function broadcastAuthLost(): void {
  sendToRenderer('github:authLost')
}

// ── Notification shape (the slice of the API response we read) ───────────────

interface ApiNotification {
  id: string
  reason: string
  unread: boolean
  updated_at: string
  repository: { full_name: string }
  subject: { title: string; url: string | null; latest_comment_url: string | null; type: string }
}

interface ApiPull {
  number: number
  title: string
  html_url: string
  state: 'open' | 'closed'
  draft: boolean
  merged: boolean
  user: { login: string }
  requested_reviewers?: { login: string }[]
  head: { sha: string }
}

function prState(pr: ApiPull): GithubItem['prState'] {
  if (pr.merged) return 'merged'
  if (pr.state === 'closed') return 'closed'
  if (pr.draft) return 'draft'
  return 'open'
}

/** Hydrate one notification thread into a panel item via its PR API url.
 *  Null for anything that isn't a PR or fails to load (skipped, retried on a
 *  later poll because we only advance If-Modified-Since, not per-thread state). */
async function hydrate(token: string, n: ApiNotification, login: string | null): Promise<GithubItem | null> {
  const kind = REASON_TO_KIND[n.reason]
  if (!kind || n.subject.type !== 'PullRequest' || !n.subject.url) return null
  try {
    const res = await fetch(n.subject.url, { headers: apiHeaders(token) })
    if (!res.ok) return null
    const pr = (await res.json()) as ApiPull
    return {
      id: n.id,
      kind,
      repo: n.repository.full_name,
      prNumber: pr.number,
      title: pr.title,
      author: pr.user.login,
      htmlUrl: pr.html_url,
      prState: prState(pr),
      updatedAt: n.updated_at,
      unread: n.unread,
      latestCommentUrl: n.subject.latest_comment_url,
      headSha: pr.head?.sha,
      notificationReason: n.reason,
      reviewRequested: login ? (pr.requested_reviewers ?? []).some((r) => r.login === login) : undefined,
    }
  } catch {
    return null
  }
}

function notifyNewItems(fresh: GithubItem[]): void {
  if (!Notification.isSupported()) return
  // One notification per poll, not per item — a burst (first poll after a
  // weekend) must not spam the notification center.
  const unread = fresh.filter((i) => i.unread)
  if (unread.length === 0) return
  const first = unread[0]
  const kindLabel: Record<GithubItemKind, string> = {
    'review-request': 'requested your review on',
    mention: 'mentioned you on',
    'my-pr-activity': 'commented on your PR',
  }
  const body =
    unread.length === 1
      ? `${first.author} ${kindLabel[first.kind]} ${first.repo}#${first.prNumber}: ${first.title}`
      : `${first.repo}#${first.prNumber}: ${first.title} — and ${unread.length - 1} more`
  new Notification({ title: 'GitHub', body }).show()
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const auth = await getActiveToken()
    if (!auth) {
      if (!authLost) {
        authLost = true
        broadcastAuthLost()
      }
      return
    }

    tickCount += 1
    const fullSync = tickCount % FULL_SYNC_EVERY_N_TICKS === 1 // first tick + every Nth
    const headers = apiHeaders(auth.token)
    if (lastModified && !fullSync) headers['If-Modified-Since'] = lastModified
    const res = await fetch(`${GITHUB_API}/notifications?all=true&per_page=50`, { headers })

    if (res.status === 304) return // nothing new — free request

    if (res.status === 401 || res.status === 403) {
      // Token rotated/revoked (or rate-limited as 403). Drop the cache so the
      // next tick re-probes stored + gh CLI; flag auth-lost only if the
      // re-probe also fails (getActiveToken above returns null next tick).
      invalidateAuth()
      if (res.status === 401 && !authLost) {
        authLost = true
        broadcastAuthLost()
      }
      return
    }
    if (!res.ok) {
      console.warn(`[github-poller] notifications request failed (${res.status})`)
      return
    }

    authLost = false
    lastModified = res.headers.get('last-modified') ?? lastModified
    const serverInterval = Number(res.headers.get('x-poll-interval'))
    if (Number.isFinite(serverInterval) && serverInterval > 0) {
      pollSeconds = Math.max(serverInterval, DEFAULT_POLL_SECONDS)
    }

    const notifications = (await res.json()) as ApiNotification[]
    const relevant = notifications.filter((n) => REASON_TO_KIND[n.reason] && n.subject.type === 'PullRequest')
    if (relevant.length === 0) return

    // Login is needed to read requested_reviewers off each PR; cached after the
    // first resolve, so this is free on subsequent ticks.
    const login = await getViewerLogin().catch(() => null)
    const items = (await Promise.all(relevant.map((n) => hydrate(auth.token, n, login)))).filter(
      (i): i is GithubItem => i !== null,
    )
    if (items.length === 0) return

    const fresh = githubStore.upsertItems(items)
    broadcastItems()
    notifyNewItems(fresh)
    await autoStartFresh(auth.token, fresh, login)
  } catch (err) {
    console.warn('[github-poller] tick failed:', err)
  } finally {
    ticking = false
    scheduleNext()
  }
}

function scheduleNext(): void {
  if (!timer) return // stopped while ticking
  clearTimeout(timer)
  timer = setTimeout(tick, pollSeconds * 1000)
  timer.unref?.()
}

/** Start polling. Idempotent. First tick fires shortly after start so the
 *  panel has data quickly without competing with app-launch work. */
export function startGithubPoller(): void {
  if (timer) return
  timer = setTimeout(tick, 3_000)
  timer.unref?.()
  console.log('[github-poller] started')
}

export function stopGithubPoller(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

/** Force an immediate poll (panel refresh button / after connecting). Resets
 *  auth-lost so a fresh token gets a clean run. */
export async function refreshNow(): Promise<void> {
  authLost = false
  lastModified = null // full re-read, not a 304
  await tick()
}

/** Mark a thread read on GitHub, then read the thread BACK and mirror GitHub's
 *  answer. GitHub's read-state is the single source of truth — we never flip
 *  the flag locally. (The read-back also matters mechanically: a PATCH may not
 *  advance the notification list's Last-Modified, so the next poll can 304 and
 *  would never deliver the change.) On failure the mirror simply keeps its
 *  last-known GitHub state. */
export async function markThreadRead(id: string): Promise<void> {
  const auth = await getActiveToken()
  if (!auth) return
  try {
    const headers = apiHeaders(auth.token)
    const patch = await fetch(`${GITHUB_API}/notifications/threads/${id}`, { method: 'PATCH', headers })
    if (!patch.ok && patch.status !== 205) return
    const res = await fetch(`${GITHUB_API}/notifications/threads/${id}`, { headers })
    if (res.ok) {
      const thread = (await res.json()) as { unread: boolean }
      githubStore.applyThreadState(id, { unread: thread.unread })
      broadcastItems()
    }
  } catch { /* next poll re-syncs */ }
}
