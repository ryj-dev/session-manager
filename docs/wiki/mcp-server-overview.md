---
slug: mcp-server-overview
title: MCP Server Overview
summary: The session-manager stdio MCP server — how it's registered, and the full 39-tool surface grouped by area.
related: [memory-knowledge-base, todos-project-notes, spawned-sessions, agentic-pipeline, scheduled-tasks, hook-integration-status]
---

# MCP Server Overview

## What it is

Session Manager ships a stdio MCP server named `session-manager` that gives every Claude Code session access to the app's memory, todos, session management, pipeline, and scheduling. It is registered in `~/.claude.json` automatically on app start and unregistered on quit — any session on the machine (not just ones the app spawned) can call it.

## Architecture in one paragraph

The MCP server runs **out of process** (spawned per-session by Claude Code over stdio). Memory notes and todos it reads/writes directly on disk (shared app data dir, with a file watcher keeping the app UI live). Anything involving the *running app* — spawning, messaging, pipeline, schedules — goes over HTTP to the app's [hook server](hook-integration-status.md), using the port and per-launch secret files in the app data dir. If the app isn't running, those tools fail with "hook server is not running"; the disk-backed memory/todo tools keep working.

## Tool surface (39 tools)

**Memory knowledge base (10)** — `create-memory`, `read-memory`, `edit-memory`, `batch-section-edit`, `delete-memory`, `search-memories`, `list-memories`, `add-tags`, `remove-tags`, `repair-related`. See [memory-knowledge-base](memory-knowledge-base.md).

**Todos (6)** — `list-todos`, `read-todo`, `create-todo`, `update-todo`, `delete-todo`, `list-tags`. See [todos-project-notes](todos-project-notes.md).

**Session management (5)** — `spawn-session`, `spawn-agent`, `list-agents`, `list-sessions`, `send-message`. See [spawned-sessions](spawned-sessions.md), [agent-system](agent-system.md), [inter-session-messaging](inter-session-messaging.md).

**Agentic pipeline (10)** — `pipeline-start`, `pipeline-start-review`, `pipeline-get-task`, `pipeline-set-stage`, `emit-milestone`, `pipeline-rename-session`, `pipeline-request-approval`, `merge-worktree`, `pipeline-put-artifact`, `pipeline-get-artifact`. See [agentic-pipeline](agentic-pipeline.md).

**Scheduled tasks (8)** — `list-scheduled-tasks`, `get-scheduled-task`, `create-scheduled-task`, `update-scheduled-task`, `enable-scheduled-task`, `disable-scheduled-task`, `delete-scheduled-task`, `list-scheduled-task-runs`. See [scheduled-tasks](scheduled-tasks.md).

Tool names are invoked as `mcp__session-manager__<tool>` from a session.

## Identity: how tools know who's calling

Sessions spawned by the app carry an `APP_SESSION_ID` env var. The MCP server uses it to append parent context on `spawn-session`/`spawn-agent`, default the caller on `emit-milestone`, and stamp `fromSessionId` on `send-message`. Sessions started *outside* the app can still use memory/todo/schedule tools, but identity-dependent behaviors (parent linkage, messaging attribution) degrade gracefully.

## Gotchas & tips

- The opt-in **managed CLAUDE.md block** (Settings) documents the tool conventions for every session — install it if agents keep misusing tools.
- The MCP registration survives only while installed: Settings → *Cleanup & uninstall* removes it (and everything else) cleanly.
- The hook-server secret rotates each app launch; the MCP server re-reads it per call, so app restarts don't break long-lived sessions.
- Tool descriptions embed the usage rules (e.g. "never include your own session id in spawn prompts") — when in doubt, the description is authoritative.
