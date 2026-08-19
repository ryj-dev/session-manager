import { app } from 'electron'
import { join } from 'path'
import { readFileSync, mkdirSync } from 'fs'
import { atomicWriteSync } from './atomic-write'

// Persistence for GitHub PR notification items shown in the GitHub panel.
// Pure storage (pattern: schedule-store) — polling, hydration, broadcasts and
// native notifications live in github-poller.ts / ipc.ts, NOT here.

/** Which panel section an item belongs to, mapped from the GitHub notification
 *  `reason` by the poller:
 *    review_requested        → 'review-request'
 *    mention / team_mention  → 'mention'
 *    author                  → 'my-pr-activity' (someone commented/reviewed my PR)
 */
export type GithubItemKind = 'review-request' | 'mention' | 'my-pr-activity'

/** A prepared-but-not-necessarily-posted response, written by an agent via the
 *  github-respond MCP tool. Submission (posting the review / pushing commits +
 *  replies) is done by the MAIN process (github-actions.ts) — under 'draft'
 *  mode only after the user clicks Submit in the panel; under 'auto' mode
 *  immediately. The draft-gate is structural: agents never post directly. */
export interface GithubDraft {
  type: 'review' | 'reply-with-fixes'
  /** Reviews only. */
  verdict?: 'approve' | 'request-changes' | 'comment'
  /** Review summary / reply text (markdown). For reply-with-fixes with
   *  per-thread replies, use `replies` instead and keep this as the overview. */
  body: string
  /** Line comments (reviews only). */
  comments?: { path: string; line: number; body: string }[]
  /** Per-thread replies (reply-with-fixes): comment id → reply body. */
  replies?: { commentId: number; body: string }[]
  /** reply-with-fixes: local commits exist on the PR branch, NOT yet pushed —
   *  submit = push + post replies. */
  commitsReady?: boolean
  /** Local checkout the commits live in (required when commitsReady). */
  repoPath?: string
  /** App session id of the agent that produced the draft. */
  sessionId: string | null
  createdAt: string
}

export interface GithubItem {
  /** GitHub notification thread id — stable per PR per user. */
  id: string
  kind: GithubItemKind
  /** "owner/repo" */
  repo: string
  prNumber: number
  title: string
  /** PR author login. */
  author: string
  htmlUrl: string
  /** open | closed | merged | draft */
  prState: 'open' | 'draft' | 'merged' | 'closed'
  /** Notification's updated_at — advances when new activity lands. */
  updatedAt: string
  /** Mirror of GITHUB's read-state — the single source of truth. Never flipped
   *  locally: written only from poll responses and post-PATCH read-backs
   *  (github-poller.markThreadRead). */
  unread: boolean
  /** API url of the newest comment/review on the thread, when GitHub provides
   *  one — gives "Address comments" a concrete starting point. */
  latestCommentUrl: string | null
  /** Prepared response awaiting submission (draft mode) — see GithubDraft. */
  draft?: GithubDraft | null
  /** ISO timestamp of the last submitted response, with a one-line summary —
   *  set by github-actions on successful submit. */
  respondedAt?: string
  respondedSummary?: string
}

interface GithubData {
  items: GithubItem[]
}

// Keep the list bounded; stale threads fall off the end (sorted by updatedAt).
// Generous on purpose — this is the panel's "all time" history (GitHub's
// notifications API can't backfill anything from before we started polling),
// and filtering/rendering is all local, so the cap is about file size, not speed.
const ITEM_LIMIT = 1000

let cache: GithubItem[] | null = null

function storePath(): string {
  const dir = join(app.getPath('userData'), 'state')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'github.json')
}

export function getItems(): GithubItem[] {
  if (cache) return cache
  try {
    const parsed: GithubData = JSON.parse(readFileSync(storePath(), 'utf-8'))
    cache = parsed.items || []
  } catch {
    cache = []
  }
  return cache
}

function persist(items: GithubItem[]): GithubItem[] {
  cache = items
  atomicWriteSync(storePath(), JSON.stringify({ items }, null, 2))
  return items
}

/** Upsert a batch of freshly-polled items. Returns the subset that is NEW
 *  ACTIVITY (unseen thread id, or an existing thread whose updatedAt advanced
 *  while unread) — the poller uses this for native notifications. */
export function upsertItems(incoming: GithubItem[]): GithubItem[] {
  const existing = new Map(getItems().map((i) => [i.id, i]))
  const fresh: GithubItem[] = []
  for (const item of incoming) {
    const prev = existing.get(item.id)
    if (!prev || (item.unread && item.updatedAt > prev.updatedAt)) fresh.push(item)
    // Incoming items are GitHub-derived only — carry the app-owned fields
    // (draft, responded stamps) forward or a poll would wipe a pending draft.
    existing.set(
      item.id,
      prev
        ? { ...item, draft: prev.draft, respondedAt: prev.respondedAt, respondedSummary: prev.respondedSummary }
        : item,
    )
  }
  const merged = [...existing.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, ITEM_LIMIT)
  persist(merged)
  return fresh
}

/** Apply thread state READ BACK FROM GITHUB (never locally invented — GitHub's
 *  notification read-state is the single source of truth; see github-poller's
 *  markThreadRead). */
export function applyThreadState(id: string, state: { unread: boolean }): GithubItem[] {
  return persist(getItems().map((i) => (i.id === id ? { ...i, unread: state.unread } : i)))
}

export function getItem(id: string): GithubItem | undefined {
  return getItems().find((i) => i.id === id)
}

export function putDraft(id: string, draft: GithubDraft): GithubItem[] {
  return persist(getItems().map((i) => (i.id === id ? { ...i, draft } : i)))
}

export function clearDraft(id: string): GithubItem[] {
  return persist(getItems().map((i) => (i.id === id ? { ...i, draft: null } : i)))
}

export function markResponded(id: string, summary: string): GithubItem[] {
  return persist(
    getItems().map((i) =>
      i.id === id ? { ...i, draft: null, respondedAt: new Date().toISOString(), respondedSummary: summary } : i,
    ),
  )
}

export function removeItem(id: string): GithubItem[] {
  return persist(getItems().filter((i) => i.id !== id))
}

export function clearItems(): GithubItem[] {
  return persist([])
}
