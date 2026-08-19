---
slug: session-branching
title: Session Branching
summary: Cmd+B forks the focused Claude session into a new one via --fork-session — both stay alive, and the branch opens beside the original in a split.
related: [split-view, session-persistence, hotkeys-settings, terminal-management, graph-view]
---

# Session Branching

## What it is

Branching forks the focused Claude session into a **new, independent session** that starts from a copy of the conversation so far. The original keeps running untouched; the branch continues from the same context in its own terminal. Use it to explore an alternative approach, ask a side question, or try a risky change without polluting (or losing) the original conversation.

Under the hood it runs `claude --resume <claude-session-id> --fork-session`: Claude Code copies the transcript into a **new** session id and resumes from the copy. Nothing is shared after the fork — the two sessions diverge from that point.

## How to use it

1. Focus a Claude session (focused view or a split pane).
2. Press `Cmd+B` (configurable — the `branchSession` hotkey in Settings → Keyboard shortcuts).
3. The branch appears beside the original (default) or on the graph, titled the same as the original.

The branch is a first-class session: it shows on the graph, gets live status, can be messaged, split-grouped, and resumed after a restart like any other session.

## Where the branch opens

Settings → **Session branching (⌘B)** → *Open branch in split view* (default **on**):

- **On** — the branch opens beside the original. If the original is already in a split group, the branch is appended to that group (avoiding group fragmentation); otherwise a new 2-pane group is created with focus kept on the original.
- **Off** — the branch sits on the graph as a background node; switch to it when ready.

If the original's split group is already full (9 panes), the branch still spawns but stays on the graph.

## When Cmd+B does nothing

Branching silently no-ops when there is nothing forkable:

- **Graph view** — no focused session to branch.
- **Raw shell terminals** — only Claude sessions have a conversation to fork.
- **Not yet resumable** — the session needs a Claude session id and at least one real conversation turn (a brand-new session still titled "Claude Code" can't be forked yet).

## Details & interactions

- **New session id.** `--fork-session` mints a fresh Claude session id that isn't known at spawn time — it arrives moments later via the SessionStart hook, the same way fresh spawns reconcile theirs. This is why the branch briefly has no resume id.
- **Title inheritance.** The branch copies the original's terminal title at fork time, so pairs read naturally on the graph; retitle either side afterwards.
- **Auto mode.** If Settings → Auto mode has *manual* sessions enabled, the branch spawns with `--permission-mode auto`.
- **Fully divergent.** Edits, memory writes, and messages in one branch do not appear in the other. Both write to the same project directory though — two branches editing the same files can conflict; use the agentic pipeline's worktrees when you need filesystem isolation.

## Gotchas & tips

- Branch **before** a risky instruction, not after — the fork copies the transcript as it stands.
- Branching an actively working session forks the transcript as of the last completed turn; for a clean fork, branch while the session is idle.
- The two sessions look identical right after the fork (same title, similar snapshot) — retitle one if you plan to keep both long-term.
- `Cmd+Shift+W` force-closes whichever branch loses.
