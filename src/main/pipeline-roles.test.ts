// Unit tests for per-role allowedTools scoping.
// Run with: npm test  (node --test, native TS type-stripping on Node 22+).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveRoleTools,
  ROLE_TOOLS,
  ORCHESTRATOR_ONLY_TOOLS,
  stripOrchestratorOnlyTools,
} from './pipeline-roles.ts'

const PIPELINE_CONTROL = [
  'mcp__session-manager__pipeline-set-stage',
  'mcp__session-manager__pipeline-request-approval',
]

const READ_TOOLS = ['Read', 'Grep', 'Glob']
const NARRATE = ['mcp__session-manager__emit-milestone', 'mcp__session-manager__send-message']

test('review role has exactly read-only + narration tools', () => {
  const expected = [...READ_TOOLS, ...NARRATE]
  assert.deepEqual([...ROLE_TOOLS.review].sort(), [...expected].sort())
  for (const banned of ['Write', 'Edit', 'Bash', 'mcp__session-manager__spawn-session']) {
    assert.ok(!ROLE_TOOLS.review.includes(banned), `review must not include ${banned}`)
  }
})

test('implement role has exactly read + mutate + narration tools', () => {
  const expected = [...READ_TOOLS, 'Write', 'Edit', 'Bash', ...NARRATE]
  assert.deepEqual([...ROLE_TOOLS.implement].sort(), [...expected].sort())
  for (const allowed of ['Write', 'Edit', 'Bash']) {
    assert.ok(ROLE_TOOLS.implement.includes(allowed), `implement must include ${allowed}`)
  }
  assert.ok(ROLE_TOOLS.implement.includes('mcp__session-manager__emit-milestone'))
  assert.ok(ROLE_TOOLS.implement.includes('mcp__session-manager__send-message'))
  for (const banned of ['mcp__session-manager__spawn-session', ...PIPELINE_CONTROL]) {
    assert.ok(!ROLE_TOOLS.implement.includes(banned), `implement must not include ${banned}`)
  }
})

test('plan role has exactly read + narration + spawn tools', () => {
  const expected = [...READ_TOOLS, ...NARRATE, 'mcp__session-manager__spawn-session']
  assert.deepEqual([...ROLE_TOOLS.plan].sort(), [...expected].sort())
  assert.ok(ROLE_TOOLS.plan.includes('mcp__session-manager__spawn-session'))
  assert.ok(ROLE_TOOLS.plan.includes('mcp__session-manager__emit-milestone'))
  assert.ok(ROLE_TOOLS.plan.includes('mcp__session-manager__send-message'))
  for (const banned of ['Write', 'Edit', 'Bash']) {
    assert.ok(!ROLE_TOOLS.plan.includes(banned), `plan must not include ${banned}`)
  }
})

test('deriveRoleTools resolves the same lists for worker roles', () => {
  assert.deepEqual(deriveRoleTools('review'), ROLE_TOOLS.review)
  assert.deepEqual(deriveRoleTools('implement'), ROLE_TOOLS.implement)
  assert.deepEqual(deriveRoleTools('plan'), ROLE_TOOLS.plan)
})

test('orchestrator and absent role are unrestricted on this path', () => {
  assert.equal(deriveRoleTools('orchestrator'), undefined)
  assert.equal(deriveRoleTools(undefined), undefined)
})

test('no worker role may drive the pipeline board', () => {
  for (const role of ['review', 'implement', 'plan'] as const) {
    for (const control of PIPELINE_CONTROL) {
      assert.ok(!ROLE_TOOLS[role].includes(control), `${role} must not include ${control}`)
    }
  }
})

test('ORCHESTRATOR_ONLY_TOOLS contains exactly the two control tools', () => {
  assert.deepEqual([...ORCHESTRATOR_ONLY_TOOLS].sort(), [...PIPELINE_CONTROL].sort())
})

test('stripOrchestratorOnlyTools removes both control tools, preserves the rest', () => {
  const input = [
    'Read',
    'Write',
    'mcp__session-manager__pipeline-set-stage',
    'mcp__session-manager__send-message',
    'mcp__session-manager__pipeline-request-approval',
  ]
  assert.deepEqual(stripOrchestratorOnlyTools(input), [
    'Read',
    'Write',
    'mcp__session-manager__send-message',
  ])
})

test('stripOrchestratorOnlyTools is a no-op when no control tools present', () => {
  const input = ['Read', 'Write', 'Edit', 'mcp__session-manager__send-message']
  assert.deepEqual(stripOrchestratorOnlyTools(input), input)
})
