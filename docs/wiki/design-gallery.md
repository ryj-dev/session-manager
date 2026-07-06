---
slug: design-gallery
title: Design Systems Gallery
summary: Browse ~60 brand design-system previews (light and dark) as reference material for frontend work.
related: [skills-system, hotkeys-settings]
---

# Design Systems Gallery

## What it is

A built-in gallery of roughly 60 brand design systems (Stripe, Linear, Vercel-style references and many more), each with a live HTML preview in light and dark variants. It's reference material: browse real-world design languages while building UI, or point a session at one as inspiration.

## How to use it

- Press `Cmd+D` to open the gallery (full overlay from the graph view; a narrower sidebar picker from a focused session).
- Cards render live iframe previews; click a card to view it fullscreen. `Esc` exits fullscreen (works even while the iframe has focus).
- Toggle **light/dark** in the gallery header (dark is the default).
- Brand color dots on each card help quick identification.

## How it works

Each brand lives in `resources/design/<brand>/` with `preview.html` and `preview-dark.html`, served through a custom `design://` Electron protocol (path-traversal protected). The collection is populated from the open-source `voltagent/awesome-design-md` repository.

## Use cases

- Pick a visual direction before starting a frontend feature and describe it to a session ("use spacing/typography like the Linear preview").
- Compare how different brands treat dark mode for a component you're designing.
- Quick side-by-side inspiration while pairing with a Claude session on CSS.

## Gotchas & tips

- The gallery is read-only reference — it doesn't inject anything into sessions. Combine it with a skill or a plain prompt to act on what you see.
- Previews are static HTML snapshots, not the brands' live sites.
