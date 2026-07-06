---
slug: canvas
title: Canvas
summary: Per-session visual surface — agents answer with sortable tables, markdown reports, images, and annotated screenshots via canvas-show; user-sent images auto-display at send time.
related: [mcp-server-overview, hook-integration-status, split-view, hotkeys-settings]
---

# Canvas

## What it is

The canvas lets a session's agent answer with a **UI artifact instead of terminal text**: a sortable/filterable result table, a formatted markdown report, an image, or an annotated image (circles, boxes, arrows, labels drawn over a screenshot — "here is the button you asked about"). Artifacts render in a dock attached to the emitting session's terminal. The canvas is **invisible until used** — a session that never emits an artifact shows zero canvas chrome; the first artifact auto-opens the dock.

Images the **user** sends in chat also auto-display (tagged "sent by you"), so you can verify the agent received the right image. Display is strictly at **send time**: what's on the canvas is exactly what went into the conversation.

## How to use it (agents)

Call `canvas-show` with a `title` and **exactly one** of:

- `table` — `columns` (`key`, `label?`, `align?`; max 24) + `rows` (objects keyed by column key; max 2,000 rows / 20,000 cells, primitive cells). The user gets client-side sort (click headers) and substring filtering. Prefer this over a markdown table for anything worth sorting.
- `markdown` — GFM report (headings, lists, tables, code); max 100k chars.
- `image` — `path` (ABSOLUTE, `.png/.jpg/.jpeg/.gif/.webp`, must exist), optional `alt`, optional `annotations` + `coordSpace`.

**Annotating images — do not measure the file first:**

- Pass `coordSpace: "relative"` and give all coordinates as **0–1 fractions** of width/height (circle `r` = fraction of the shorter side). The host reads the pixel dimensions itself and converts. No `sips`, no ImageMagick.
- Annotation kinds: `circle{cx,cy,r}`, `box{x,y,w,h}`, `arrow{x1,y1,x2,y2}` (tail→head), `label{x,y,text}`; each takes optional `text`/`label` and `color` (CSS color, default rose).
- Out-of-bounds coordinates are rejected with the image's real dimensions in the error — correct and retry.
- Need precision on a small or dense image? Call `canvas-inspect-image(path)` **once**: returns the pixel dimensions and, for images under 600px, the path of a pre-upscaled copy to Read.

**Managing artifacts:**

- Each `canvas-show` call adds a new artifact and brings it into view; earlier ones stay in the dock's history. Emit **one artifact per logical result** — never re-emit unchanged content.
- To re-surface something already shown ("show me that table again"): `canvas-list-artifacts` (ids + one-line summaries) then `canvas-focus(artifactId)`.
- The canvas is **display-only** — the user cannot click anything back to you. Never use it for questions, choices, or approvals; ask those in chat.

## How it behaves (users)

- **Focused view**: dock opens at 36% beside the terminal (coexists with a pinned attached terminal: terminal | canvas | attached). Close it with ✕ or `Cmd+K`; the next artifact re-opens it.
- **Split view**: the dock opens inside the emitting session's pane. Panes narrower than ~480px get a compact pill ("table · 40 rows") that expands to a full-screen overlay on click (Esc closes).
- **Graph view**: nothing auto-opens; the session's node gets a ▣ badge (violet while unseen). Enter the session to see the canvas.
- Header chevrons (`‹ 2/5 ›`) flip through the session's artifact history; ⤢ expands to full screen.
- **User-sent images**: drag-drop / typed image paths in a prompt, and clipboard pastes (`Ctrl+V` or `Cmd+V`), display when the message is **sent**. A pasted image whose `[Image #N]` placeholder you delete before sending never displays. Toggle in Settings → Canvas ("Auto-display images you send in chat").

## Use cases

- "Where is the button on this screenshot?" → the same screenshot back with a circle around it.
- Query/analysis results as a sortable table instead of a 40-row markdown scroll.
- A polished markdown report (investigation summary, comparison, runbook) rendered instead of dumped as terminal text.
- Verifying you attached the right image before the agent starts working on it.

## Gotchas & tips

- Artifacts persist across app restarts (`state/canvas.json`, pruned to the 50 most recent globally) and re-attach to **restored** sessions via the Claude conversation id. Docks don't auto-pop after a restart — the badge / `Cmd+K` reveals them.
- Images render via the `canvas://` protocol, looked up by artifact id — the renderer can never fetch an arbitrary path. If a source image is deleted after emitting, the artifact shows an "image unavailable" card.
- Clipboard pastes are snapshotted to `canvas-images/` inside the app's data dir; unconfirmed pastes (placeholder deleted, app quit mid-prompt) are garbage-collected.
- Charts and interactive components (pick-one, approve/reject) are intentionally not part of v1.
