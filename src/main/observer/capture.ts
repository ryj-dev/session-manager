/**
 * Observer capture — the narrow, privacy-conscious funnel every event source
 * goes through on its way into the observer store.
 *
 * Sources:
 *  1. Hook events (hook-server) — PreToolUse carries `tool_input`, which for
 *     Bash contains the exact command. That is the single richest signal we
 *     have about what the user actually does repeatedly.
 *  2. Renderer UI actions (ipc `observer:ui`) — panel opens, hotkeys, spawns.
 *  3. Session lifecycle, tagged with the origin kind from the registry.
 *  4. session-manager MCP tool calls, relayed over the hook server.
 *
 * PRIVACY CONTRACT (enforced here, not by convention at the call sites):
 *  - Prompt bodies never enter the store. `recordPrompt` takes the text only to
 *    measure it and discards it.
 *  - Tool arguments are normalised to a short, structural form: a shell command
 *    is kept verbatim but truncated, a file path is kept, everything else is
 *    reduced to the tool name alone.
 *  - Anything that looks like a secret in a command string is redacted before
 *    it is written.
 */

import { appendEvent, type ObserverEventKind } from './db'
import { normalizeToolArg, projectKey } from './tokens'

// The pure normalisation/redaction helpers live in ./tokens (a leaf module
// with no imports) so they can be unit-tested without pulling in SQLite.
export { normalizeToolArg, projectKey, redactSecrets } from './tokens'

// ── Public recorders ────────────────────────────────────────────────────────

export function recordToolUse(opts: {
  sessionId: string
  projectPath: string | null
  tool: string
  toolInput: unknown
}): void {
  const arg = normalizeToolArg(opts.tool, opts.toolInput)
  appendEvent({
    kind: 'tool',
    sessionId: opts.sessionId,
    project: projectKey(opts.projectPath),
    payload: arg ? { tool: opts.tool, arg } : { tool: opts.tool },
  })
}

/** Records THAT a prompt happened and how long it was — never its text. */
export function recordPrompt(opts: {
  sessionId: string
  projectPath: string | null
  promptText?: string
}): void {
  appendEvent({
    kind: 'prompt',
    sessionId: opts.sessionId,
    project: projectKey(opts.projectPath),
    payload: { chars: opts.promptText?.length ?? 0 },
  })
}

export function recordSessionLifecycle(opts: {
  sessionId: string
  projectPath: string | null
  action: 'spawn' | 'end'
  sessionKind: string
}): void {
  appendEvent({
    kind: 'session',
    sessionId: opts.sessionId,
    project: projectKey(opts.projectPath),
    payload: { action: opts.action, sessionKind: opts.sessionKind },
  })
}

/** A renderer-side user action (panel opened, hotkey fired, pipeline started). */
export function recordUiAction(opts: {
  action: string
  detail?: string
  projectPath?: string | null
  sessionId?: string | null
}): void {
  appendEvent({
    kind: 'ui',
    sessionId: opts.sessionId ?? null,
    project: projectKey(opts.projectPath),
    payload: opts.detail ? { action: opts.action, detail: opts.detail.slice(0, 200) } : { action: opts.action },
  })
}

/** A session-manager MCP tool call (todo/memory work an agent did for you). */
export function recordMcpToolUse(opts: {
  sessionId: string | null
  projectPath: string | null
  tool: string
}): void {
  appendEvent({
    kind: 'mcp',
    sessionId: opts.sessionId,
    project: projectKey(opts.projectPath),
    payload: { tool: opts.tool },
  })
}

/** Generic escape hatch used by the IPC bridge, which receives a kind by name. */
export function recordRaw(
  kind: ObserverEventKind,
  payload: Record<string, unknown>,
  meta?: { sessionId?: string | null; projectPath?: string | null },
): void {
  appendEvent({
    kind,
    sessionId: meta?.sessionId ?? null,
    project: projectKey(meta?.projectPath),
    payload,
  })
}
