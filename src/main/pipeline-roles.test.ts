// Unit tests for per-role allowedTools scoping.
// Run with: npm test  (node --test, native TS type-stripping on Node 22+).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveRoleTools, ROLE_TOOLS } from './pipeline-roles.ts'

const PIPELINE_CONTROL = [
  'mcp__session-manager__pipeline-set-stage',
  'mcp__session-manager__pipeline-request-approval',
]

test('review role is read-only + narration, no mutation or spawning', () => {
  const tools = deriveRoleTools('review')
  assert.ok(tools, 'review should resolve to a tool list')
  assert.ok(tools!.includes('Read'))
  assert.ok(tools!.includes('mcp__session-manager__emit-milestone'))
  assert.ok(tools!.includes('mcp__session-manager__send-message'))
  for (const banned of ['Write', 'Edit', 'Bash', 'mcp__session-manager__spawn-session']) {
    assert.ok(!tools!.includes(banned), `review must not include ${banned}`)
  }
})

test('implement role can mutate the repo but not spawn or drive the pipeline', () => {
  const tools = deriveRoleTools('implement')
  assert.ok(tools, 'implement should resolve to a tool list')
  for (const allowed of ['Write', 'Edit', 'Bash']) {
    assert.ok(tools!.includes(allowed), `implement must include ${allowed}`)
  }
  for (const banned of ['mcp__session-manager__spawn-session', ...PIPELINE_CONTROL]) {
    assert.ok(!tools!.includes(banned), `implement must not include ${banned}`)
  }
})

test('plan role can spawn research probes but not mutate the repo', () => {
  const tools = deriveRoleTools('plan')
  assert.ok(tools, 'plan should resolve to a tool list')
  assert.ok(tools!.includes('mcp__session-manager__spawn-session'))
  for (const banned of ['Write', 'Edit', 'Bash']) {
    assert.ok(!tools!.includes(banned), `plan must not include ${banned}`)
  }
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
