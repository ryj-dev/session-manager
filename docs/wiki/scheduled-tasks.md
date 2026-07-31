---
slug: scheduled-tasks
title: Scheduled Tasks
summary: Cmd+J fires saved prompts into fresh unattended sessions on launch / first-of-day / interval / daily triggers, with resumable run history.
related: [agentic-pipeline, spawned-sessions, hook-integration-status, mcp-server-overview, sessions-overview]
---

# Scheduled Tasks

## What it is

Scheduled tasks (`Cmd+J`) run a saved prompt as a fresh, unattended Claude session in a chosen directory on a trigger. Each run is a one-shot: spawn, work, finish — and is kept as **resumable history** so you can open the conversation afterwards and talk to it. Schedules only fire while the app is open.

## How to use it

Open `Cmd+J` → create a schedule with:

- **Name** and **prompt** (the full brief for each run) and **project directory**.
- **When to run** — combine:
  - *Launch trigger*: `off` / `every` app launch / `firstOfDay` (first launch of each calendar day).
  - *Recurrence*: none / every N minutes-or-hours / daily at HH:MM (local time).
  - *Max runs per day*: cap on automatic fires (0 = unlimited).
  The form shows a live plain-English preview, e.g. "Runs the first time you open the app each day, then every hour while the app is open. Up to 6 times a day."
- **Model** — Default (inherit), Haiku, Sonnet, Opus, or Fable (aliases resolve to the newest version the installed CLI supports; a full model id set via MCP is preserved).
- **Auto-approve** (default on) — runs with `--permission-mode auto` so unattended runs aren't stuck on permission prompts.
- Optional **allowedTools** restriction (`send-message` auto-added).

Cards offer **▶ Run now** (bypasses the daily cap), enable/disable, edit, delete, and per-run history — click a finished run to resume its conversation; click an in-progress run to attach to the live terminal.

## MCP tools

`create-scheduled-task` (name, prompt, projectPath, recurrence `{kind:'none'|'interval',minutes|'daily',hour,minute}`, launch `off|every|firstOfDay`, autoApprove, enabled, allowedTools, model), `update-scheduled-task` (patch; `model: ""` clears), `list-scheduled-tasks`, `get-scheduled-task` (run history omitted unless `includeRuns:true`), `list-scheduled-task-runs` (capped at 25), `enable-` / `disable-` / `delete-scheduled-task`. Recurrence mirrors the UI — it is **not cron**. Note: `maxRunsPerDay` is currently set from the UI form, not the MCP create/update schema.

## Scheduling behavior

- A launch sweep fires ~4 s after app start; a tick runs every 30 s thereafter.
- *Interval* spacing counts from the last run (or scheduler start). *Daily* fires at the first tick at/after HH:MM and naturally catches up — a daily schedule whose slot passed while the app was closed fires on the next launch.
- A schedule with a run still in flight is skipped (no pileup); dead-PTY zombies don't count as in-flight.
- Run history is pruned to ~25 entries per schedule.

## Failure handling

- **Login failures detected**: if the spawned `claude` exits or sits at a login prompt (common first thing in the morning), the run is marked `error` with a reason instead of hanging as "working" forever.
- **Errored runs don't consume quota**: they're excluded from first-of-day and max-runs-per-day accounting, and a failed daily slot retries the same day — so after you log in (or restart the app), the schedule re-fires automatically.
- On app restart, orphaned "working" runs with dead PTYs are reconciled to `error('Interrupted — app restarted.')`.
- You can open an in-progress run's live terminal and `/login` in place.

## Use cases

- A first-of-day idea-generation or inbox-triage routine in a specific repo.
- Hourly repo health checks (build status, flaky tests) on Haiku to keep costs down.
- A daily 17:00 summary prompt whose runs you occasionally resume to dig deeper.

## Gotchas & tips

- Scheduled sessions **stay out of the graph** and out of quit-save/restore; the `Cmd+J` panel is their home.
- After a run's `Stop` event the PTY is torn down but the Claude conversation id is kept — "resume" opens a fresh PTY on the same conversation.
- Nothing fires while the app is closed; use `firstOfDay` + daily catch-up semantics for "morning" jobs rather than expecting a background daemon.
