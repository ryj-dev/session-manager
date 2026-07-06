// Model-tier selection for pipeline spawns. No electron imports here so the
// resolution + defaulting stays trivially unit-testable (mirrors pipeline-roles.ts).

import type { PipelineRole } from './pipeline-roles'

/** Model-family aliases per tier. The `claude` CLI accepts these verbatim on
 *  --model and resolves each to the NEWEST version the installed CLI supports,
 *  so no concrete model version is ever hardcoded here — upgrading Claude Code
 *  upgrades every spawn automatically. */
export const MODEL_IDS = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
  fable: 'fable',
} as const

/** Normalize an alias (opus|sonnet|haiku|fable, case-insensitive) OR pass a
 *  full model id through verbatim. Returns undefined for empty input
 *  (→ inherit default model). */
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
