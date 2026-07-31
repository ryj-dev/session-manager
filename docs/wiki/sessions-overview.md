---
slug: sessions-overview
title: Sessions Overview
summary: Cmd+P lists every live session the app owns — graph, pipeline, scheduled, agents, observer — grouped by owner, with status, uptime, parent linkage and kill.
related: [graph-view, agentic-pipeline, scheduled-tasks, observer-agent, hook-integration-status]
---

# Sessions Overview

## What it is

`Cmd+P` opens a full-screen panel listing **every live session the app owns**, whatever spawned it. Before it existed, that knowledge was split across three surfaces that never met: the graph view showed user sessions, the pipeline board (`Cmd+L`) showed orchestrators and workers, the scheduled-tasks panel (`Cmd+J`) showed in-flight runs, and headless background sessions showed nowhere at all. The overview is the one place that answers "what is running right now, and who started it".

## How to use it

Press `Cmd+P` (configurable as `openOverview`). Sessions are grouped by owner:

- **Graph sessions** — Claude sessions you spawned; what the graph view shows.
- **Pipeline sessions** — orchestrators and workers, sub-grouped per task, with the role (`plan`, `implement`, `review`) on each row.
- **Scheduled task runs** — in-flight runs, sub-grouped per schedule.
- **Spawned agents & terminals** — agent-gallery sessions and raw shells.
- **Background observer** — the curator when it is running, plus its status line and when it next plans to run (see `observer-agent`).

Each row shows a **kind badge**, a **status dot**, the **project**, **uptime**, and a `↳` chip linking to the session that spawned it. Hovering a row reveals two actions:

- **open** — jumps to wherever that session lives: focused view for graph sessions, agents and terminals; the `Cmd+L` board for pipeline sessions; the `Cmd+J` panel for scheduled runs.
- **kill** — terminates the PTY, behind a confirmation that says what is lost (for a pipeline session: the in-flight turn only — the task stays on the board and its conversation is resumable).

The **Insights** section at the bottom is the observer's inbox — see `observer-agent`.

## Status dots

| Dot | Meaning |
|-----|---------|
| amber (pulsing) | working — a tool is running or a turn is in flight |
| green | idle — settled at the prompt |
| orange (pulsing) | awaiting a permission prompt |
| grey | starting — no hook traffic seen yet |
| red | ended (stale) — the PTY died but a registry tag survived it |

## How it works

A main-process **session registry** (`src/main/session-registry.ts`) joins the live PTY table with an *origin tag* written at every spawn path — `pty:spawn`/`resume`/`fork`, the hook server's `/spawn`, `runScheduledTask`, the pipeline orchestrator spawn (and its resume re-key), `spawn-agent`, and the observer's curator. Status comes from the hook server, which pushes each `working` / `idle` / `permission` transition into the registry as it fires.

The registry is **derived state**: pty-manager is the source of truth for liveness. A session with no recorded origin still appears, with its kind inferred from the spawn command, so a future spawn path that forgets to tag itself can never hide a live PTY. Conversely, an origin whose PTY has died is surfaced once as a red `zombie` row and then pruned — a leak is made visible rather than silently masquerading as a live session.

The renderer mirrors the registry via a `registry:changed` broadcast, and the panel additionally polls every 2 s while open, because uptime and zombie detection are computed on read rather than pushed.

## Gotchas & tips

- **Preview sessions are hidden by default.** Opening a finished pipeline node or a past scheduled run spawns a short-lived *ephemeral* PTY that the owning panel reaps on close. Those are UI machinery, not work you started, so they sit behind a "show N preview sessions" toggle in the header.
- The registry is **in-memory only**. Sessions do not survive an app restart, so neither does it — the pipeline and schedule stores own the durable records that outlive a run.
- Killing a scheduled run does not mark the run as errored immediately; the schedule's own PTY-exit handler reconciles it a moment later.
- `Cmd+P` is a panel like any other, so it participates in the mutually-exclusive panel handling — opening it closes `Cmd+J`/`Cmd+L`/notes, and `Esc` closes it.
