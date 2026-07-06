---
slug: inter-session-messaging
title: Inter-Session Messaging
summary: Sessions message each other with the send-message MCP tool; delivery is instant via a monitor-plugin inbox, even while the target is working.
related: [spawned-sessions, hook-integration-status, agent-system, mcp-server-overview]
---

# Inter-Session Messaging

## What it is

Any session managed by the app can send a message to any other with the `send-message` MCP tool. Delivery is **instant regardless of whether the target is idle or working**: each session tails a private inbox file through a Claude Code background monitor, and each new line arrives in the target's conversation as a task notification.

## How to use it

```
mcp__session-manager__send-message
  targetSessionId: "<uuid>"     # from list-sessions, or given to a spawned child
  message: "Found the bug in src/x.ts — it's the null check on line 40."
```

- Discover targets with `list-sessions` (returns id, status, title, project path per session).
- Child sessions spawned via `spawn-session` / `spawn-agent` are told their **parent's session id automatically** — they can message back without looking anything up.
- `send-message` is auto-allowed for every spawned session, even under a restrictive `allowedTools` list.
- The user also sees incoming messages as an in-app popup (Settings → *Message popup*: manual dismiss / auto-dismiss after N seconds / disabled).

## How delivery works

1. The sender's MCP tool posts to the hook server's `/message` endpoint.
2. The server appends one line to `messages/<targetSessionId>/inbox.txt` in the app data dir.
3. The target session's `message-bus` monitor (from the bundled `session-manager-local` plugin) runs `tail -f "$SESSION_MANAGER_INBOX"` — the new line is injected into the target's context as a notification, mid-turn if necessary.

Messages longer than ~400 characters are written to a `msg-<uuid>.md` file instead, with a pointer line in the inbox telling the recipient to Read the file (notification lines get truncated around 500 chars, so long content must travel by file).

## Use cases

- A child session reporting results back to the parent that spawned it.
- Coordinating parallel sessions ("I've taken the API layer, you do the UI").
- Waking a gated pipeline orchestrator with an approval decision.
- Pinging a long-running session with new instructions without focusing its terminal.

## Gotchas & tips

- Delivery is instant, **not queued-until-idle** — the target sees the message as a notification even mid-task. Don't expect it to wait for a turn boundary.
- Messaging requires the target to be a live session **spawned by this app** (it needs the inbox env var and the monitor plugin); unknown session ids return an error.
- Inboxes are wiped on session exit, app startup, and shutdown — messages are transient, not a durable mailbox. Put anything that must persist into a todo or memory note instead.
- Monitors require a recent Claude Code (~2.1.113+). If messages stop arriving, check that the `session-manager-local` plugin is installed and enabled.
