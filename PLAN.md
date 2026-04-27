# Plan: Inter-Session Message Bus via Plugin Monitor

Replace PTY-based inter-session message delivery with a file-based message bus powered by Claude Code's background monitor plugin feature.

## Monitor Schema (extracted from Claude Code v2.1.108 binary)

```json
[
  {
    "name": "string (unique within plugin, used to dedupe on re-arm)",
    "command": "string (shell command — every stdout line → <task_notification> to Claude)",
    "description": "string (shown in task panel)",
    "when": "always | on-skill-invoke:<skill>"
  }
]
```

- Supports `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${ENV_VAR}` substitution
- Runs in session cwd
- Auto-discovered from `monitors/monitors.json` at plugin root
- Plugin manifest lives at `.claude-plugin/plugin.json`

## New Message Flow

```
Sender (MCP send-message)
  → hook server POST /message
  → append line to ~/Library/Application Support/session-manager/messages/<target-id>/inbox.txt
  → monitor in target session (tail -f inbox.txt) emits the line
  → Claude sees it as <task_notification> — instantly, regardless of idle/working state
```

No queuing. No prompt detection. No 2s fallback. No PTY writing for messages.

## Implementation Steps

### Step 1: Create the session-manager plugin structure

New directory at the project root:

```
resources/plugin/
  .claude-plugin/
    plugin.json
  monitors/
    monitors.json
```

**plugin.json:**
```json
{
  "name": "session-manager",
  "version": "1.0.0",
  "description": "Background monitors for session-manager inter-session messaging"
}
```

**monitors/monitors.json:**
```json
[
  {
    "name": "message-bus",
    "command": "tail -f \"${SESSION_MANAGER_INBOX}\"",
    "description": "Incoming messages from other Claude Code sessions",
    "when": "always"
  }
]
```

The env var `SESSION_MANAGER_INBOX` will be set to the session's inbox file path. This is set by session-manager when spawning PTY sessions (pty-manager already sets `APP_SESSION_ID` in the env).

### Step 2: Plugin installation lifecycle

**New file: `src/main/plugin-manager.ts`**

Two functions:
- `installPlugin()` — called on app startup after hook server starts
  - Copies `resources/plugin/` to `~/Library/Application Support/session-manager/plugin/`
  - Registers in `~/.claude/plugins/installed_plugins.json` (follow same format as marketplace plugins)
  - Enables in `~/.claude/settings.json` under `enabledPlugins`
- `uninstallPlugin()` — called on app shutdown
  - Removes from `installed_plugins.json` and `enabledPlugins`

Use the existing `atomicWriteSync` for safe file writes.

### Step 3: Set inbox env var in PTY spawn

**Modified file: `src/main/pty-manager.ts`**

In `spawnSession()`, add `SESSION_MANAGER_INBOX` to the PTY environment:

```typescript
const inboxPath = join(app.getPath('userData'), 'messages', id, 'inbox.txt')
// Ensure the directory and file exist
mkdirSync(dirname(inboxPath), { recursive: true })
writeFileSync(inboxPath, '', { flag: 'a' }) // create if missing, don't truncate

env.SESSION_MANAGER_INBOX = inboxPath
```

This goes alongside the existing `APP_SESSION_ID` env var.

### Step 4: Rewrite handleSendMessage to file-append

**Modified file: `src/main/hook-server.ts`**

Replace the current `handleSendMessage()` (lines 267-312). Instead of checking idle/working and queuing:

```typescript
function handleSendMessage(body: string, res: ServerResponse): void {
  const { targetSessionId, message, fromSessionId } = JSON.parse(body)
  // ... validation ...

  const fromLabel = fromSessionId ? `Message from session ${fromSessionId}` : 'Message from another session'
  const line = `${fromLabel}: ${message.replace(/\n/g, '\\n')}\n`

  const inboxPath = join(app.getPath('userData'), 'messages', targetSessionId, 'inbox.txt')
  mkdirSync(dirname(inboxPath), { recursive: true })
  appendFileSync(inboxPath, line)

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ delivered: true }))
}
```

Messages are always `delivered: true` — the monitor picks them up.

### Step 5: Remove dead messaging infrastructure from hook-server.ts

Remove from `hook-server.ts`:

- `messageQueues` Map (line 23)
- `stopFallbackTimers` Map (line 27)
- `awaitingPromptReady` Set (line 29)
- `flushMessages()` function (lines 425-434)
- Prompt detection in `onPtyData()` — the `forshortcuts` matching block (lines 73-83). Keep only permission rejection detection.
- `idle_prompt` case in `handleHookEvent()` (lines 454-464) — dead code, never fires
- `idle_prompt` hook installation (line 536)
- Stop handler's fallback timer arming (lines 472-481) — the `if (messageQueues.has(...))` block
- `submitToSession` import (no longer used in this file)

### Step 6: Remove submitToSession from pty-manager.ts

**Modified file: `src/main/pty-manager.ts`**

Remove:
- `submitToSession()` function
- `submitAfterEcho()` function (only existed to support submitToSession)

Keep:
- `writeToSession()` / `writeWhenReady()` — still used for initial prompt delivery on spawn and raw PTY I/O
- `submitWhenReady()` — check if still used elsewhere; if only used for initial spawn prompt, keep it

### Step 7: Simplify MCP send-message response

**Modified file: `src/main/mcp-server.ts`**

The `send-message` tool (lines 651-680): remove the `queued` branch. Always return delivered:

```typescript
return { content: [{ type: 'text', text: `Message delivered to session ${targetSessionId}` }] }
```

### Step 8: Message cleanup

**Modified file: `src/main/hook-server.ts`**

In `cleanupSession()`, delete the session's inbox directory:
```typescript
rmSync(join(app.getPath('userData'), 'messages', appSessionId), { recursive: true, force: true })
```

On app quit (in `stopHookServer()`), clean up the entire messages directory.

### Step 9: Build configuration

**Modified file: `electron.vite.config.ts` (if needed)**

The plugin is static files (JSON), not compiled TypeScript. They get copied from `resources/plugin/` to the app data directory at runtime by `installPlugin()`. No build config changes needed unless we want to bundle them as Electron resources.

Add `resources/plugin/` to the electron-builder config so it's included in packaged builds.

## What Gets Removed (~90 lines)

- In-memory message queue and all queue/flush logic
- Stop hook fallback timer (2s timeout)
- PTY prompt readiness detection (`forshortcuts` matching)
- `idle_prompt` hook installation and handler (dead code)
- `submitToSession` / `submitAfterEcho` in pty-manager

## What Gets Added (~80 lines)

- `resources/plugin/` directory with plugin.json and monitors.json
- `src/main/plugin-manager.ts` (~50 lines): install/uninstall lifecycle
- File-append in `handleSendMessage` (~15 lines)
- Inbox env var setup in `spawnSession` (~5 lines)
- Cleanup on session exit (~5 lines)

## Message Received UI

When a message is delivered to a session's inbox, the hook server also sends an IPC event to the renderer with the message content and target session ID.

**New IPC channel: `session:message-received`**
```typescript
{ targetSessionId: string, fromSessionId: string | null, message: string }
```

**Renderer behavior:**
- Store received messages per session in Zustand: `pendingMessages: Map<string, MessageNotification[]>`
- When the user is focused on the target session → show popup immediately
- When the user is focused on a different session → queue silently, show when they switch to the target session
- Popups do NOT auto-dismiss — user must click to dismiss
- Message text is truncated (2-3 lines), clickable to expand/view full content
- Multiple messages stack (newest on top)

**New component: `MessagePopup.tsx`**
- Positioned top-right or bottom-right of the focused terminal view
- Shows truncated message prefixed with sender info (messages already start with "Message from session {id}:")
- Click to expand full message in a modal or inline expansion
- Dismiss button (X) removes from pending list
- Framer Motion enter/exit animation (slide in from right)

**Zustand additions:**
```typescript
interface MessageNotification {
  id: string           // unique ID for dismiss tracking
  targetSessionId: string
  fromSessionId: string | null
  message: string
  receivedAt: number
  dismissed: boolean
  expanded: boolean
}

// Store slice
pendingMessages: MessageNotification[]
addMessageNotification: (msg: Omit<MessageNotification, 'id' | 'receivedAt' | 'dismissed' | 'expanded'>) => void
dismissMessage: (id: string) => void
toggleMessageExpanded: (id: string) => void
```

**Visibility rule:** Only show popups for messages belonging to the currently focused session. On session focus change, show any undismissed messages for the newly focused session.

**Dismiss behavior — configurable in settings:**

New field in `AppSettings` (settings-store.ts):
```typescript
messagePopup: 'manual' | 'timed' | 'disabled'  // default: 'manual'
messagePopupSeconds: number                      // default: 15, only used when 'timed'
```

| Mode | Behavior |
|------|----------|
| `manual` | Popup stays until user clicks dismiss |
| `timed` | Popup auto-dismisses N seconds after the user **first sees it** (i.e. timer starts when the session is focused, not when the message arrives) |
| `disabled` | No popup at all — messages still deliver to Claude via monitor, just no UI notification |

Timer implementation: when a message notification transitions from "queued" to "visible" (user focuses the session), start a countdown. If the user switches away before the timer expires, pause it. Resume when they return.

## Net result

- **Simpler**: ~10 fewer lines of code overall, but more importantly removes the most fragile code paths
- **More reliable**: no timing-dependent delivery, no in-memory queues lost on crash
- **Faster**: messages arrive instantly via monitor, no 2s wait
- **Works while busy**: Claude receives messages even while working (no queuing needed)

## Plugin Registration Format

From `~/.claude/plugins/installed_plugins.json`:
```json
{
  "version": 2,
  "plugins": {
    "session-manager@local": [{
      "scope": "user",
      "installPath": "~/Library/Application Support/session-manager/plugin",
      "version": "1.0.0",
      "installedAt": "<ISO timestamp>",
      "lastUpdated": "<ISO timestamp>"
    }]
  }
}
```

From `~/.claude/settings.json`:
```json
{
  "enabledPlugins": {
    "session-manager@local": true
  }
}
```

## Notes

- **Newline handling**: `tail -f` emits one line per `\n`. Multi-line messages get `\n` escaped to `\\n`. Claude can interpret these. Lines arriving within 200ms batch into a single `<task_notification>`.
- **`tail -f` on macOS**: Reliable for append-only files. Can switch to `tail -F` if needed.
- **Monitor schema** (extracted from binary): `name`, `command`, `description`, `when` — no matcher field. Every stdout line is delivered.
