---
slug: hotkeys-settings
title: Hotkeys & Settings
summary: All 18 configurable Cmd-hotkeys with defaults, plus the full Settings panel — spawn behavior, pairing, popups, autonomy, cleanup.
related: [graph-view, file-explorer, split-view, hook-integration-status, sessions-overview]
---

# Hotkeys & Settings

## Hotkeys

All bindings use the Cmd modifier on macOS (Alt on Windows) and are configurable via **Settings → Keyboard shortcuts**. Defaults:

| Action | Default | Opens / does |
|--------|---------|--------------|
| spawnSession | `Cmd+T` | New Claude session |
| spawnTerminal | `Cmd+Shift+T` | New raw terminal |
| returnToGraph | `Cmd+W` | Back to graph view |
| toggleExplorer | `Cmd+E` | File explorer |
| toggleAgents | `Cmd+A` | Agents gallery |
| toggleSkills | `Cmd+S` | Skills gallery |
| toggleDesign | `Cmd+D` | Design systems gallery |
| toggleMemory | `Cmd+M` | Memory knowledge graph |
| toggleNotesProject | `Cmd+N` | Todos/notes, scoped to current project |
| toggleNotesGlobal | `Cmd+Shift+N` | Todos/notes, global view |
| togglePipeline | `Cmd+L` | Agentic pipeline board |
| toggleScheduled | `Cmd+J` | Scheduled tasks panel |
| openOverview | `Cmd+P` | Sessions overview — every live session, grouped by owner |
| toggleCanvas | `Cmd+K` | Canvas dock for the focused session |
| shareTurn | `Cmd+Shift+S` | Share Turn modal for the focused session |
| branchSession | `Cmd+B` | Branch (fork) the focused session — both stay alive |
| openSettings | `Cmd+O` | Settings modal |
| copyFilePath | `Cmd+Opt+C` (mac) / `Alt+Shift+C` (win) | Copy selected explorer path |

**Hardcoded** (not configurable): `Cmd+Shift+W` force-close selected session; arrow keys + `Enter` for graph navigation; `Cmd+1..9` and `Cmd+]`/`Cmd+[` for split-view slot focus; Cmd+click / Cmd-hold for split grouping. Bindings use physical-key mapping, so `Opt`-combos work regardless of the character they'd type.

## Settings panel (`Cmd+O`)

- **Default projects directory** — base dir for the explorer and graph-view spawns.
- **Spawn behavior** — *Auto-focus new sessions* (default on); *Spawn new sessions into current split*.
- **Explorer** — *Remember explorer location*, *Default to active project directory*, *Color directories by project*.
- **Terminal pairing** — pair each new Claude session with a shell: off / split / hover overlay.
- **Session branching (⌘B)** — *Open branch in split view* (default on): the fork opens beside the original, extending the original's split group if it already has one; when off the fork sits on the graph as a background node.
- **Auto mode** — start *child* sessions (spawned by other sessions), *manual* sessions, and/or *restored* sessions in permission-auto mode (all default off).
- **Message popup** — manual dismiss / auto-dismiss after N seconds (default 15) / disabled.
- **Todo nudges** — *Nudge sessions about unfinished todos* (ambient reminder, default off); *Completed items* window (day/week/month/all).
- **Agentic pipeline** — default autonomy: manual / gated (default) / autonomous.
- **Keyboard shortcuts** — the rebinding modal.
- **Statusline** — opt-in managed Claude Code statusline (script + config under `~/.claude/`).
- **CLAUDE.md block** — opt-in managed block in `~/.claude/CLAUDE.md` teaching sessions how to use the MCP server (marker-bracketed, cleanly removable; previewable before install).
- **Cleanup & uninstall** — every integration (MCP registration, hooks, plugin, statusline, CLAUDE.md block, memory store, embeddings, notes, saved sessions, settings) with on-disk sizes and one-click removal; each can also be disabled without deleting data.

Settings persist to `state/settings.json` in the app data directory.

## Gotchas & tips

- Browsing the Keyboard shortcuts panel is the fastest tour of everything the app can do.
- Hotkey customizations merge with defaults per-key — new hotkeys added by app updates get their defaults automatically.
- The Cmd-hold split-grouping gesture means any configured hotkey still works while selecting — but any non-Cmd keypress cancels a pending group selection.
