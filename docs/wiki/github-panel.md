---
slug: github-panel
title: GitHub Panel
summary: "Cmd+G: PR review requests, mentions, and activity on your PRs, polled from GitHub; one click spawns a draft-first Claude session to review a PR or address its comments."
related: [spawned-sessions, scheduled-tasks, hotkeys-settings, sessions-overview]
---

# GitHub Panel

## What it is

The GitHub panel (`Cmd+G`) mirrors your GitHub PR notifications into the app and turns them into one-click Claude work. The main process polls the GitHub Notifications API (~every 60s, honouring GitHub's `X-Poll-Interval` / `If-Modified-Since` contract, so quiet polls are free).

**Unread activity comes first**: everything GitHub considers new for you sits in a cross-kind "Unread activity" section at the top (each item chipped with its kind), always visible regardless of filters. Below it, three sections hold the read history:

- **Review requests** — someone requested you as a reviewer (`review_requested`; no @mention needed).
- **Mentions** — you were @mentioned on a PR (`mention` / `team_mention`).
- **Activity on my PRs** — comments and reviews landing on PRs you authored (`author`).

New unread activity also fires a native desktop notification (one per poll, never one per item).

## Authentication

Zero-friction by design — the panel auto-detects, you rarely have to do anything:

1. **Stored token** (if you connected explicitly) — encrypted with `safeStorage`, survives `gh auth logout`.
2. **GitHub CLI** — if `gh auth login` has been run, its token is picked up automatically.

Not connected? The panel offers **device flow** (code shown, approve in browser; requires the app to be built with an OAuth client id — `GITHUB_OAUTH_CLIENT_ID`) or **pasting a personal access token** (needs `repo` scope; classic-token scopes are validated with a warning if insufficient).

A `401` mid-flight (rotated/revoked token) never goes silently stale: the poller drops its token cache, re-probes, and if nothing works the panel shows a reconnect banner.

## Claude agents, drafts, and the structural gate

"Start review" / "Address comments" (and the auto-start rules below) spawn a **real graph session** in the repo's local checkout (matched via `.git/config` remotes under your base projects folder). The agent reads with the gh CLI but **cannot post**: it hands its finished response to the app via the `github-respond` MCP tool, and the app decides what happens — the gate is structural, not a prompt convention.

- **Review** (requests & mentions): verdict (approve / request-changes / comment) + summary + line comments.
- **Reply-with-fixes** (your PRs): per-thread replies, plus fixes **committed locally but never pushed** by the agent.

Under **draft** mode (and for all manual starts) the response lands on the item as a **"Draft ready"** block — view it, then **Submit** (the app posts the review, or pushes the commits + posts the replies, using your token) or **Discard**. Under **auto** mode the app submits immediately. A pending draft is never hidden by filters; failed submissions keep the draft for retry; submitted items show a "✓ responded" record.

**"Nothing to do" is a real outcome.** Plenty of activity doesn't deserve a reply — a Linear/CI bot comment, colleagues talking to each other, an approval with no questions. The agent closes those out by calling `github-respond` with type **`none`** and a one-line reason; the item gets a muted **"⊘ no action needed — <reason>"** record, the thread is marked read, and **nothing is posted to GitHub**. The reasoning stays resumable via **Discuss**, same as any response.

This is mandatory, not optional: an agent that simply ends its turn without calling `github-respond` leaves the item **stuck** — it can neither finish nor re-trigger, because the one-agent-per-item guard still believes a session is running. As a backstop the app now tears down *any* finished GitHub agent (crashed or silent included) and releases that guard, so a misbehaving agent costs you one missed response rather than a permanently frozen item.

**Agents run in the background, off the graph** (like scheduled runs); mid-run they're visible in the ⌘P overview under "GitHub agents", and their panel card shows a pulsing **Watch live** button that opens the working terminal. Results surface via the amber **"N drafts ready"** pill in the graph's corner (like the insights pill) — no native notifications.

**Session lifecycle** (focus-aware):
- Finishes while you're NOT watching → PTY torn down; conversation kept resumable.
- Finishes while you ARE watching (its terminal is your focused view — the ⌘P overview and the panel don't count) → stays open so you can start talking.
- Watched but you navigate away without engaging → torn down once idle + away.
- **You send it a prompt (any time) → adopted**: it becomes a normal graph session, never auto-closes, and ages like any other session.

The conversation always stays resumable after teardown — **Discuss** on the draft block / responded record re-opens it focused, so you can question the reasoning or ask for revisions ("soften comment 2, then respond again" — a re-respond replaces the draft). Note that spawning an agent marks the thread read on GitHub — with auto-review on, the "needs your attention" signal is the **Drafts awaiting your review** section (always sorted first, above Unread activity), not the unread dot.

The agent's **model** is configurable in Settings → GitHub auto-review (haiku/sonnet/opus/fable, or default = your current model).

### Auto-start rules (Settings → GitHub auto-review)

Per event kind — review requests / mentions / comments on my PRs — choose **Off** (manual buttons only, the default), **Draft** (auto-spawn, you approve the result), or **Auto** (auto-spawn and post directly). Safeguards: one active agent per item, self-echo suppression (activity authored by your own login never triggers a spawn), and only open/draft PRs qualify. Something with nothing to answer (an approval carrying no comments, a bot notice) is closed out as "⊘ no action needed" rather than generating a response.

**Re-reviews need a real invitation.** Any activity on a PR re-marks its notification thread unread, so without gating a single review request produces a fresh review on every push. Each kind is gated by its own signal:

| Kind | Auto-start when… |
|------|------------------|
| Review requests | your login is currently in the PR's `requested_reviewers` (GitHub clears it the moment you submit a review and re-adds it on an explicit **re-request review**) — plus a head-SHA backstop that refuses a second pass over a commit you already answered |
| Mentions | somebody other than you has actually written `@your-login` on the PR since you last closed the item out. Pushes, other people's reviews and general chatter do not qualify; an explicit question does, even at a commit you already reviewed |
| Comments on my PRs | always — every piece of feedback on your own PR deserves a reply (self-echo suppression aside) |

The mention rule matters more than it looks: a notification's reason flips to `mention` the first time anyone @-mentions you and **never flips back**, so review-requested PRs permanently migrate into the mentions bucket. Gating mentions on an actual @-mention is what stops those from re-reviewing on every push.

Every uncertain branch fails **open** — an unreachable API, an unresolvable login, a team mention (`@org/team` carries no login to match) all spawn rather than stay silent, on the grounds that a redundant review is recoverable and a dropped review request is not. Each decision is logged with its inputs (`kind`, reason, `reviewRequested`, head SHA, response stamps) so a fail-open is diagnosable after the fact.

Anything gated off just shows up as ordinary unread activity for you to triage, and the manual "Start review" button is never gated — you can always re-review by hand.

### MCP tools (agent visibility)

| Tool | Purpose |
|------|---------|
| `github-inbox` | The triaged inbox with filters (kind/unread/state/repo/since) + counts envelope (unread per kind, active, drafts pending) |
| `github-get-item` | One item in full, including its pending draft |
| `github-respond` | Close out an item: hand over a prepared response (the app stores it as a draft or submits it, per the rules — agents never choose), or record type `none` when no response is warranted |
| `github-mark-read` | Clear a thread on GitHub after handling it |

PR content (diffs, comments, checkouts) stays on the gh CLI — these tools only cover the app's triage and the response gate.

## Filters

Two persisted filters (settings blob) sit above the sections:

- **State** — `Active` (default) hides merged/closed PRs; `All states` shows everything.
- **Range** — `24h` / `Week` (default) / `Month` / `All time`, by notification updated-at.

**Unread items always show regardless of filters** — a filter never hides something GitHub considers new for you. A "N hidden — show all" shortcut expands both filters at once. Filtering is purely local (the panel reads a persisted mirror capped at 1000 items), so "All time" costs nothing; note GitHub's notifications API cannot backfill history from before the feature started polling.

## Gotchas

- Actions need a local clone under **Settings → base projects folder**; without one the panel tells you to clone first.
- The buttons only show for open/draft PRs; merged/closed items are display-only.
- **GitHub's read-state is the single source of truth** — "Mark read" PATCHes GitHub and mirrors the answer back (never flips locally), and every ~10th poll is a full re-sync so reads made on github.com converge too.
- Full disconnect when riding the gh CLI token means `gh auth logout` — the panel's Disconnect only forgets a stored token.
