---
slug: session-persistence
title: Session Persistence & Restore
summary: Sessions are journaled continuously and offered for restore on next launch — surviving both clean quits and hard crashes; renderer crashes reconnect silently.
related: [terminal-management, split-view, hotkeys-settings, session-archiving-auto]
---

# Session Persistence & Restore

## What it is

Session Manager saves your resumable Claude sessions to disk and offers to restore them on the next launch. Restored sessions resume the *same Claude conversation* (`claude --resume <id>`) in their original project directory. Split-view groups are persisted alongside and reassembled from whichever members survive.

The session list is **journaled continuously while the app runs** (every ~15 seconds, plus immediately when a session gets its Claude id), not just at quit — so restore works after a hard crash too, losing at most ~15 seconds of session-list changes.

## How to use it

1. Resumable sessions are written to `sessions.json` (and groups to `split-groups.json`) under the app data directory (`~/Library/Application Support/session-manager/` on macOS) — continuously during the run and finally at quit.
2. On next launch, a **restore modal** lists the saved sessions; confirm to respawn them with `claude --resume`.
3. Optional: Settings → *Auto-mode on app restart for restored sessions* starts restored sessions in auto (permission-skipping) mode.

Nothing to configure beyond that — persistence is automatic.

## What counts as resumable

A session is saved only if all three hold:

- it has a **Claude session id** (assigned at spawn via `--session-id`, updated if you `/resume` inside the session),
- it saw **real user activity**,
- it has a **real terminal title** (not blank or the default "Claude Code").

Fresh sessions you never typed into, plain shells, and exited sessions are not saved.

## Crash recovery vs. restore

These are different paths:

- **Renderer crash** (GPU process dies): the window auto-reloads and silently reconnects to the still-running PTY processes. No modal, no conversation loss — the underlying processes never died.
- **Main-process crash** (whole app dies, e.g. a native-module fault): PTYs are gone, but the continuously-journaled `sessions.json` survives — the next launch shows the restore modal just like after a quit.
- **App quit / OS restart**: PTYs are gone; the restore modal respawns fresh PTYs that resume the saved Claude conversations.

## Use cases

- End the day mid-task, reopen tomorrow, and pick up every conversation where it left off.
- Survive an Electron GPU crash without losing 8 running sessions.
- Restore a split-view working set (group membership is saved; the layout is re-derived).

## Gotchas & tips

- **Pipeline and scheduled-task sessions are excluded** from the save — their resumability is managed by their own panels (run history / task tree), not the restore modal.
- The journal never overwrites a previous run's saved sessions with an empty list before this run has any resumable sessions of its own — so the pending restore prompt after a crash relaunch is safe.
- Restored sessions resume the *conversation*, not the terminal scrollback — the on-screen history starts fresh.
- A split group whose members were partially unsaveable restores as a smaller group (dropped members are simply omitted); a group reduced to one session dissolves into a single.
- Writes are atomic (temp file + rename), so a crash during save can't corrupt state files.
