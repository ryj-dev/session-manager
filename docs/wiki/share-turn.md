---
slug: share-turn
title: Share Turn
summary: "Cmd+Shift+S exports one conversation turn (prompt, tool activity, result) as clean markdown — with layer toggles, secret flagging, click-to-redact, and copy or save-to-folder output."
related: [hotkeys-settings, terminal-management, session-persistence, session-branching]
---

# Share Turn

## What it is

Share Turn exports a single conversation turn from a Claude session as clean, semantic markdown — for pasting into a PR description, a Slack thread, a ticket, or documentation. It re-renders the turn from the session's **structured transcript JSONL**, not a terminal scrape, so the output has real headings, fenced code blocks, and unified diffs instead of spinner artifacts and wrapped lines.

A **turn** is one user prompt plus everything the assistant did until the next prompt: tool calls (with results), file diffs, and the final reply. Thinking blocks, sidechains, and command wrappers are excluded; an interruption is marked on the turn it cut short.

## How to use it

1. Focus a Claude session and press `Cmd+Shift+S` (configurable — the `shareTurn` hotkey in Settings → Keyboard shortcuts).
2. Pick the turn (the modal opens on the latest; navigate to earlier ones).
3. Toggle layers and tool-detail level until the preview shows what you want.
4. Redact anything sensitive (see below).
5. **Copy to clipboard** (`⌘↵`) or **Save** a `.md` file into the turn export folder.

Nothing leaves the app until you confirm — the modal is compose-and-review, not auto-publish.

## Layers and tool-detail levels

Three independent layers make up the output:

| Layer | Contents |
|-------|----------|
| **Prompt** | The user message that started the turn (images are marked) |
| **Tool activity** | Each tool call with a one-line argument summary; Edit/Write calls render their file diff |
| **Result** | The assistant's final reply text |

Tool activity has three detail levels:

- **Summary** — tool names + argument one-liners only.
- **Commands** (default) — adds results, with Bash-style output trimmed to the first 6 lines. Edit diffs always survive trimming — the diff *is* the payload.
- **Full** — complete untruncated results.

Defaults for all four toggles live in Settings → **Share turn** and are remembered per install.

## Secrets: flagging and redaction

- **Advisory flagging** — long high-entropy tokens that contain both letters and digits (API keys, tokens) are highlighted in the preview. It's a warning only; nothing is ever auto-masked, and false positives (git SHAs, hashes in diffs) are expected and harmless.
- **Click-to-redact** — select any text in the preview to replace that exact span with `[REDACTED]` in the output. Redactions are anchored to stable segment ids, so what you redact in the preview is what's removed in the composed markdown, byte-for-byte — including after level toggles shorten a segment. Redactions are per-turn.

Truncation (the Commands level) is **not** redaction — secret scanning always sees the full text, so a flag can appear on content the current level hides.

## Where saves go

Saved files land in the **turn export folder** — by default `<projectPath>/turns/`, overridable globally in Settings → Share turn. The save dialog pre-fills a filename; the toast after saving shows the full path.

## Transcript sources

The modal reads the transcript JSONL from the hook-captured path first (authoritative — it survives `/resume` and `--fork-session`), falling back to the path derived from the session's cwd + Claude session id. A brand-new session with no completed turn has nothing to share yet.

## Gotchas & tips

- Only **Claude** sessions have turns — the hotkey no-ops on raw shell terminals and in graph view.
- Redact before switching turns if you're exporting several — redactions don't carry across turns.
- The entropy flagger can't see meaning: a password made of dictionary words won't flag, and a long commit SHA will. Skim the preview yourself before sharing externally.
- For sharing a whole visual result (a table, a report) rather than the conversation itself, the canvas is usually the better surface.
