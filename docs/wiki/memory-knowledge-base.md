---
slug: memory-knowledge-base
title: Memory Knowledge Base
summary: Markdown knowledge notes with wikilinks, auto-synced backlinks, typed sections, hybrid semantic search, and a Sigma.js graph (Cmd+M).
related: [todos-project-notes, mcp-server-overview, hotkeys-settings]
---

# Memory Knowledge Base

## What it is

A persistent knowledge base of markdown notes shared between the user and every Claude session. Notes carry YAML frontmatter, typed `##` sections, and `[[wikilinks]]` with automatic bidirectional backlinks. It's the app's long-term memory — findings, decisions, domain knowledge — distinct from todos (task tracking) and from any per-conversation context.

## How to use it

**In the app:** `Cmd+M` opens the memory panel — a Sigma.js WebGL graph of all notes (nodes colored by type, edges = wikilinks), a searchable sidebar grouped by type, a note viewer with clickable wikilinks and inline section editing, and a structured note editor. Floating panels tune physics, colors/themes, and search behavior.

**From a session (MCP tools):**

| Tool | Purpose |
|------|---------|
| `create-memory` | New note; sections scaffolded by type |
| `read-memory` / `list-memories` | Read by filename / list (filter by tag or type) |
| `search-memories` | Hybrid keyword + semantic search (query, optional searchType: content/filename/both) |
| `edit-memory` | Append/prepend/replace one `## Section` |
| `batch-section-edit` | Many section edits across many notes in one call |
| `add-tags` / `remove-tags` | Tag management |
| `delete-memory` | Refuses if other notes link to it unless `force: true` |
| `repair-related` | Rebuild `## Related` from a full wikilink scan |

## Structure & conventions

- **Note types** (7): `project`, `decision`, `context`, `reference`, `session-log`, `user`, `feedback`.
- **Canonical section order**: `## Context` → `## Details` → `## Outcome` → `## Related`. Not all are required; `create-memory` scaffolds the right ones per type.
- **Wikilinks resolve by filename** (without `.md`), not by title: `[[my-note]]` → `my-note.md`.
- **Backlinks are automatic**: adding `[[b]]` inside note A updates B's `## Related` too. Never hand-edit `## Related` — `edit-memory` refuses; use `repair-related` if it drifts.
- Storage: flat directory of `.md` files at `<app data>/memories/` — plain files you can open in any editor.

## Search

`search-memories` fuses a keyword pass with local semantic embeddings (bge-small via a local index) using reciprocal-rank fusion, falling back to keyword-only if the embedding index isn't available. Search before creating: **update an existing note rather than writing a duplicate.**

## Prompt-time memory injection (opt-in)

Settings → *Memory injection* (default **off**) makes sessions receive relevant notes automatically: on each user prompt, the prompt is embedded locally and matched against the note index; the top hits are injected into Claude's context as excerpts.

- **Modes**: *First prompt only* (one lookup when the session's first prompt is sent) or *Search on every prompt*. In every-prompt mode the query blends the current prompt with the previous couple, so a terse follow-up ("yes do that") still carries the conversation's topic.
- **Bounded**: max 3 notes per prompt, excerpt-only (~700 chars each), similarity-gated (nothing injects when nothing is genuinely relevant; the *Match strictness* preset — super strict / strict / balanced / lenient — sets how close a match must be), and each note injects **at most once per session** — repeat prompts on the same topic add nothing. The dedupe survives app restarts (persisted per Claude session id, since a resumed conversation already carries its earlier injections in context). An optional per-session cap adds a hard ceiling.
- **Visible**: every injection is announced in the transcript as `Relevant memories injected: [title] [title]`. Each `[title]` is clickable — it expands the full note in an overlay (Esc/click-away/scroll collapses). The announcement only appears when something actually landed.
- **Fast-path safe**: the lookup runs on the synchronous prompt hook under a hard 1.2 s budget (warm cost is ~tens of ms); if the model is cold or slow, that prompt simply gets no injection. The model is pre-warmed at startup when the feature is on.
- Injected excerpts point Claude at `read-memory` for full notes; the curator (observer) run is excluded.

## Use cases

- Record a root-cause analysis once; every future session finds it via `search-memories`.
- Capture architectural decisions (`decision` type) with the *why*, linked to the project overview note.
- Browse the graph to rediscover related knowledge through link neighborhoods.

## Gotchas & tips

- Don't store secrets/tokens, or ephemeral task state (that's what todos are for).
- A `[[link]]` to a note that doesn't exist yet is harmless — it simply won't resolve until the note is created.
- The file watcher picks up external edits (any editor) within a few hundred ms; the UI and MCP server stay in sync.
- Rapid successive graph rebuilds are debounced — huge bulk edits may take a moment to appear in the visualization.
