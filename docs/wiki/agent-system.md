---
slug: agent-system
title: Agent System
summary: Spawn specialized agents (code-reviewer, debugger, researcher, architect-reviewer) as real sessions with restricted tool sets.
related: [spawned-sessions, skills-system, inter-session-messaging, hotkeys-settings]
---

# Agent System

## What it is

Agents are predefined specialist personas — a system prompt plus an allowed-tools list in a markdown file — that spawn as **real, full Claude Code sessions**. Unlike ad-hoc spawned sessions, an agent comes with a curated role and hard tool restrictions (e.g. the code reviewer physically cannot Edit or Write).

## Bundled agents

| Agent | Role | Notes |
|-------|------|-------|
| `code-reviewer` | Read-only code review | Tools: Read, Bash, Glob, Grep — no write access |
| `debugger` | Debugging specialist | |
| `researcher` | Research tasks | |
| `architect-reviewer` | Architecture review | |

Definitions live in `resources/agents/*.md` (YAML frontmatter: name, description, tools, model; body = system prompt).

## How to use it

**From the UI:** press `Cmd+A` to open the agent gallery (full overlay in graph view, sidebar picker in focused view), click an agent card, type the task, and a new session spawns.

**From a session (MCP):**

```
mcp__session-manager__list-agents          # names, descriptions, tool lists
mcp__session-manager__spawn-agent
  agentName: "code-reviewer"
  prompt: "Review the diff on branch feature/x against main; focus on the auth changes."
  projectPath: "/abs/path"      # optional
  reportBack: "true"            # same modes as spawn-session
  modelId: "opus"               # optional alias or full model id
```

## How it works

Spawning an agent installs its definition as a slash command (`~/.claude/commands/sm-<name>.md`), then starts a new session with `--allowedTools` set to the agent's tool list (plus auto-allowed `send-message`) and `/sm-<name> <your prompt>` as a single initial input — the slash command loads the persona and the prompt in the same turn, so the agent can't start acting before its instructions land. All `sm-*` commands are cleaned up on app startup.

## Use cases

- Independent review: spawn `code-reviewer` on your branch while you keep coding; it messages findings back.
- Safe delegation: give a task to an agent whose tool set makes destructive mistakes impossible.
- Parallel research: several `researcher` agents on different questions, each reporting back.

## Gotchas & tips

- Same context rules as `spawn-session`: the agent has **no conversation history** — the prompt must be self-contained; the parent id and report-back instructions are appended automatically, so never write them yourself.
- Agent tool restrictions are hard constraints enforced by the CLI (`--allowedTools`), not suggestions in the prompt.
- The tool restriction means an agent may be unable to do follow-up work outside its role — spawn a plain session instead if the task might need edits.
- When the user asks to "spawn an agent / session", use `spawn-agent`/`spawn-session` (real, visible, messageable sessions) rather than any built-in subagent mechanism.
