---
slug: graph-view
title: Graph View
summary: Force-directed star/hub graph of all running sessions grouped by project, with spawn trees for awaited children, keyboard navigation and momentum zoom.
related: [terminal-management, split-view, hotkeys-settings, session-persistence, sessions-overview]
---

# Graph View

## What it is

The graph view is the app's home screen: a live force-directed hub-and-spoke graph of every running session. Each unique project directory gets a colored **hub pill**; its sessions orbit it as **spoke thumbnails** showing live terminal snapshots. It replaces tab-switching with spatial navigation.

## How to use it

- **Return to graph** — `Cmd+W` from any focused session or split view.
- **Keyboard navigation** — `←`/`→` cycles sessions within the current project; `↑`/`↓` switches projects; `Enter` focuses the selected session; `Cmd+Shift+W` force-closes it.
- **Mouse** — click a node to focus it. Scroll to zoom (momentum-based, cursor-anchored). Drag empty space to pan.
- **Group sessions** — `Cmd+click` multiple nodes to select them for a split-view group; release Cmd (or hold still for 1.5 s to preview the layout first). See [split-view](split-view.md).
- **Spawn** — `Cmd+T` spawns a new Claude session (into the default projects directory when in graph view).

## Reading the graph

Session status is shown on each node's border and dot:

| Status | Visual |
|--------|--------|
| working | amber border + pulsing dot |
| permission (waiting for approval) | blue border + solid dot |
| finished (done, unseen) | green border + solid dot |
| seen / exited | neutral border, no dot |

Hub pills are colored per project (stable hash of the project path); the active hub glows. Statuses come from Claude Code hook events — see [hook-integration-status](hook-integration-status.md).

### Spawn trees

Most sessions hang off their project hub. A session spawned by another session **that is waiting on it** hangs off its spawner instead, joined by a **dashed edge** — so a research fan-out or a code-review child reads as a small tree rather than three unrelated nodes on the ring.

"Waiting on it" means the spawn used `reportBack: "true"` (report findings back) or `"done"` (ping when finished). Fire-and-forget spawns — `"optional"`, `"false"`, and anything you opened yourself — stay on the hub: nobody is blocked on them, and a handoff is a replacement for its parent rather than a subordinate of it.

Children are laid out radially outward inside their parent's slice of the ring, so a subtree never overlaps its neighbours and no dashed edge crosses back over the hub.

## Use cases

- Glance at 10+ parallel sessions and instantly spot which ones finished or are blocked on a permission prompt.
- Navigate whole projects with arrow keys without touching the mouse.
- Cmd+click a handful of related sessions into a split view for side-by-side monitoring.

## Gotchas & tips

- **Pipeline, scheduled-task, and attached (paired-shell) sessions never appear in the graph** — they're accessible only through their own panels (`Cmd+L`, `Cmd+J`) or overlays.
- Auto-fit keeps all nodes visible as sessions come and go, but is disabled once you manually zoom — zoom out yourself if things drift off-screen.
- **Project hubs stay where they settled.** Each hub is soft-anchored at its last position (persisted across reloads), so the layout is stable while you work. Only three things move a hub: (1) a cluster growing into a neighbour — clusters never overlap, the neighbour is pushed just far enough to clear and the view zooms out; (2) a **compaction** pass about a second after a project closes or a cluster shrinks a ring — hubs glide inward to re-fill the space while keeping their relative arrangement; (3) **Settings → Graph layout → Re-layout graph**, which forgets all positions and solves a fresh, dense layout (and returns you to the graph if you were inside a session).
- Fresh layouts are aspect-aware: the centring pull is weaker along the window's long axis, so a wide window gets a wide layout rather than a vertical column. One- and two-session projects use a tighter ring so they don't reserve a huge empty circle.
- **Closing a parent never strands its children.** Parentage is resolved every frame, so when a parent exits its children re-attach to the nearest still-live ancestor, or fall back to the hub if the whole chain is gone.
- **Spawn trees are capped at two levels** (children and grandchildren) — thumbnails are large, and a deeper tree costs more room than it explains. Anything deeper re-attaches to its deepest permitted ancestor rather than nesting further.
- **A child spawned into a different project stays on its own hub**, even when its parent is waiting on it. A cross-cluster edge would pull a node away from the hub whose footprint is meant to contain it.
- **Spawn linkage is in-memory** — it lives as long as the app runs. Sessions restored after an app restart come back as plain hub spokes.
- Split-view groups render as a single larger composite node tiling its members' snapshots; its members disappear as individual nodes while grouped. A group member's children re-attach above the group, since the member has no node of its own while grouped.
- While holding Cmd for group selection, pressing any other key cancels the selection (strict Cmd-hold detection) — release and re-press Cmd to start again.
