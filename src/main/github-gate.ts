import type { GithubItem } from './github-store'

// The auto-start gate: given fresh notification activity, should the app spawn
// a review/fix agent? Pure decision logic, no electron and no network — the
// poller injects the one thing that needs the API (what was written on the PR
// since we last closed the item out) so this stays unit-testable.

export interface GateDecision {
  start: boolean
  /** Human-readable justification — always logged, whichever way it goes. */
  why: string
}

/** Bodies of everything a human wrote on the PR after `since`, excluding our
 *  own posts. Null = could not be determined; the gate then fails open. */
export type ActivitySince = (since: string) => Promise<string[] | null>

/** Decide whether fresh activity on an item warrants spawning an agent.
 *
 *  Each kind is gated by its own natural signal:
 *   - review-request — the login must currently be in requested_reviewers
 *     (GitHub clears it when you submit a review, re-adds it on an explicit
 *     re-request), PLUS a head-SHA backstop so a fail-open on that signal
 *     cannot produce a second pass over a commit we already answered.
 *   - mention — since we last closed the item out, someone other than us must
 *     have actually written @login. A notification's `reason` flips to
 *     `mention` on the first @mention and NEVER flips back, so review-requested
 *     PRs land in this bucket permanently; without this test every subsequent
 *     push re-reviews (Trilogy-Care/tc-assistant#349 ran four unrequested
 *     rounds that way). Deliberately NOT head-SHA gated: an explicit question
 *     at an already-reviewed commit still deserves an answer.
 *   - my-pr-activity — ungated by design; every comment on our own PR gets a
 *     reply, and runGithubAgent's self-echo check handles our own posts.
 *
 *  Every uncertain branch fails OPEN: a redundant run is recoverable, a
 *  silently-dropped review request is not.
 *
 *  @param item    the freshly-hydrated item (GitHub-derived fields)
 *  @param stored  the same item as persisted, carrying the app-owned
 *                 respondedAt / respondedHeadSha stamps
 */
export async function decideAutoStart(
  item: GithubItem,
  stored: GithubItem | undefined,
  login: string | null,
  activitySince: ActivitySince,
): Promise<GateDecision> {
  const respondedAt = stored?.respondedAt
  const respondedHeadSha = stored?.respondedHeadSha

  if (item.kind === 'review-request') {
    if (item.reviewRequested === false && respondedAt) {
      return { start: false, why: 'already reviewed and not re-requested' }
    }
    if (respondedHeadSha && item.headSha && respondedHeadSha === item.headSha) {
      return { start: false, why: `head ${item.headSha.slice(0, 8)} was already responded to` }
    }
    return { start: true, why: item.reviewRequested ? 'review is currently requested' : 'no prior response recorded' }
  }

  if (item.kind === 'mention') {
    if (!respondedAt) return { start: true, why: 'first activity on this thread' }
    if (item.notificationReason === 'team_mention') {
      return { start: true, why: 'team mention — the body carries @org/team, not the login' }
    }
    if (!login) return { start: true, why: 'connected login unknown — failing open' }
    const bodies = await activitySince(respondedAt)
    if (bodies === null) return { start: true, why: 'PR activity unreadable — failing open' }
    const needle = `@${login.toLowerCase()}`
    if (bodies.some((b) => b.toLowerCase().includes(needle))) {
      return { start: true, why: `someone wrote @${login} since the last response` }
    }
    return { start: false, why: `no @${login} in the ${bodies.length} activities since the last response` }
  }

  return { start: true, why: 'activity on my own PR' }
}
