---
slug: terminal-management
title: Multi-Session Terminal Management
summary: PTY-backed terminals for many Claude Code sessions at once — spawn, live snapshots, resume, and crash recovery.
related: [graph-view, session-persistence, hook-integration-status, split-view, hotkeys-settings]
---

# Multi-Session Terminal Management

## What it is

Session Manager runs each Claude Code session (or plain shell) in its own real PTY process, rendered with xterm.js + WebGL. You can run many sessions in parallel across different project directories, see live thumbnail snapshots of each in the graph view, and survive both app restarts and renderer crashes without losing sessions.

## How to use it

- **Spawn a Claude session** — `Cmd+T` (configurable). From the graph view it spawns in the default projects directory; from the file explorer it spawns in the currently-open directory; from a focused session it uses that session's project.
- **Spawn a raw terminal** — `Cmd+Shift+T`.
- **Focus a session** — click its node in the graph (or `Enter` on the keyboard-selected node). `Cmd+W` returns to the graph.
- **Close a session** — `Cmd+Shift+W` force-closes the selected/focused session (hardcoded, not configurable).
- **Terminal pairing** — Settings → *Terminal pairing* can auto-open a shell alongside each new Claude session: `off` (default), `split` (2-pane split view), or `overlay` (hidden right-edge hover sidebar).

Sessions can also be spawned programmatically by other sessions via the `spawn-session` MCP tool (see [spawned-sessions](spawned-sessions.md)).

## Key behaviors

- **Session identity** — every PTY gets an `APP_SESSION_ID` env var (used by hooks and MCP tools to identify the session) and a `SESSION_MANAGER_INBOX` env var (used by the messaging monitor). Claude sessions are started with a pre-assigned `--session-id`, so the conversation is resumable from the very first turn.
- **Live snapshots** — the WebGL canvas is captured on an adaptive interval (~500 ms while active, ~3 s when idle) at 3× scale, so graph thumbnails stay sharp and current.
- **Resume** — a saved session restarts with `claude --resume <claudeSessionId>` in its original project directory. A session is considered resumable only if it has a Claude session id, saw real user activity, and has a real terminal title.
- **Crash recovery** — if the renderer (GPU process) dies, the window reloads and silently reconnects to all still-running PTYs; no sessions are lost and no restore prompt is shown.

## Use cases

- Run separate Claude sessions per repo/feature and monitor them all from one graph.
- Keep a long-running session alive across an app restart and resume the conversation.
- Pair every Claude session with a shell for manual git/test commands (`terminal pairing: split`).

## Gotchas & tips

- Only sessions meeting the resumability criteria are saved on quit — an untouched, just-spawned session won't be offered for restore.
- Prompts delivered to a *new* session go in as a CLI argument, not typed into the TUI, so there are no paste-timing issues; messages to a *running* session go through the inbox/monitor path instead (see [inter-session-messaging](inter-session-messaging.md)).
- Off-screen terminals still render at full size (min 80×24) behind the UI so snapshots and TUI layout stay correct.
- Pipeline and scheduled-task sessions are real PTYs too, but are deliberately excluded from the graph and from the hidden snapshot terminals (WebGL contexts are finite — too many would black-screen the visible terminal).
