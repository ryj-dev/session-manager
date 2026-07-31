---
slug: graph-view
title: Graph View
summary: Force-directed star/hub graph of all running sessions grouped by project, with keyboard navigation and momentum zoom.
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

## Use cases

- Glance at 10+ parallel sessions and instantly spot which ones finished or are blocked on a permission prompt.
- Navigate whole projects with arrow keys without touching the mouse.
- Cmd+click a handful of related sessions into a split view for side-by-side monitoring.

## Gotchas & tips

- **Pipeline, scheduled-task, and attached (paired-shell) sessions never appear in the graph** — they're accessible only through their own panels (`Cmd+L`, `Cmd+J`) or overlays.
- Auto-fit keeps all nodes visible as sessions come and go, but is disabled once you manually zoom — zoom out yourself if things drift off-screen.
- Split-view groups render as a single larger composite node tiling its members' snapshots; its members disappear as individual nodes while grouped.
- While holding Cmd for group selection, pressing any other key cancels the selection (strict Cmd-hold detection) — release and re-press Cmd to start again.
