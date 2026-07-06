---
slug: todos-project-notes
title: Todos & Project Notes
summary: A single global todo+note list shared by user and agents, scoped by project: tags, with hybrid search and ambient in-session reminders.
related: [memory-knowledge-base, agentic-pipeline, hook-integration-status, hotkeys-settings]
---

# Todos & Project Notes

## What it is

One global list of items shared between the user and every Claude session. Each item has a title, a markdown body, a binary done/not-done state, and free-form tags. There is no separate "notes" system: an item with a substantial body and no urgency is a note; one with a one-line title and `done: false` is a task. Project membership is just a tag with the `project:` prefix (e.g. `project:session-manager`).

## How to use it

**In the app:**

- `Cmd+N` opens the notes panel scoped to the current session's project (when pressed inside a session); from the graph with nothing focused it opens unscoped.
- `Cmd+Shift+N` opens the global view (all projects, no tag filter).
- Toggle completed items, filter by tags, and edit bodies in the detail pane. Settings → *Completed items* controls how far back done items show (day/week/month/all).

**From a session (MCP tools):**

| Tool | Purpose |
|------|---------|
| `list-todos` | Filter by `tags`, `done`, and/or `search` |
| `read-todo` | Full item including markdown body |
| `create-todo` | `title`, optional `body`, optional `tags` |
| `update-todo` | Patch title/body/done/tags — **tags replace the whole set** |
| `delete-todo` | Permanent delete (prefer `done: true` to close) |
| `list-tags` | All tags with counts — use to match project tag casing |

**Tag semantics:** multiple `project:*` tags OR together; non-project tags AND together; the two groups AND. **Search** is hybrid: case-insensitive substring over title+body, plus semantic matches (bge-small embeddings) above a similarity threshold, deduped.

## Ambient awareness

The `UserPromptSubmit` hook injects a small system reminder into a session whenever the open-todo count for its project *changes* ("You have 5 open todos tagged `project:x`, 2 new…"). With Settings → *Nudge sessions about unfinished todos* enabled, a soft closing-line nudge is additionally injected at most every 8 turns while the count is stable. Reminders carry counts only, never bodies — agents fetch details with `list-todos` when relevant.

## Use cases

- "Jot this down / remind me to / we should…" → `create-todo` tagged with the current project.
- Agents parking out-of-scope findings (bugs, tech debt, follow-ups) discovered mid-task.
- The backlog column of the agentic pipeline **is** the open-todo list — a well-written todo body doubles as the task brief or review rubric ([agentic-pipeline](agentic-pipeline.md)).

## Gotchas & tips

- **Search before creating** — extend a near-duplicate open item via `update-todo` instead of adding another.
- Read current tags before updating them (`update-todo` replaces the entire set).
- Close items with `done: true`, not deletion — history is useful and the pipeline links back to todos.
- Todos are the *user's* workspace; the memory knowledge base is the *agent's* long-term knowledge. Don't cross the streams.
