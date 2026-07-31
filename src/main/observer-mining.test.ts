import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandShape, actionToken, redactSecrets, normalizeToolArg, projectKey } from './observer/tokens.ts'

// The observer's value depends entirely on whether two runs of "the same
// thing" collapse to the same token — too eager and unrelated work merges,
// too literal and nothing ever recurs. These are the cases that matter.

test('commandShape collapses invocations that differ only in arguments', () => {
  assert.equal(commandShape('npm run build'), 'npm run build')
  assert.equal(commandShape('npm run build --silent'), 'npm run build')
  assert.equal(commandShape('git commit -m "fix the thing"'), 'git commit')
  assert.equal(commandShape('git commit -m "something else entirely"'), 'git commit')
})

test('commandShape drops paths, numbers and hashes from the tail', () => {
  assert.equal(commandShape('cat src/main/ipc.ts'), 'cat')
  assert.equal(commandShape('git checkout a1b2c3d4e5f6'), 'git checkout')
  assert.equal(commandShape('sleep 30'), 'sleep')
})

test('commandShape keeps only the first command in a chain', () => {
  assert.equal(commandShape('npm run build && npm test'), 'npm run build')
  assert.equal(commandShape('cat /tmp/foo | grep bar'), 'cat')
  assert.equal(commandShape('cd /tmp; ls'), 'cd')
  // A bare word after the program is kept — it is usually a subcommand
  // (`npm run`, `git status`), and that distinction carries the signal.
  assert.equal(commandShape('cat foo | grep bar'), 'cat foo')
})

test('commandShape survives empty and whitespace input', () => {
  assert.equal(commandShape(''), '')
  assert.equal(commandShape('   '), '')
})

test('actionToken generalises file edits to an extension, not a path', () => {
  const ev = (tool: string, arg: string): Parameters<typeof actionToken>[0] => ({
    id: 1, ts: Date.now(), sessionId: 's', project: 'p', kind: 'tool', payload: { tool, arg },
  })
  assert.equal(actionToken(ev('Edit', '/repo/src/a.ts')), 'edit:*.ts')
  assert.equal(actionToken(ev('Edit', '/repo/src/deeply/nested/b.ts')), 'edit:*.ts')
  // Different extension is a different habit.
  assert.notEqual(actionToken(ev('Edit', '/repo/README.md')), 'edit:*.ts')
})

test('actionToken namespaces each event kind so tokens never collide', () => {
  const base = { id: 1, ts: Date.now(), sessionId: 's', project: 'p' } as const
  assert.equal(actionToken({ ...base, kind: 'ui', payload: { action: 'panel.open.notes' } }), 'ui:panel.open.notes')
  assert.equal(actionToken({ ...base, kind: 'mcp', payload: { tool: 'create-todo' } }), 'mcp:create-todo')
  assert.equal(actionToken({ ...base, kind: 'prompt', payload: { chars: 12 } }), 'prompt')
  assert.equal(
    actionToken({ ...base, kind: 'tool', payload: { tool: 'Bash', arg: 'npm run build --silent' } }),
    'bash:npm run build',
  )
})

test('actionToken returns null for a tool event with no tool name', () => {
  assert.equal(
    actionToken({ id: 1, ts: 0, sessionId: null, project: null, kind: 'tool', payload: {} }),
    null,
  )
})

// The command log would be a genuine hazard if it captured credentials, so the
// redactor is load-bearing rather than cosmetic.

test('redactSecrets strips secret-shaped environment assignments', () => {
  assert.match(redactSecrets('export AWS_SECRET_ACCESS_KEY=abc123xyz'), /AWS_SECRET_ACCESS_KEY=<redacted>/)
  assert.match(redactSecrets('GITHUB_TOKEN="ghp_realvalue" npm publish'), /GITHUB_TOKEN=<redacted>/)
  // A non-secret assignment is left intact — over-redacting destroys the signal.
  assert.match(redactSecrets('NODE_ENV=production npm start'), /NODE_ENV=production/)
})

test('redactSecrets strips flag values and known key shapes', () => {
  assert.match(redactSecrets('curl --token abcdef123456 https://x'), /--token <redacted>/)
  assert.match(redactSecrets('use sk-abcdefghijklmnopqrstuvwx now'), /<redacted>/)
  assert.match(redactSecrets('gh auth ghp_abcdefghijklmnopqrstuvwxyz01'), /<redacted>/)
  assert.match(redactSecrets('aws --profile AKIAIOSFODNN7EXAMPLE'), /<redacted>/)
})

test('redactSecrets leaves an ordinary command untouched', () => {
  const cmd = 'npm run build && npm test -- --watch=false'
  assert.equal(redactSecrets(cmd), cmd)
})

test('normalizeToolArg keeps commands, paths and patterns but nothing else', () => {
  assert.equal(normalizeToolArg('Bash', { command: 'npm  run\n  build' }), 'npm run build')
  assert.equal(normalizeToolArg('Edit', { file_path: '/a/b.ts' }), '/a/b.ts')
  assert.equal(normalizeToolArg('Grep', { pattern: 'TODO' }), 'TODO')
  // No structural argument → the tool name alone is the signal.
  assert.equal(normalizeToolArg('WebSearch', { query: 'private thing' }), null)
  assert.equal(normalizeToolArg('Bash', {}), null)
  assert.equal(normalizeToolArg('Bash', null), null)
})

test('normalizeToolArg redacts secrets before they can be stored', () => {
  const out = normalizeToolArg('Bash', { command: 'API_KEY=supersecretvalue ./deploy.sh' })
  assert.ok(out && !out.includes('supersecretvalue'), `expected redaction, got: ${out}`)
})

test('projectKey reduces a path to its basename', () => {
  assert.equal(projectKey('/Users/x/Documents/github/session-manager'), 'session-manager')
  assert.equal(projectKey('/Users/x/repo/'), 'repo')
  assert.equal(projectKey(null), null)
  assert.equal(projectKey(''), null)
})
