---
slug: agentic-pipeline
title: Agentic Pipeline
summary: Cmd+L hands a todo to an autonomous orchestrator that plans → implements → review-loops it, fanning out into isolated git worktrees.
related: [todos-project-notes, spawned-sessions, scheduled-tasks, mcp-server-overview]
---

# Agentic Pipeline

## What it is

The pipeline (`Cmd+L`) turns an open todo into an autonomously executed task. A dedicated **orchestrator session** drives it through a board — Backlog → Plan → Implement → Review → Done — spawning worker sessions per stage, fanning parallel workers out into **isolated git worktrees**, running a multi-dimension review loop, and merging results back. You choose how much it asks: full auto, gated, or manual approval at every hand-off.

## How to use it

1. Write the task as a todo (its body is the brief) tagged with the project.
2. `Cmd+L` opens the board; the **Backlog column is your open todos**. A project filter in the header auto-targets the current session's project when opened from inside a session.
3. Start a task, pick autonomy: **auto** (runs unattended), **gated** (pauses at key gates), **manual** (pauses at every hand-off). The default lives in Settings → *Agentic pipeline* (initially `gated`).
4. Watch the milestone feed per session on the task card; approve gates when banners appear; open any node's terminal (live if running, read-only transcript once merged/finished).
5. When the task lands in Done, the backing todo is marked done and its sessions are torn down (kept resumable).

## Worktree fan-out

Parallel implement workers are spawned with `isolate: true`, giving each its own git branch (`pipeline/<taskShort>/<label>`) and worktree in a sibling directory (`../.pipeline-worktrees/…`) so they can't clobber each other. When a worker finishes, the orchestrator calls `merge-worktree`: the branch merges `--no-ff` into the integration branch, the worktree is removed, and the node becomes read-only. On a merge **conflict**, the worktree and session are kept so a fix worker can resolve and retry. Non-git projects fall back to the shared directory with a warning.

## Review loop

Reviews fan out per relevant *dimension* — correctness/logic, bugs/runtime safety, security, architecture, tests, performance — each reviewer scoped to the actual change, skipping irrelevant dimensions, re-running only failed ones per round.

## MCP tools

| Tool | Who calls it | Purpose |
|------|--------------|---------|
| `pipeline-start` | anyone | Launch a backlog todo into the pipeline (same as the UI button); no-op if already running |
| `pipeline-start-review` | anyone | Send **existing work** straight to the review⇄fix loop — `diffSource: {kind:'working-tree'}` (default) or `{kind:'range', base, target}`; the todo body is the rubric |
| `pipeline-get-task` | orchestrator/workers | Read stage, autonomy, gates, session tree |
| `pipeline-set-stage` | orchestrator | Advance the board |
| `pipeline-request-approval` | orchestrator | Gate: auto-approves under `auto`, otherwise waits for the user |
| `emit-milestone` | any pipeline session | One-line feed entries with status/badge/tone |
| `pipeline-rename-session` | orchestrator | Descriptive node labels on the board |
| `pipeline-put-artifact` / `pipeline-get-artifact` | stages | Hand off large content (plan/diff/review) out-of-band |
| `merge-worktree` | orchestrator | Merge + retire a finished worktree worker |

`spawn-session` gains pipeline params here: `pipelineTaskId`, `pipelineRole` (orchestrator/plan/implement/review), `pipelineLabel`, `fanoutKind`, `worktreeBranch`, `isolate`, and `modelId` (typical tiering: plan/implement → opus, research probes → haiku, review → sonnet).

## Use cases

- Queue up several well-specified todos and run them through `auto` overnight-style, reviewing the merged branches later.
- `pipeline-start-review` on your own uncommitted changes to get a structured multi-dimension review with fix loops.
- `gated` autonomy for risky work: the orchestrator plans, you approve, it implements.

## Gotchas & tips

- **Pipeline sessions never appear in the graph** and are excluded from quit-save/restore; the board is their home. Task state persists in `pipeline.json`, so the board (and read-only transcripts) survive restarts.
- Quality in = quality out: the todo body is the entire brief. Vague todos produce vague plans.
- The orchestrator itself has coordination-only tools (no Write/Edit/Bash) — all real work happens in its spawned workers.
- Under `gated`/`manual`, a pending gate leaves the orchestrator waiting for a message — resolve gates from the UI banner rather than assuming it timed out.
- Requires git ≥ 2.5 for worktrees; a per-repo mutex serializes merges so parallel workers can't race.
