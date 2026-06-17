// Per-role allowedTools scoping for pipeline worker sessions. No electron
// imports here so the derivation stays trivially unit-testable.

export type PipelineRole = 'orchestrator' | 'plan' | 'implement' | 'review'

const READ_TOOLS = ['Read', 'Grep', 'Glob']
const NARRATE = ['mcp__session-manager__emit-milestone', 'mcp__session-manager__send-message']

export const ROLE_TOOLS: Record<'plan' | 'implement' | 'review', string[]> = {
  review: [...READ_TOOLS, ...NARRATE],
  implement: [...READ_TOOLS, 'Write', 'Edit', 'Bash', ...NARRATE],
  plan: [...READ_TOOLS, ...NARRATE, 'mcp__session-manager__spawn-session'],
}

/**
 * Server-side tool scoping for spawned worker sessions, derived from their
 * pipeline role. Returns undefined for orchestrator / absent role (no
 * restriction applied on this path — the real orchestrator is scoped via its
 * own spawn path, and non-pipeline spawns stay unrestricted as before).
 */
export function deriveRoleTools(role?: PipelineRole): string[] | undefined {
  if (role === 'plan' || role === 'implement' || role === 'review') return ROLE_TOOLS[role]
  return undefined
}
