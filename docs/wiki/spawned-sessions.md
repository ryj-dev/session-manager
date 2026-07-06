---
slug: spawned-sessions
title: Spawned Sessions
summary: Delegate work to new Claude Code sessions with the spawn-session MCP tool — reportBack modes, allowedTools, and context rules.
related: [agent-system, inter-session-messaging, agentic-pipeline, terminal-management]
---

# Spawned Sessions

## What it is

`spawn-session` lets any session (or the user, via an agent) create a **new, fully independent Claude Code session** with an initial prompt. The child appears in the graph, starts working immediately, and can message its parent back. This is the building block for delegation, parallel work, and the agentic pipeline's workers.

## How to use it

```
mcp__session-manager__spawn-session
  prompt: "<full task description with ALL context>"   # required
  projectPath: "/abs/path"        # optional — defaults to the caller's cwd
  allowedTools: ["Read", "Edit", "Bash"]   # optional tool restriction
  reportBack: "true"              # 'true' | 'done' | 'optional' | 'false'
  modelId: "sonnet"               # optional: haiku|sonnet|opus|fable alias, or full id
```

Returns the new session's id (usable with `send-message`).

### reportBack modes

| Value | Child's instruction | Use when the user says… |
|-------|--------------------|-------------------------|
| `"true"` (default) | Report findings/results back to the parent | "find out", "investigate", "check whether" |
| `"done"` | Send a brief "task X done." ping, no details | "do X then let me know" |
| `"optional"` | Report only if useful | "go fix", "handle this" |
| `"false"` | Don't report unless blocked | "just do it" (output lands elsewhere, e.g. a PR) |

## Context rules (important)

- **The child inherits no conversation history.** Put everything it needs — file paths, decisions, constraints — into `prompt`.
- **Never write your own session id into the prompt.** The parent's id and messaging instructions are appended automatically (from `APP_SESSION_ID`); a hand-written id may be stale.
- **Don't hand-write "report back" instructions** — set the `reportBack` flag; the correct wording is appended for you.
- `mcp__session-manager__send-message` is always auto-added to `allowedTools`, so the child can report back even under a tight restriction.

## How it works

The MCP tool posts to the hook server's `/spawn` endpoint, which spawns `claude` in the target directory with the prompt as a **CLI positional argument** (after `--`), plus `--session-id <fresh-uuid>` and any `--allowedTools`. Passing the prompt as an argument avoids TUI paste-timing problems entirely. The renderer is notified and the node appears in the graph immediately. Settings → *Start child sessions in auto mode* controls whether children run with permission auto-approval.

Additional pipeline-only parameters (`pipelineTaskId`, `pipelineRole`, `pipelineLabel`, `fanoutKind`, `worktreeBranch`, `isolate`) register the child into a pipeline task tree instead of the graph — see [agentic-pipeline](agentic-pipeline.md).

## Use cases

- Fan out an investigation: spawn three sessions to explore three subsystems, each with `reportBack: "true"`.
- Fire-and-forget chores ("update the changelog") with `reportBack: "false"`.
- Restricted workers: `allowedTools: ["Read", "Grep", "Glob"]` for a read-only research child.

## Gotchas & tips

- When in doubt pick `reportBack: "true"` — an unnecessary report is cheap; a missing one is frustrating.
- `projectPath` defaults to the *caller's* working directory, which for an MCP server process may not be what you expect — pass it explicitly for anything cross-project.
- Spawned sessions are normal graph sessions: they persist/restore by the usual rules and count toward your visual working set. For scheduled or orchestrated work, prefer scheduled tasks or the pipeline, which keep sessions out of the graph.
