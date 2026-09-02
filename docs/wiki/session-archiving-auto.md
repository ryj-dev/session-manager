---
slug: session-archiving-auto
title: Session Archiving (Inactive Sessions)
summary: "Opt-in: after N minutes of inactivity a session's process is torn down while its graph node, snapshot and conversation are kept — clicking the node (or messaging it) silently resumes it."
related: [session-persistence, terminal-management, inter-session-messaging, hook-integration-status, graph-view]
---

# Session Archiving (Inactive Sessions)

## What it is

Every idle session on the graph is a live `claude` process plus a renderer WebGL terminal context. Session archiving reclaims both: after a configurable period of inactivity, the app tears down the session's PTY while **keeping its graph node, last snapshot and Claude conversation id**. The node stays on the graph, dimmed with a frozen thumbnail. Entering the session — or a message arriving for it — silently resumes the conversation via `claude --resume` under the **same app session id**, so the terminal, inbox path and parent/child message routes all reconnect. Scheduled-task teardown-but-resumable is the same pattern applied to graph sessions.

Off by default. Enable it in **Settings (Cmd+O) → Session archiving**, and set the inactivity threshold in minutes (minimum 5, default 30).

## How to use it

1. Turn on **Archive inactive sessions** in Settings and pick a threshold.
2. Idle sessions archive automatically once every gate passes (see below). The node dims, its snapshot freezes, and the status dot goes grey.
3. Click the node (or otherwise enter the session — split view included) to resume. A cyan **"Waking session…"** indicator shows while `claude --resume` starts; the resumed CLI repaints the conversation transcript itself. Keystrokes during the wake are **blocked, not buffered** — nothing you type mid-wake reaches the prompt garbled.
4. To exempt a long-watch session (something you keep open deliberately), open it and click the **pin** icon in the titlebar. Pinned sessions never archive. Pins are per-session and in-memory (they reset on app restart).

### Messages to archived sessions

Nothing special is required by senders. All delivery routes through the hook server's `/message` path: if the target is archived, the message is **queued server-side**, the session is auto-resumed, and the queue flushes into the normal inbox delivery once the session is ready (first hook event or the prompt appearing on screen, with a 15-second fallback). A child session reporting back to an archived parent therefore wakes the parent and lands normally. Messages are queued rather than pre-written because the inbox file's tail monitor starts at end-of-file — a line appended before the resumed monitor is running would be silently lost.

`list-sessions` (MCP) keeps returning archived sessions, flagged with status `archived` — they remain valid message targets.

### What archives (eligibility)

Same bar as session persistence: a `claude` session with a conversation id and real user activity. Pipeline, scheduled, observer, preview/drawer and plain-shell sessions are excluded — they have their own lifecycles. Pinned sessions and sessions currently on screen (focused, or a member of the active split) are never archived out from under you.

## How it works

A sweep runs every 30 seconds in the main process. A session archives only when **all four gates** pass, cheapest first:

1. **The session is not mid-turn.** Claude Code maintains its own state file per running process at `~/.claude/sessions/<pid>.json`, with a status of `busy`, `shell`, `idle` or `waiting`; the sweep reads it (checking the recorded `sessionId` so a recycled PID can't be mistaken for the session). `busy` and `waiting` block. `idle` and `shell` pass — `shell` means a background shell is attached, and the app's own message-bus monitor is one, so every session this app spawns sits at `shell` permanently; gate 3 is what tells that monitor apart from real shell work. If the file can't be read (older CLI, not written yet), the sweep falls back to our own hook-derived status, which must be `idle`.
2. **Quiet for the threshold.** No PTY input, no `working` hook events, and near-zero PTY output since — a small byte-per-sweep noise floor absorbs terminal-title/statusline chatter, while real output (a dev server logging, a background task printing) resets the clock.
3. **No live workload descendants.** A `ps` scan of the claude process's children: Claude Code's Bash-tool wrappers (identifiable by the `.claude/shell-snapshots/` argv marker, or any plain shell spawned directly by claude) and everything under them **block** archiving — that's where `run_in_background` tasks and dev servers live. The app's own message-bus monitor (`tail -f …/messages/<session>/inbox.txt`) is allowlisted. Non-shell direct children (stdio MCP servers, which live for the whole session) are ignored, including any transient shells they spawn internally.
4. **No pending background work.** Harness-timer tools (ScheduleWakeup, Monitor, RemoteTrigger, Workflow) end the turn but have the runtime re-invoke the session later, leaving nothing any other gate can see. The hook server flags these from PostToolUse and the flag blocks archiving until the next user prompt clears it. The list is deliberately short: the flag has no expiry, so a tool that lands on it makes the session unarchivable until you type into it again. Background `Agent`/`Task` calls are **not** on it — a background subagent runs in-process and the CLI reports the session as `busy` for the whole run, so gate 1 already covers it — and neither is backgrounded `Bash` (gate 3 sees the shell) or `TaskCreate` (the todo-list tool, which re-invokes nothing).

When a signal is ambiguous (e.g. the `ps` scan fails), the sweep blocks — a false "active" only delays archiving.

On archive, the main process broadcasts `session:archived`, kills the PTY, and records `{ claudeSessionId, projectPath, title }`. The renderer marks the node `archived`, keeps the frozen snapshot, and disposes the xterm instance (freeing its WebGL context). On resume, a fresh PTY is spawned with `claude --resume <id>` under the original app session id; the serialized terminal buffer is deliberately **not** replayed — the resumed CLI repaints the transcript, so replaying would duplicate it. Only non-transcript scrollback (pre-Claude shell output, old TUI frames) is lost.

Archived sessions are merged into the on-quit session save, so quitting with archived sessions still offers them in the next launch's restore prompt. They also survive renderer reloads (e.g. GPU-process death on screen lock): the crash-recovery reconnect reads `archive:list` alongside `pty:listActive` and re-adds archived nodes as frozen `archived` sessions.

## Gotchas

- **Daemonized processes escape gate 3.** A process that double-forks/daemonizes reparents to launchd and leaves the claude process tree entirely, so the scan cannot see it. If a session babysits such a process, **pin the session**.
- **Windows:** the process scan uses `ps`, which doesn't exist on Windows — gate 3 is always ambiguous there, so nothing archives (the feature is effectively macOS/Linux for now).
- **Pins don't persist** across app restarts (a restart respawns sessions anyway, resetting the inactivity clock).
- **Resume permission mode** follows the *Auto-mode on app restart for restored sessions* setting, not whatever flags the session originally ran with.
- **Why isn't this session archiving?** The sweep logs the blocking reason per session to the main-process console (`[archiver] <id> not archived — …`), and only reprints when the reason changes rather than every 30 seconds. That log names the gate, which is the fastest way to tell a live dev server (gate 3) from a session the CLI still considers busy (gate 1).
- If the conversation transcript was deleted, the resume spawn exits immediately and the node is removed like a normal exit — the archive record can't validate the transcript up front.
