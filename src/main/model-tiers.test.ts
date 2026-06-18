// Unit tests for model-tier resolution + per-role defaults.
// Run with: npm test  (node --test, native TS type-stripping on Node 22+).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MODEL_IDS,
  resolveModelId,
  defaultModelForRole,
  defaultEnvForRole,
} from './model-tiers.ts'

test('resolveModelId maps aliases case-insensitively', () => {
  assert.equal(resolveModelId('opus'), MODEL_IDS.opus)
  assert.equal(resolveModelId('sonnet'), MODEL_IDS.sonnet)
  assert.equal(resolveModelId('haiku'), MODEL_IDS.haiku)
  assert.equal(resolveModelId('OPUS'), MODEL_IDS.opus)
  assert.equal(resolveModelId('  Sonnet  '), MODEL_IDS.sonnet)
})

test('resolveModelId passes a full model id through verbatim', () => {
  assert.equal(resolveModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001')
  assert.equal(resolveModelId('  claude-opus-4-8  '), 'claude-opus-4-8')
})

test('resolveModelId returns undefined for empty/missing/whitespace input', () => {
  assert.equal(resolveModelId(undefined), undefined)
  assert.equal(resolveModelId(''), undefined)
  assert.equal(resolveModelId('   '), undefined)
})

test('resolveModelId does not match Object prototype members (own-property check)', () => {
  // `key in MODEL_IDS` would walk the prototype chain and return a function;
  // these must pass through verbatim as full-id overrides instead.
  assert.equal(resolveModelId('constructor'), 'constructor')
  assert.equal(resolveModelId('toString'), 'toString')
  assert.equal(resolveModelId('hasOwnProperty'), 'hasOwnProperty')
})

test('defaultModelForRole: plan synthesis → opus, plan research → haiku', () => {
  assert.equal(defaultModelForRole('plan'), MODEL_IDS.opus)
  assert.equal(defaultModelForRole('plan', 'topics'), MODEL_IDS.opus)
  assert.equal(defaultModelForRole('plan', 'research'), MODEL_IDS.haiku)
})

test('defaultModelForRole: implement → opus', () => {
  assert.equal(defaultModelForRole('implement'), MODEL_IDS.opus)
  assert.equal(defaultModelForRole('implement', 'worktrees'), MODEL_IDS.opus)
})

test('defaultModelForRole: review → sonnet', () => {
  assert.equal(defaultModelForRole('review'), MODEL_IDS.sonnet)
  assert.equal(defaultModelForRole('review', 'topics'), MODEL_IDS.sonnet)
})

test('defaultModelForRole: orchestrator and absent role → undefined (inherit)', () => {
  assert.equal(defaultModelForRole('orchestrator'), undefined)
  assert.equal(defaultModelForRole(undefined), undefined)
})

test('defaultEnvForRole: plan/implement set CLAUDE_CODE_SUBAGENT_MODEL=haiku', () => {
  assert.deepEqual(defaultEnvForRole('plan'), { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' })
  assert.deepEqual(defaultEnvForRole('implement'), { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' })
})

test('defaultEnvForRole: review/orchestrator/absent get no env override', () => {
  assert.deepEqual(defaultEnvForRole('review'), {})
  assert.deepEqual(defaultEnvForRole('orchestrator'), {})
  assert.deepEqual(defaultEnvForRole(undefined), {})
})

test('defaultEnvForRole never sets MAX_THINKING_TOKENS (unverified, left unset)', () => {
  for (const role of ['plan', 'implement', 'review', 'orchestrator'] as const) {
    assert.ok(!('MAX_THINKING_TOKENS' in defaultEnvForRole(role)))
  }
})
