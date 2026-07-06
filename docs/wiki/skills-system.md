---
slug: skills-system
title: Skills System
summary: Inject reusable slash-command skills (brainstorming, frontend-slides, regression-loop) into new or running sessions.
related: [agent-system, design-gallery, hotkeys-settings]
---

# Skills System

## What it is

Skills are reusable slash commands — a markdown body with YAML frontmatter (name, description) — that can be injected into a session to change how it works for the rest of the conversation. Where an *agent* is a whole specialist session, a *skill* is a mode you switch an existing (or fresh) session into.

## Bundled skills

| Skill | Purpose |
|-------|---------|
| `brainstorming` | Collaborative design/planning before implementation — hard gate: no code until the design is approved |
| `frontend-slides` | Frontend slide deck creation |
| `regression-loop` | Iterative regression-testing workflow |

Definitions live in `resources/skills/*.md`. They're also exposed through the bundled `session-manager-local` plugin, so they're available as slash commands in any session.

## How to use it

Press `Cmd+S` to open the skills gallery:

- **From the graph view** — clicking a skill spawns a *new* session and immediately runs `/sm-<skill>` in it.
- **From a focused session** — the sidebar picker installs the skill and runs the slash command in the *current* session.

Under the hood the skill file is installed to `~/.claude/commands/sm-<name>.md` and triggered by writing `/sm-<name>` into the session's PTY.

## Use cases

- Flip a session into structured brainstorming mode before starting a feature.
- Start a fresh session pre-loaded with a slide-building workflow.
- Run a disciplined regression loop against a test suite without re-explaining the process.

## Gotchas & tips

- All `sm-*` commands are wiped and reinstalled on app startup — don't hand-edit files under `~/.claude/commands/sm-*`; change `resources/skills/` instead.
- A skill only shapes behavior via its prompt; unlike agents it does not restrict tools.
- Injecting a skill into a busy session queues the slash command as terminal input — it takes effect on the next turn.
