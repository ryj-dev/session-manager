# Session Manager

A desktop app for managing many [Claude Code](https://claude.com/claude-code) sessions at once — spawn them from a file explorer, see them as a force-directed graph, group them in split views, message between them, and keep persistent project memory + todos alongside.

## Requirements

- **macOS (Apple Silicon)** for the prebuilt release. Intel macs work from source. **Windows is supported but rough around the edges** — you can build and run it from source today (the main loop, terminals, hooks, and MCP all work), but expect some bugs: hotkeys may not register correctly, a few path/keybinding assumptions are Mac-first, and some integrations haven't been polished for Windows yet. Fixes are welcome, and broader Windows support is on the roadmap.
- **Claude Code, recent version.** Session Manager relies on Claude Code's `monitor` feature for live status, which landed around `2.1.113`. To be safe, run a current build — confirmed stable on `2.1.140` and newer (latest at time of writing: `2.1.163`). Check with `claude --version` and update via `npm i -g @anthropic-ai/claude-code` (or however you installed it) if you're behind.
- **Node 20+** if running from source.
- **git ≥ 2.5** for the agentic pipeline's worktree-based parallel fan-out (the version that introduced `git worktree`). Any modern git works. Tasks in non-git project directories still run — they just fall back to the shared working tree without worktree isolation.

## Running it

### Option A — Homebrew (macOS arm64)

```sh
brew tap ryj-dev/tap
brew trust ryj-dev/tap    # Homebrew ≥ 6 requires trusting third-party taps
brew install --cask session-manager
```

The app is unsigned, so macOS would normally block it as "damaged" on first launch — the cask removes the quarantine flag automatically after install, so it launches normally.

### Option B — download a release (macOS arm64)

1. Grab the latest DMG from the [releases page](https://github.com/ryj-dev/session-manager/releases).
2. Open the DMG, drag *Session Manager* to Applications.
3. **The build is unsigned**, so on first launch macOS will report the app "is damaged and can't be opened" — it isn't damaged, it's quarantined. Clear the quarantine flag and it launches normally:

   ```sh
   xattr -cr "/Applications/Session Manager.app"
   ```

   (Alternatively, download with `curl -L` instead of the browser — quarantine is only applied to browser downloads.)

### Option C — run from source

```sh
git clone https://github.com/ryj-dev/session-manager.git
cd session-manager
npm install
npm run dev
```

To build your own distributable:

```sh
npm run dist:mac     # produces release/Session Manager-<ver>-arm64.dmg
```

## What it sets up on first launch

Session Manager integrates with your local Claude Code install. On startup it will:

- **Register an MCP server** named `session-manager` in `~/.claude.json` so sessions can talk to its memory, todo, session-spawning, pipeline, and scheduling tools.
- **Install hooks** in `~/.claude/settings.json` so Claude Code reports session status, stop events, and inter-session messages back to the app's hook server.
- **Install a local plugin marketplace + plugin** named `session-manager-local` so the bundled agents and skills are available as slash commands in any session.

Two further integrations are **opt-in** — they aren't installed automatically, you turn them on from **Settings**:

- **Managed statusline** (script + config under `~/.claude/`) showing project + session info.
- **Managed CLAUDE.md block** appended to `~/.claude/CLAUDE.md`, describing how sessions should use the MCP server. It's bracketed by markers and can be cleanly removed.
- **Create app data** under `~/Library/Application Support/session-manager/`:
  - `memories/` — markdown memory knowledge base
  - `notes/todos/` — todos and project notes
  - `memory-embeddings.db` — local semantic search index (sqlite-vec)
  - `models/bge-small-en-v1.5/` — cached embedding model
  - `sessions.json`, `messages/`, `split-groups.json`, `embed.sock` — session state
  - `plugin/`, `state/settings.json` — plugin scaffold and app preferences

All of this is reversible. Open **Settings → Cleanup & uninstall** to see exactly what's installed, its on-disk size, and one-click buttons to remove each piece (MCP registration, hooks, statusline, CLAUDE.md block, plugin, memory store, embeddings, notes, saved sessions, app settings). Each integration can also be disabled independently without deleting its data.

## Feature overview

- **Graph view** — a live force-directed star/hub graph of every running session, with momentum zoom, keyboard nav, and persistent layout.
- **Terminal management** — full PTY-backed terminals with xterm WebGL, snapshot restore across restarts, and crash recovery.
- **File explorer** — browse any directory and spawn a Claude session (or shell) into it; optional project-based colors.
- **Split-view groups** — combine multiple sessions into an N-ary layout (any nesting of rows/columns); reshape them live in a preview modal.
- **Memory knowledge graph** — markdown notes with `[[wikilinks]]`, backlinks, a Sigma.js graph view, and semantic search via local embeddings.
- **Todos / project notes** — a global hybrid todo + note system, tagged by project, shared between you and any agent.
- **Inter-session messaging** — sessions can `send-message` to each other and spawn child sessions; the app routes delivery and shows queued messages.
- **Agentic pipeline** (Cmd+L) — hand a todo to an autonomous orchestrator session that plans, implements, and runs a multi-dimension review loop, fanning work out into isolated git worktrees and merging the results back. Pick an autonomy level (auto, gated, or manual approval gates) and watch progress as a milestone feed. Orchestrator and worker sessions run as real terminals but stay out of the graph.
- **Scheduled tasks** (Cmd+J) — fire a saved prompt into a fresh session in a chosen directory on a trigger: app launch, first launch of the day, every N minutes/hours, or daily at a set time, with an optional per-day run cap. Schedules only fire while the app is open; each run is kept as resumable history so you can pick up the conversation later.
- **Agents, skills, and design gallery** — 4 bundled agents, 2 skills, and 60+ design system references browsable in a gallery and injectable into any session.
- **Hook server** — local HTTP server bridging Claude Code's hook events into the app for status updates and routing.

## Hotkeys and settings

All keyboard shortcuts are configurable. Open **Settings → Keyboard shortcuts** for the full list of capabilities and their default bindings (Cmd+T to spawn, Cmd+W to return to the graph, Cmd+M for memory, Cmd+E for the file explorer, Cmd+L for the agentic pipeline, Cmd+J for scheduled tasks, Cmd+O for settings, and so on). Browsing that panel is the fastest way to discover what the app can do.

Other settings worth knowing about live in the same panel: base projects directory, terminal pairing mode (off / split / overlay shell alongside Claude), auto-mode defaults for spawned sessions, message popup behavior, and per-integration disable toggles.

## Reporting issues

Open an issue at <https://github.com/ryj-dev/session-manager/issues>.

## Credits

The design gallery is populated from [voltagent/awesome-design-md](https://github.com/voltagent/awesome-design-md) — thanks to the maintainers and contributors of that collection.
