/**
 * Which MCP tools a session may have, given its observer role.
 *
 * A leaf module (no imports, no I/O) so both the stdio MCP server and the
 * tests can use it — importing mcp-server.ts itself would connect a real
 * stdio transport.
 *
 * WHY THIS EXISTS. The curator run was originally "restricted" by
 * `--allowedTools` plus a prompt telling it to behave. Neither is a boundary:
 * `--allowedTools` PRE-APPROVES a list, it does not deny what's missing, and
 * the run uses `--permission-mode auto`, which auto-approves everything else.
 * A background agent that can be talked into calling spawn-session or
 * edit-memory is a much bigger surface than the one it needs.
 *
 * So the boundary moved to registration time. The curator's PTY env carries
 * SM_OBSERVER_ROLE=curator; its stdio MCP server inherits that (the same way
 * it already inherits APP_SESSION_ID) and never registers the other ~45 tools.
 * What is not registered cannot be called, whatever the permission mode says.
 *
 * The gate is symmetric, and the second half matters as much as the first:
 * `observer-suggest` writes into the user's insights inbox, so it is withheld
 * from every ordinary session. That leaves the HTTP endpoint behind it as the
 * remaining hole, which is what the per-run token in curator.ts closes.
 */

/**
 * The session-manager MCP tools a curator run may use: read-only, plus the one
 * write path back into the inbox.
 *
 * `list-tags` is here so proposed todos carry correctly-cased `project:<name>`
 * tags rather than invented ones; `search-wiki` / `read-wiki-article` are here
 * so the curator can check the app's own feature docs before proposing a skill
 * that duplicates something the app already does natively.
 */
export const CURATOR_MCP_TOOLS = [
  'observer-suggest',
  'list-todos',
  'read-todo',
  'list-tags',
  'list-memories',
  'read-memory',
  'search-memories',
  'list-scheduled-tasks',
  'search-wiki',
  'read-wiki-article',
] as const

/** Tools no ordinary session gets, whatever else it is allowed to do. */
export const OBSERVER_ONLY_TOOLS: readonly string[] = ['observer-suggest']

const CURATOR_TOOL_SET: ReadonlySet<string> = new Set<string>(CURATOR_MCP_TOOLS)
const OBSERVER_ONLY_SET: ReadonlySet<string> = new Set(OBSERVER_ONLY_TOOLS)

/**
 * True when a session with this observer role may have `name` registered.
 *
 *  - role 'curator'  → only CURATOR_MCP_TOOLS.
 *  - any other role  → nothing. An unrecognised role is a bug or an attempt to
 *    forge one; failing closed makes both harmless.
 *  - no role at all  → everything except the observer-only tools.
 */
export function isToolAllowedForRole(name: string, role: string | null | undefined): boolean {
  if (role === 'curator') return CURATOR_TOOL_SET.has(name)
  if (role) return false
  return !OBSERVER_ONLY_SET.has(name)
}
