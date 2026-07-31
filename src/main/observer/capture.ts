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
import { normalizeToolArg, parseMcpToolName, projectKey } from './tokens'

// The pure normalisation/redaction helpers live in ./tokens (a leaf module
// with no imports) so they can be unit-tested without pulling in SQLite.
export { normalizeToolArg, parseMcpToolName, projectKey, redactSecrets } from './tokens'

// ── Public recorders ────────────────────────────────────────────────────────

export function recordToolUse(opts: {
  sessionId: string
  projectPath: string | null
  tool: string
  toolInput: unknown
}): void {
  // A call into an MCP server is recorded as `mcp`, not `tool`. The hook
  // reports these as `mcp__<server>__<tool>`, and they used to be stored under
  // that raw name AND, for 22 allowlisted session-manager tools, a second time
  // by a beacon the MCP server fired itself — two events under two different
  // tokens for one call, so the pattern was split as well as double-counted.
  // The hook sees every server, so it is the single writer now.
  //
  // Arguments are deliberately dropped here. The privacy contract has always
  // said MCP calls record the NAME only; routing through the generic path was
  // quietly storing search patterns for tools like `mcp__fff__grep`.
  const mcp = parseMcpToolName(opts.tool)
  if (mcp) {
    appendEvent({
      kind: 'mcp',
      sessionId: opts.sessionId,
      project: projectKey(opts.projectPath),
      payload: { server: mcp.server, tool: mcp.name },
    })
    return
  }

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
  /** The session that spawned this one, when it was spawned by another
   *  session rather than by the user. */
  parentSessionId?: string | null
}): void {
  appendEvent({
    kind: 'session',
    sessionId: opts.sessionId,
    project: projectKey(opts.projectPath),
    // A session an agent delegated to is tagged 'user', exactly like one the
    // user opened with a hotkey — the registry knows the difference (it draws
    // the ↳ chip from it) but dropped it on the way in here, so the observer
    // could not tell "I spawned a session" from "an agent spawned a session".
    payload: opts.parentSessionId
      ? { action: opts.action, sessionKind: opts.sessionKind, parentSessionId: opts.parentSessionId }
      : { action: opts.action, sessionKind: opts.sessionKind },
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
