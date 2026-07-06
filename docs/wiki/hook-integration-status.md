---
slug: hook-integration-status
title: Claude Code Hook Integration & Status Tracking
summary: A local hook server turns Claude Code hook events into live session status (working / permission / finished) and powers spawning, messaging, pipeline, and schedules.
related: [graph-view, inter-session-messaging, spawned-sessions, todos-project-notes, mcp-server-overview]
---

# Claude Code Hook Integration & Status Tracking

## What it is

On startup the app runs a local HTTP **hook server** (127.0.0.1, random port) and installs hooks into `~/.claude/settings.json` so every Claude Code session reports its lifecycle events back to the app. This is what drives the live status colors in the graph, completion detection for scheduled runs, and the ambient todo reminders. The same server is the HTTP backend for all session-management MCP tools.

## How it works (user-visible behavior)

Hook events map to session status shown in the UI:

| Hook event | Status shown |
|------------|--------------|
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | **working** (amber) |
| `Notification: permission_prompt` | **permission** (blue) — session is waiting for you |
| `Stop` (Claude finished responding) | **finished** (green) — becomes **seen** once you view/type |

Two extras ride on the hooks:

- **Ambient todo awareness** — the `UserPromptSubmit` hook is synchronous: when the count of open todos tagged with the session's project changes, the server injects a one-line system reminder ("You have N open todos tagged `project:x`…") into that turn. With Settings → *Nudge sessions about unfinished todos* enabled, a soft nudge is also injected at most every 8 turns.
- **Scheduled-run completion** — a `Stop` event from a scheduled-task session marks its run `done` and tears the PTY down (keeping the conversation resumable). See [scheduled-tasks](scheduled-tasks.md).

## Setup & teardown

- Hooks are installed automatically on app start and removed on quit; every installed entry carries a `session-manager-hook` marker so only the app's own hooks are touched.
- Hook commands are `curl` one-liners posting the event JSON to `http://127.0.0.1:<port>/hook?sid=$APP_SESSION_ID` (the env var is injected into every PTY the app spawns).
- The port and a per-launch shared secret are written to `hook-server.port` / `hook-server.secret` in the app data dir; the out-of-process MCP server reads both to call the server (requests without the `X-Hook-Secret` header are rejected).
- Settings → *Cleanup & uninstall* shows and removes each installed integration.

## HTTP surface (internals, for debugging)

`/hook` and `/hook-sync` (events), `/spawn` and `/spawn-agent` (session spawning), `/sessions`, `/message`, `/agents`, `/pipeline/*` (get-task, set-stage, emit-milestone, request-approval, merge-worktree, put/get-artifact, start, rename-session), `/schedules/*` (list, get, create, update, set-enabled, delete). MCP tools are thin wrappers over these endpoints because the MCP server runs as a separate process.

## Gotchas & tips

- Status tracking only works for sessions **spawned by the app** (they need `APP_SESSION_ID`); an external terminal running Claude won't appear.
- Requires a recent Claude Code (hooks + monitor support, ~2.1.113+); if statuses stop updating after a Claude Code upgrade, restart the app so hooks reinstall against the new version.
- The hook secret rotates on every app launch; long-lived sessions spanning an app restart pick up the new secret automatically.
- "Finished" vs "seen": if you're already viewing a session when it finishes, it goes straight to seen — the green cue is only for sessions you weren't watching.
