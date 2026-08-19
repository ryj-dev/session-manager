---
slug: observer-agent
title: "Observer & Insights Inbox"
summary: "Opt-in background agent: a Haiku digest of each finished session's intent and friction, a reflective Sonnet curator with its own cross-run journal, and an inbox of proposals you accept or dismiss."
related: [sessions-overview, scheduled-tasks, agentic-pipeline, memory-knowledge-base, todos-project-notes, session-archiving-auto]
---

# Observer & Insights Inbox

## What it is

The observer is an **opt-in** background agent that reads digests of your finished Claude Code sessions, reflects on what recurs — goals, friction, missing knowledge — and proposes concrete improvements. It never acts on its own: everything it produces lands in the **Insights inbox** at the bottom of the `Cmd+P` overview, where you accept or dismiss it.

It is off by default. Enable it in **Settings (`Cmd+O`) → Observer**. The toggle is the whole switch: while off, no transcripts are read, nothing is queued, and no background runs are scheduled.

This is the v2 architecture. V1 captured tool names and shell commands into an event log and mined them statistically; 19 days of data produced essentially nothing actionable, because "what was done" without "what was meant" cannot answer *is this automatable?*. V2 deletes the capture/mining layer entirely — including its event store, the app's most sensitive data — and works from session **content** instead, which is why it is opt-in.

## The pipeline

**1. Session digests (Haiku, automatic).** Claude Code already writes a full transcript of every conversation to `~/.claude/projects/**/*.jsonl`; the observer reads those — it captures nothing of its own. When a session ends **by any path** (`Cmd+Shift+W`, kill, PTY exit, or auto-archive teardown), a durable queue row flips to *ready*. Sessions still open when the app quits are caught up at the next launch. Every ~15 minutes of app-open time, when the app is quiet, the queue drains: each ready session gets **one Haiku paragraph** — intent (what you were trying to do), friction (what you fought), outcome — via a headless `claude -p` child process. No PTY, no graph node, no tools.

- Trivial sessions (fewer than 3 turns) are skipped.
- Digests are keyed by **conversation**, with a turn watermark — a session resumed after archiving (or across an app restart) extends its existing digest with a dated "continued" paragraph rather than starting over, and already-digested turns are never re-read.
- Long-lived sessions that idle without ending get the same incremental treatment once ~10 new turns have accumulated.
- Only your own work is digested: `user` and `agent` sessions (and anything untagged). Pipeline workers, scheduled runs, drawer previews and the curator's own runs are excluded at the source.

**2. The reflective curator (Sonnet, every ~24h of app-open time).** A headless run — same machinery as a scheduled task, tool-restricted, visible in `Cmd+P` as an `observer` session — that is asked one question: **"what recurring goal, friction, or missing knowledge do you observe?"** It receives the digests that are new since its last run (fenced as data, never instructions), and cross-references them against your memory notes, todos, scheduled tasks and this wiki before proposing anything.

What makes it *reflective* is the **observations journal**: a private markdown file the curator reads at the start of every run and rewrites at the end — hypotheses with evidence counts, ideas it rejected and why, what to watch for next time. One session's friction is an anecdote; the journal is how the same friction seen across weeks accrues into a confident suggestion. Filing zero suggestions and just updating the journal is an expected, good outcome.

**3. Housekeeping (Haiku, every ~72h, decoupled).** Mechanical curation on its own cadence with no digest precondition: proposing wikilinks between memory notes that are clearly about the same subject, flagging open todos that are verifiably already done, and flagging note-hygiene problems (duplicates, contradictions, staleness) as todos.

## What it can propose

Each suggestion shows what it is, why (citing what was observed), and a preview of exactly what accepting will do:

- **scheduled-task** — repeatable unattended work; created **disabled**, enable it in `Cmd+J` after reading the prompt.
- **skill** — a reusable slash command; the full body is shown up front, and an accepted skill persists in `~/.claude/commands/`.
- **todo** — a reminder for you; **pipeline-candidate** — the same, framed as a well-scoped backlog item to start from the `Cmd+L` pipeline board.
- **memory-note** — knowledge your sessions keep re-deriving, written as a normal memory note (tagged `from:observer`).
- **claude-md** — a working rule appended to your global `~/.claude/CLAUDE.md`; like skills, the full text is shown before you accept, and accepting refuses to *create* the file if you don't already have one.
- **use-feature** — "you're doing X by hand; the app has a feature for it", pointing at a wiki article. Accepting just acknowledges it.
- **memory-link** / **todo-cleanup** — housekeeping: add a wikilink (backlinks sync as usual) or close a done todo.

Three responses: **Accept** (executes through the app's normal machinery), **Dismiss**, and **Never suggest this**. Resolved titles — all "never"s, plus recent accepts/dismissals — are injected into every future curator prompt as a do-not-re-propose list, and the curator's journal carries the longer memory of *why*.

A quiet pill appears in the bottom-right of the graph view when suggestions are waiting. It is not a notification: it does not interrupt, and it only shows on the graph, where there is nothing to interrupt.

## The Journal tab

The inbox has a second tab showing the curator's observations journal, read-only. It is deliberately **not** a memory note: it lives in `userData/observer-journal.md`, never appears in `search-memories`, the memory graph, or prompt-time memory injection, and the only writer is the in-flight curator run. It is capped at ~64k characters — a write over the cap is rejected with an instruction to compact, which forces the curator to curate its own memory rather than accrete.

## Scheduling: debt, not cron

The app is not left running overnight, so the observer deliberately does **not** think in wall-clock time. Each job (digests / curator / housekeeping) declares "run roughly every N hours **of app-open time**" and accrues *debt* only while the app is running. A job fires when three things hold at once:

1. the debt is owed,
2. every live session is settled — nothing working, nothing blocked on a permission prompt,
3. that quiet has held for a while (1 min for the digest drain, 5 min for curator/housekeeping runs), so it doesn't jump into a two-second gap between your turns.

Debt persists across restarts but does not *grow* while the app is closed, and is capped at 2× the interval — reopening after a week's absence does not trigger a stampede. You can bypass all of it with **Run curator now** in the inbox header.

A run that **skips** — no new digests since the last run, another observer run already in flight, or 12+ suggestions already pending — keeps its debt, so the job stays eligible instead of waiting out another full interval for work that never happened. Curator and housekeeping share a single in-flight slot: at most one observer session exists at a time.

An observer run **terminates when it finishes**. It is an interactive `claude`, so on its `Stop` hook it goes through the same teardown as a scheduled run: the PTY is killed and its run token invalidated, rather than the process sitting at a prompt for the rest of the app's life.

## Privacy & security

- **Opt-in is the boundary.** V2 reads session transcript content — that is its entire value — so nothing runs until you flip the toggle. V1's always-on event log (commands, paths, UI actions, and its secret-redaction machinery) is gone; on first launch after the upgrade the old `events`/`patterns` tables are dropped and the space reclaimed.
- Digests and the queue live in `userData/observer.db`; the journal in `userData/observer-journal.md`. Both are yours to read, and the store is deletable from **Settings → Cleanup → Observer store** (which also wipes your "never suggest this" mutes).
- Digest text is treated as **untrusted** when it re-enters a prompt: each digest is fenced as data, and the curator is told an instruction appearing inside a fence is itself grounds for distrust.
- The curator's write paths are enforced in code, not prompt:
  - Its MCP server **never registers** anything beyond the read tools plus `observer-suggest` and the two journal tools. The run's environment carries `SM_OBSERVER_ROLE=curator`, and registration is gated on it (`--allowedTools` alone would not do this: it pre-approves, it does not deny, and the run uses `--permission-mode auto`). Symmetrically, `observer-suggest` and the journal tools are withheld from every ordinary session, so nothing else can file suggestions or poison the journal.
  - The `/observer/suggest` and `/observer/journal-*` endpoints behind those tools require a **token minted fresh for each run**, delivered only through that run's environment and burned when the run ends. A missing token, another session's token, and a replay after the run has finished are all rejected.

## Gotchas & tips

- **Nothing happens immediately after enabling.** Digests only exist for sessions that end *after* the toggle goes on, and the curator skips until there are new digests. Give it a day or two of normal work.
- **The digest drain waits for quiet.** If you never stop typing, digests queue up harmlessly and drain during your next lull (or app launch).
- **Accepted skills are permanent**; accepted **scheduled tasks are created disabled**; proposed interval recurrences are floored at 15 minutes regardless of what the curator asks for.
- **`claude-md` proposals deserve a real read** — the appended text steers every future session in every project. The full text is always shown before you accept.
- The digest model is Haiku and the curator is Sonnet by design: digests are high-volume and mechanical, reflection is rare and hard. Expect roughly a Sonnet-run-per-day of cost at typical usage, only while enabled.
- Deleting the observer store resets digests and the do-not-re-propose history, but not the journal; the journal file is separate and can be deleted by hand if you want the curator fully amnesiac.
