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
- **Nothing moves unless it has to.** The graph is meant to be navigable from memory — "that session is over on the right" — so a hub keeps the position it already has. Where each project sits is remembered across spawns, closes and app restarts, and is only recomputed for a project that is genuinely new to the graph.
- **Hub positions are computed, not simulated.** Clusters are packed nearest-the-middle-first and never overlap; the pack region follows the window's shape, so a wide window fills sideways and a tall one downward. There is no annealing and no accumulated state, so the layout can't drift as you work.
- **A new project takes the next free slot** rather than displacing the ones already on the graph, because packing order is first-seen (and persisted).
- **Growing a project usually costs its neighbours nothing.** Clusters are packed with a generous gap, and a neighbouring project can expand into that slack without pushing anyone. Only when a cluster gains a whole new ring — enough that the gap would become too tight to read as two groups — does the hub beside it give way, and it is nudged straight outward from where it was rather than repacked from scratch. Closing sessions never moves anything.
- Auto-fit frames the graph when you open it, and afterwards only steps in when something has actually left the screen — a spawn that lands in view leaves your framing untouched. It is disabled entirely once you manually zoom, so zoom out yourself if things fall off-screen.
- **Settings → Graph layout → Re-layout** forgets both the remembered positions and which project arrived when, and repacks everything in canonical, densest order. It's a tidy-up, not a repair: nothing accumulates that needs repairing (and it returns you to the graph if you were inside a session).
- A cluster's footprint is its real bounding box — pill plus thumbnails — not a circle around the hub. A project with one session reserves the room its pill and thumbnail actually occupy, so a screenful of single-session projects packs onto one screen.
- **Closing a parent never strands its children.** Parentage is resolved every frame, so when a parent exits its children re-attach to the nearest still-live ancestor, or fall back to the hub if the whole chain is gone.
- **Spawn trees are capped at two levels** (children and grandchildren) — thumbnails are large, and a deeper tree costs more room than it explains. Anything deeper re-attaches to its deepest permitted ancestor rather than nesting further.
- **A child spawned into a different project stays on its own hub**, even when its parent is waiting on it. A cross-cluster edge would pull a node away from the hub whose footprint is meant to contain it.
- **Spawn linkage is in-memory** — it lives as long as the app runs. Sessions restored after an app restart come back as plain hub spokes.
- Split-view groups render as a single larger composite node tiling its members' snapshots; its members disappear as individual nodes while grouped. A group spanning projects floats between its hubs; a same-project group sits just outside its hub's ring. Either way the composite is kept clear of session thumbnails, hub pills, and other composites — it is the composite that moves out of the way, never the sessions. A group member's children re-attach above the group, since the member has no node of its own while grouped.
- While holding Cmd for group selection, pressing any other key cancels the selection (strict Cmd-hold detection) — release and re-press Cmd to start again.
