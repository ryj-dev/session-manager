// Model-tier selection for pipeline spawns. No electron imports here so the
// resolution + defaulting stays trivially unit-testable (mirrors pipeline-roles.ts).

import type { PipelineRole } from './pipeline-roles'

/** Concrete Claude model ids per tier. Aliases (opus|sonnet|haiku) resolve here. */
export const MODEL_IDS = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
} as const

/** Map an alias (opus|sonnet|haiku, case-insensitive) OR a full model id to a
 *  concrete id. Returns undefined for empty input (→ inherit default model). A
 *  non-alias, non-empty string is passed through verbatim (full id override). */
export function resolveModelId(input?: string): string | undefined {
  if (!input) return undefined
  const trimmed = input.trim()
  if (!trimmed) return undefined // whitespace-only → inherit default model
  const key = trimmed.toLowerCase()
  // Own-property check: `in` walks the prototype chain, so keys like
  // 'constructor'/'toString'/'hasOwnProperty' would wrongly match.
  if (Object.hasOwn(MODEL_IDS, key)) return MODEL_IDS[key as keyof typeof MODEL_IDS]
  return trimmed // assume caller passed a full model id
}

/** DECIDED default tier per (role, fanoutKind). An explicit modelId always wins;
 *  this is the safety-net fallback when the orchestrator omits modelId.
 *  - plan synthesis → opus (sets direction); plan research probes → haiku (reads/lookups)
 *  - implement → opus (where code quality is born)
 *  - review → sonnet (verification < generation; fans out N×)
 *  The orchestrator's own tier is set at its spawn site, not here. */
export function defaultModelForRole(role?: PipelineRole, fanoutKind?: string): string | undefined {
  switch (role) {
    case 'plan':
      return fanoutKind === 'research' ? MODEL_IDS.haiku : MODEL_IDS.opus
    case 'implement':
      return MODEL_IDS.opus
    case 'review':
      return MODEL_IDS.sonnet
    // orchestrator handled at its own spawn site; undefined → inherit
    default:
      return undefined
  }
}

/** Per-(role, fanoutKind) environment overrides for spawned worker PTYs.
 *  Currently sets the built-in Claude Code subagent model to Haiku for the
 *  plan/implement roles so any internal Task/subagent calls they make stay cheap.
 *  MAX_THINKING_TOKENS is intentionally left UNSET until its behaviour on the
 *  current adaptive-thinking CLI build is verified empirically. */
export function defaultEnvForRole(role?: PipelineRole, _fanoutKind?: string): Record<string, string> {
  switch (role) {
    case 'plan':
    case 'implement':
      return { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }
    default:
      return {}
  }
}
