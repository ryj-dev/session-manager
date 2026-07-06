---
slug: file-explorer
title: File Explorer
summary: Keyboard-driven directory browser (Cmd+E) for navigating projects and spawning sessions into any directory.
related: [terminal-management, hotkeys-settings, graph-view]
---

# File Explorer

## What it is

A slide-in sidebar directory browser whose main job is *launching sessions in the right place*: navigate to any directory with the keyboard and spawn a Claude session (or shell) directly into it.

## How to use it

- **Open/close** — `Cmd+E`.
- **Navigate** — `↓`/`↑` to move the selection, `→` or `Enter` to enter a directory, `←` or `Backspace` to go up. Breadcrumb segments in the header jump anywhere in the path. Mouse clicks work too.
- **Spawn here** — press the spawn hotkey (`Cmd+T` by default) while the explorer is open to start a Claude session in the current directory (`Cmd+Shift+T` for a raw terminal).
- **Copy path** — `Cmd+Opt+C` copies the selected item's path (`Alt+Shift+C` on Windows).
- **Set default** — a footer button marks the current directory as the base projects directory (shows a checkmark when active).

## Behavior settings (Settings panel)

- **Default projects directory** (`baseProjectsDir`) — where the explorer starts and where graph-view spawns land.
- **Remember explorer location** (`persistExplorerPath`, default on) — reopen where you left off.
- **Default to active project directory** (`explorerFollowsProject`, default on) — opened from a focused session, the explorer starts at that session's project.
- **Color directories by project** (`colorExplorerByProject`) — tint entries with their project's graph color.

## Use cases

- Start a session in a repo you haven't opened this week without touching a terminal.
- Hop between sibling repos under your projects directory and spawn into each.
- Grab an absolute path to paste into a prompt.

## Gotchas & tips

- Dotfiles are hidden and directories sort above files.
- Reads are allowlisted to your home directory, `/tmp`, and `/var/folders` — the explorer won't browse system paths.
- `~` in paths is expanded to your home directory.
