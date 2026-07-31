---
slug: observer-agent
title: Observer & Insights Inbox
summary: A background agent that records how you work, mines the patterns deterministically, and once a day has a cheap LLM propose automations you accept or dismiss.
related: [sessions-overview, scheduled-tasks, agentic-pipeline, memory-knowledge-base, todos-project-notes]
---

# Observer & Insights Inbox

## What it is

The observer is an invisible background agent that watches how you use the app, looks for habits, and proposes automations for them. It never acts on its own — everything it produces lands in the **Insights inbox** at the bottom of the `Cmd+P` overview, where you accept or dismiss it.

It is built as three layers with very different costs, deliberately: cheap observation all the time, cheap statistics occasionally, an LLM rarely and only over pre-qualified candidates.

## The pipeline

**1. Capture (always, free).** Every meaningful action is appended to a SQLite log in `userData/observer.db`:

- **Tool use** from the `PreToolUse` hook — including the exact shell command, which is the single highest-signal thing about what you actually do repeatedly.
- **UI actions** — hotkeys fired, panels opened, sessions and agents spawned, pipeline tasks started, schedules created or run.
- **Session lifecycle**, tagged with the origin kind from the session registry (see `sessions-overview`).
- **session-manager MCP tool calls** — which todo/memory tools your agents reach for.

**2. Mining (every ~2h of app-open time, no LLM).** A cheap incremental pass counts three things per project: **frequency** (an action that recurs), **sequences** (2- and 3-grams of consecutive actions inside one session), and **time-of-day** clustering. It reads forward from a watermark, so an interrupted pass resumes exactly where it stopped and nothing is double-counted.

**3. Reasoning (every ~24h of app-open time, Haiku).** When a pattern has recurred on **at least 4 distinct days within 14**, it is promoted and handed to a headless Claude session — same machinery as a scheduled task, tool-restricted and read-only, no graph presence, visible in `Cmd+P` as an `observer` session. Its job is to judge whether automating the pattern would genuinely help, and if so draft a concrete proposal. It is told explicitly that **rejecting is the expected outcome for most patterns**.

The same run also does curation housekeeping: proposing wikilinks between memory notes that are clearly about the same subject but don't reference each other, and flagging open todos that look like they have already been done.

## The inbox

Each suggestion shows what it is, why (with the actual counts), and a one-line preview of exactly what accepting will do. Three responses:

- **Accept** — executes through the app's normal machinery: creates the scheduled task, installs the skill, creates the todo, adds the wikilink (backlinks sync as usual), or closes the todo.
- **Dismiss** — returns the pattern to the candidate pool; the suggestion history stops it being re-proposed.
- **Never suggest this** — mutes the pattern permanently.

A quiet pill appears in the bottom-right of the graph view when suggestions are waiting. It is not a notification: it does not interrupt, and it only shows on the graph, where there is nothing to interrupt.

## Scheduling: debt, not cron

The app is not left running overnight, so the observer deliberately does **not** think in wall-clock time. Each job declares "run roughly every N hours **of app-open time**" and accrues *debt* only while the app is actually running. A job fires when three things hold at once:

1. the debt is owed,
2. every live session is settled — nothing working, nothing blocked on a permission prompt,
3. that quiet has held for a while (1 min for mining, 5 min for the curator), so it doesn't jump into a two-second gap between your turns.

Debt persists across restarts but does not *grow* while the app is closed, and is capped at 2× the interval — so reopening after a week's absence does not trigger a stampede. You can bypass all of it with **Run curator now** in the inbox header.

## Privacy

The log records **what was done, never what was said**.

- Prompt bodies are never stored — only a character count.
- Tool arguments are reduced to a structural form: a shell command is kept (truncated), a file path is kept, a search pattern is kept, everything else is recorded as the tool name alone.
- Command strings are **secret-redacted before they are written** — `TOKEN=`/`SECRET=`/`API_KEY=` style assignments, `--token`/`--password` flag values, `Authorization:` headers, and known key shapes (`sk-…`, `ghp_…`, `AKIA…`, JWTs).
- MCP beacons send the tool **name** only, never arguments or note/todo content.
- Raw events are pruned after 60 days; the derived patterns and suggestions are aggregates and are kept.
- The whole store is deletable from **Settings → Cleanup → Observer activity log**, which also wipes your "never suggest this" mutes.

## Gotchas & tips

- **Nothing happens for the first few days.** A pattern needs 4 distinct days inside a 14-day window before it is even eligible, and single occurrences are never written down at all. This is intentional — day-based support means one frantic afternoon cannot manufacture a "habit".
- **Accepted scheduled tasks are created disabled.** A one-click accept should not silently start firing Claude sessions on a timer — read the prompt in `Cmd+J` and enable it yourself.
- Proposed interval recurrences are floored at 15 minutes regardless of what the curator asks for.
- The curator will not run for housekeeping alone; it needs at least one promoted pattern. It also skips entirely when 12+ suggestions are already pending — the goal is a trickle of good proposals, not a queue.
- The curator's only write path is the `observer-suggest` MCP tool. It cannot create schedules, edit memory, or close todos itself, and its `--allowedTools` list enforces that.
