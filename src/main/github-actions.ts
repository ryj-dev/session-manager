import { BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { loadSettings } from './settings-store'
import * as githubStore from './github-store'
import type { GithubDraft, GithubItem } from './github-store'
import { getActiveToken, apiHeaders, GITHUB_API } from './github-auth'
import { markThreadRead } from './github-poller'

// The ONLY code path that posts a prepared response to GitHub. Both callers go
// through submitDraft:
//   - the panel's Submit button (draft mode — user approved)
//   - github-respond under 'auto' mode (submitted immediately after drafting)
// Agents never post directly; the draft-gate is structural, not a prompt
// convention.

function broadcastItems(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.send('github:changed', githubStore.getItems())
}

const REVIEW_EVENT: Record<NonNullable<GithubDraft['verdict']>, string> = {
  approve: 'APPROVE',
  'request-changes': 'REQUEST_CHANGES',
  comment: 'COMMENT',
}

async function post(token: string, url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** `git push` in the draft's checkout. The PR branch is already checked out
 *  and committed by the drafting agent (commitsReady contract). */
function gitPush(repoPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['push'], { cwd: repoPath, timeout: 60_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(`git push failed: ${stderr || err.message}`))
      else resolve()
    })
  })
}

async function submitReview(token: string, item: GithubItem, draft: GithubDraft): Promise<string> {
  const url = `${GITHUB_API}/repos/${item.repo}/pulls/${item.prNumber}/reviews`
  const event = REVIEW_EVENT[draft.verdict ?? 'comment']
  const payload = {
    body: draft.body,
    event,
    comments: (draft.comments ?? []).map((c) => ({ path: c.path, line: c.line, body: c.body })),
  }
  let res = await post(token, url, payload)
  if (res.status === 422 && payload.comments.length > 0) {
    // Line anchors can go stale (force-push, renamed file). Rather than fail
    // the whole review, inline the comments into the body and retry clean.
    const inlined =
      draft.body +
      '\n\n---\n' +
      payload.comments.map((c) => `**\`${c.path}:${c.line}\`** — ${c.body}`).join('\n\n')
    res = await post(token, url, { body: inlined, event })
  }
  if (!res.ok) throw new Error(`GitHub rejected the review (${res.status}): ${(await res.text()).slice(0, 300)}`)
  const verdictLabel = draft.verdict ?? 'comment'
  return `review submitted (${verdictLabel}${payload.comments.length ? `, ${payload.comments.length} line comments` : ''})`
}

async function submitReplyWithFixes(token: string, item: GithubItem, draft: GithubDraft): Promise<string> {
  const parts: string[] = []
  if (draft.commitsReady) {
    if (!draft.repoPath) throw new Error('Draft says commits are ready but has no repoPath to push from.')
    await gitPush(draft.repoPath)
    parts.push('commits pushed')
  }
  for (const reply of draft.replies ?? []) {
    const res = await post(
      token,
      `${GITHUB_API}/repos/${item.repo}/pulls/${item.prNumber}/comments/${reply.commentId}/replies`,
      { body: reply.body },
    )
    if (!res.ok) throw new Error(`Reply to comment ${reply.commentId} failed (${res.status})`)
  }
  if ((draft.replies ?? []).length > 0) parts.push(`${draft.replies!.length} replies posted`)
  // Overview body (when present and no thread replies carry it) goes up as a
  // regular PR comment.
  if (draft.body && (draft.replies ?? []).length === 0) {
    const res = await post(token, `${GITHUB_API}/repos/${item.repo}/issues/${item.prNumber}/comments`, {
      body: draft.body,
    })
    if (!res.ok) throw new Error(`PR comment failed (${res.status})`)
    parts.push('comment posted')
  }
  if (parts.length === 0) throw new Error('Draft had nothing to submit (no commits, replies, or body).')
  return parts.join(', ')
}

/** The PR's head SHA right now. Read at close-out time (not from the last
 *  poll) because that is the commit GitHub anchors the review to — the stamp
 *  is what the auto-start gate later compares against to refuse a second pass
 *  over the same commit. Null when unreadable; the store then falls back to
 *  the last-polled headSha. */
export async function fetchPrHeadSha(repo: string, prNumber: number): Promise<string | undefined> {
  try {
    const auth = await getActiveToken()
    if (!auth) return undefined
    const res = await fetch(`${GITHUB_API}/repos/${repo}/pulls/${prNumber}`, { headers: apiHeaders(auth.token) })
    if (!res.ok) return undefined
    return ((await res.json()) as { head?: { sha?: string } }).head?.sha
  } catch {
    return undefined
  }
}

/** Submit an item's pending draft. Returns a one-line summary of what was
 *  posted. Throws with a human-readable message on any failure — the draft is
 *  kept so the user can retry or edit. */
export async function submitDraft(itemId: string): Promise<string> {
  const item = githubStore.getItem(itemId)
  if (!item) throw new Error(`Unknown GitHub item ${itemId}`)
  const draft = item.draft
  if (!draft) throw new Error(`Item ${item.repo}#${item.prNumber} has no pending draft.`)
  const auth = await getActiveToken()
  if (!auth) throw new Error('Not connected to GitHub.')

  const summary =
    draft.type === 'review'
      ? await submitReview(auth.token, item, draft)
      : await submitReplyWithFixes(auth.token, item, draft)

  githubStore.markResponded(itemId, summary, await fetchPrHeadSha(item.repo, item.prNumber))
  broadcastItems()
  // Responding means we've dealt with it — clear the unread flag on GitHub
  // (GitHub remains the source of truth; markThreadRead reads the state back).
  void markThreadRead(itemId)
  console.log(`[github-actions] ${item.repo}#${item.prNumber}: ${summary}`)
  return summary
}

/** Map "owner/repo" to a local checkout under baseProjectsDir: try the
 *  same-named child dir first, then scan immediate children — matching on the
 *  remote url recorded in .git/config (a file read, no exec). Null = no clone. */
export function resolveRepoPath(repoFullName: string): string | null {
  const base = loadSettings().baseProjectsDir
  if (!base) return null
  const wantsRepo = repoFullName.toLowerCase()
  const repoName = repoFullName.split('/')[1] ?? repoFullName
  const remoteMatches = (dir: string): boolean => {
    try {
      const config = readFileSync(join(dir, '.git', 'config'), 'utf-8').toLowerCase()
      return config.includes(`${wantsRepo}.git`) || config.includes(`/${wantsRepo}\n`) || config.includes(`:${wantsRepo}\n`)
    } catch {
      return false
    }
  }
  const direct = join(base, repoName)
  if (remoteMatches(direct)) return direct
  try {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(base, entry.name)
      if (remoteMatches(dir)) return dir
    }
  } catch { /* base dir unreadable */ }
  return null
}

export function discardDraft(itemId: string): void {
  githubStore.clearDraft(itemId)
  broadcastItems()
}

/** Store a draft on an item (github-respond MCP tool, draft mode) + broadcast
 *  so the panel shows "Draft ready" immediately. */
export function putDraft(itemId: string, draft: GithubDraft): void {
  const item = githubStore.getItem(itemId)
  if (!item) throw new Error(`Unknown GitHub item ${itemId}`)
  githubStore.putDraft(itemId, draft)
  broadcastItems()
}
