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

/**
 * Clamp an explicit allowedTools list to the role's envelope. With no envelope
 * (orchestrator / absent role) the list is returned unchanged, preserving
 * unrestricted non-pipeline spawns. For a worker role, any tool outside the
 * role envelope is dropped — an explicit override can narrow but never exceed.
 */
export function clampToRole(tools: string[], role?: PipelineRole): string[] {
  const envelope = deriveRoleTools(role)   // undefined for orchestrator / absent role
  if (!envelope) return tools
  const allowed = new Set(envelope)
  return tools.filter(t => allowed.has(t))
}

// Control tools that drive the pipeline board. Hard invariant: only the
// orchestrator may hold these — a worker must NEVER receive them, even when an
// explicit allowedTools override is supplied.
export const ORCHESTRATOR_ONLY_TOOLS = [
  'mcp__session-manager__pipeline-set-stage',
  'mcp__session-manager__pipeline-request-approval',
]

/** Remove orchestrator-only control tools from a worker's tool list. */
export function stripOrchestratorOnlyTools(tools: string[]): string[] {
  return tools.filter(t => !ORCHESTRATOR_ONLY_TOOLS.includes(t))
}
