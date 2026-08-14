# Session Manager Wiki

Curated, app-versioned feature documentation. One article per feature; each has frontmatter (`slug`, `title`, `summary`, `related`) for listing and search. These articles are the authoritative "how does this work / how do I use it" reference, served to agents via the wiki MCP tools.

## Index

- `terminal-management` — PTY-backed multi-session terminals: spawn, live snapshots, resume, crash recovery.
- `graph-view` — Force-directed star/hub graph of all sessions with keyboard nav, momentum zoom, and status colors.
- `session-persistence` — Save on quit, restore modal on launch, `claude --resume`, silent crash reconnection.
- `hook-integration-status` — Hook server: Claude Code hook events → live working/permission/finished status, ambient todo reminders, HTTP surface.
- `inter-session-messaging` — `send-message` with instant monitor-plugin inbox delivery, popups, and long-message file handoff.
- `spawned-sessions` — `spawn-session` MCP tool: reportBack modes, allowedTools, context rules, CLI-arg prompt delivery.
- `agent-system` — `spawn-agent`/`list-agents`: bundled specialist agents with hard tool restrictions.
- `split-view` — Group 2–9 sessions into an i3-style N-ary tiled layout with live reshape preview and slot hotkeys.
- `memory-knowledge-base` — Markdown knowledge notes with wikilinks/backlinks, typed sections, hybrid semantic search, Sigma.js graph (Cmd+M).
- `todos-project-notes` — Global hybrid todo+note list with `project:` tags, hybrid search, MCP CRUD, ambient in-session reminders.
- `skills-system` — Inject slash-command skills (brainstorming, frontend-slides, regression-loop) into new or running sessions (Cmd+S).
- `design-gallery` — ~60 brand design-system previews in light/dark, served via the design:// protocol (Cmd+D).
- `file-explorer` — Keyboard-driven directory browser (Cmd+E) with path persistence and spawn-into-directory.
- `sessions-overview` — Cmd+P: every live session grouped by owner (graph / pipeline / scheduled / agents / observer), with status, uptime, parent linkage and kill.
- `observer-agent` — Background observer: usage capture, deterministic pattern mining, a ~daily Haiku curator, and the insights inbox you accept or dismiss from.
- `agentic-pipeline` — Cmd+L: todo → orchestrator → plan/implement/review loop, worktree fan-out, autonomy levels, milestones, pipeline MCP tools.
- `scheduled-tasks` — Cmd+J: launch/first-of-day/interval/daily triggers, per-day caps, resumable run history, login-failure retry, model picker.
- `canvas` — Per-session visual surface: agents answer with sortable tables, markdown reports, and annotated screenshots (canvas-show); user-sent images auto-display at send time.
- `hotkeys-settings` — All 14 configurable Cmd-hotkeys with defaults, plus every Settings panel option including cleanup/uninstall.
- `mcp-server-overview` — How the stdio MCP server registers, its architecture, and the full 39-tool surface grouped by area.
