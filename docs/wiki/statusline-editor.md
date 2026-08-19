---
slug: statusline-editor
title: Statusline Editor
summary: "Visual builder for a managed Claude Code statusline — toggle elements (rate limits, context, cost, tokens, git) with live preview; installs a generated script under ~/.claude/ and can hand off custom components to a Claude session."
related: [hotkeys-settings, skills-system]
---

# Statusline Editor

## What it is

The statusline editor builds the single-line status bar Claude Code renders under its prompt — model, rate-limit usage, context fill, session cost, token counts, git state — without writing the script yourself. You toggle elements with a live mock preview; the app generates the script, wires it into `~/.claude/settings.json`, and keeps ownership of the files it wrote (a **managed** statusline).

Note: this is a **global Claude Code setting** — the statusline appears in every Claude Code session on the machine, not just ones spawned from this app.

## How to use it

1. Open Settings (`Cmd+O` by default) → **Statusline**.
2. Toggle elements on/off. They're grouped:
   - **General** — model name
   - **Rate limits** — 5h / 7d usage %, reset countdowns, visual bars
   - **Session** — context-window usage % / bar, session cost (USD)
   - **Tokens** — input, output, total, cache-read
   - **Workspace** — git branch, lines changed (+/−)
3. The preview at the top renders mock values live as you toggle.
4. Apply — the app writes the config + script and points Claude Code at it. New Claude Code responses pick it up immediately; no restart needed.

## What gets written

| File | Purpose |
|------|---------|
| `~/.claude/statusline-config.json` | The managed config: enabled elements, order, custom components, `managed: true` marker |
| `~/.claude/statusline-command.sh` (macOS/Linux) or `statusline-command.js` (Windows) | Generated script — bash+jq on Unix, Node.js on Windows. Regenerated from the config on every apply |
| `~/.claude/settings.json` | `statusLine.command` set to run the script |

Claude Code invokes the script with a JSON payload on stdin after every response; the script prints one line of plain text. **No ANSI escapes** — the statusline is plain text (Unicode is fine, which is how the bar elements work).

## Custom components

Beyond the built-in elements you can add your own component (e.g. "show ⚠ when session cost exceeds $1"). The editor hands this off to a Claude session: it spawns a session with the `statusline-component-creator` skill, pre-loaded with the script and config paths, the stdin JSON schema, and the component contract (`description`, `preview`, `extract`, `format`, optional `guard`). The session writes the component into the config; the script is regenerated on the next toggle or reload.

## Pre-existing custom statuslines

If `~/.claude/settings.json` already has a `statusLine` the app didn't write, the editor detects it and reports it as a custom (unmanaged) statusline rather than overwriting it. Cleanup → Statusline shows the same distinction.

## Uninstalling

Settings → Cleanup → **Statusline** removes the managed config, the generated script, and the `statusLine` entry in `~/.claude/settings.json`. Because it's managed (marker in the config), cleanup never touches a statusline you wrote yourself.

## Gotchas & tips

- Rate-limit and cost fields come from what Claude Code puts on stdin — if a field is missing in your Claude Code version, that element renders empty rather than erroring.
- The bars are fixed-width Unicode blocks; in very narrow terminals prefer the percentage variants.
- Custom-component `extract` snippets run on every response — keep them cheap (a `jq` pull, not a network call).
