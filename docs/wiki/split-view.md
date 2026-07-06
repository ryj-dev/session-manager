---
slug: split-view
title: Split-View Groups
summary: Group 2–9 sessions into one tiled view with an i3-style N-ary layout, live reshape preview, and keyboard slot navigation.
related: [graph-view, terminal-management, session-persistence, hotkeys-settings]
---

# Split-View Groups

## What it is

Split view groups 2–9 sessions into a single composite screen showing all their terminals at once. Layouts are an i3-style N-ary tree: any nesting of rows and columns with adjustable weights — not a fixed grid. Groups persist across restarts and render in the graph as a single composite node tiling its members' snapshots.

## How to create a group

1. In the **graph view**, hold `Cmd` and click 2+ session nodes (click again to deselect; max 9).
2. Either **release Cmd** to open the group with a default layout, or **hold Cmd still for 1.5 s** to pop up the live reshape preview modal first — arrange, then release Cmd to open.
3. A single Cmd+click + release just focuses that session.

## Reshaping

Hold `Cmd` still for 1.5 s **while inside a split** to reopen the preview modal seeded with the current arrangement (releasing Cmd applies it):

- **Drag a tile** to another region to rearrange.
- **Drag a divider** to resize; dividers snap to aligned edges (snap targets highlight).
- **Shift+drag a divider** to move all aligned dividers together.
- **Add sessions to an existing group**: the modal header shows a small clickable **+ button** (mouse only — not a keyboard shortcut; `Cmd`+`+` is zoom). While still holding Cmd, click it to jump back to the graph, `Cmd+click` the extra sessions, then release Cmd to append them to the group.

Minimum pane weight is 8% of the axis, so nothing can be squeezed invisible.

## Inside a split

- **Focus**: click a pane, `Cmd+1..9` jumps to slot N, `Cmd+]` / `Cmd+[` cycles next/previous.
- **Borders**: outer ring = status color (working amber / permission blue / finished green); inner ring = focus. Both visible independently.
- A focused pane that turns *finished* keeps its green cue until you actually click or type in it — so you don't miss completions while staring at another pane.
- `Cmd+W` returns to the graph. `Esc` is a no-op (it belongs to the terminals).
- Settings → *Spawn new sessions into current split* makes `Cmd+T` add the new session to the active group instead of the graph.

## Graph representation & persistence

- The group appears as one larger node whose thumbnail mirrors the actual tiling, with per-member status borders; members vanish as individual nodes.
- Cmd+click a composite node in the graph to dissolve it back into singles.
- Groups are saved to `split-groups.json` and restored with the sessions they contain; members that weren't resumable are dropped, and a group reduced to one session dissolves.

## Use cases

- Watch an implementation session and its paired shell (test runner) side by side.
- Monitor 4 parallel investigation sessions in a 2×2 without graph round-trips.
- Keep a "mission control" group of long-running sessions across restarts.

## Gotchas & tips

- Only Claude/PTY sessions can join a group (not app panels).
- While holding Cmd, pressing any non-Cmd key cancels the pending selection — deliberate, to avoid accidental modals while using Cmd-hotkeys.
- If a session in a group exits, the layout reflows automatically to fit the remaining members.
