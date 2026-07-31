import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandShape, actionToken, redactSecrets, normalizeToolArg, parseMcpToolName, projectKey } from './observer/tokens.ts'

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

// ── MCP calls: one event, one token, server-qualified ───────────────────────

test('parseMcpToolName splits the server from the tool', () => {
  assert.deepEqual(parseMcpToolName('mcp__session-manager__list-todos'),
    { server: 'session-manager', name: 'list-todos' })
  // Hyphens and underscores are legal in a tool name; `__` is the separator.
  assert.deepEqual(parseMcpToolName('mcp__tc__tc_sql_query'),
    { server: 'tc', name: 'tc_sql_query' })
  assert.deepEqual(parseMcpToolName('mcp__claude-in-chrome__tabs_create_mcp'),
    { server: 'claude-in-chrome', name: 'tabs_create_mcp' })
})

test('parseMcpToolName returns null for anything that is not an MCP tool', () => {
  for (const name of ['Bash', 'Read', 'mcp__', 'mcp__server', 'mcp____tool', 'mcp__server__', 'notmcp__a__b']) {
    assert.equal(parseMcpToolName(name), null, name)
  }
})

test('MCP tokens are server-qualified so two servers do not collide', () => {
  const base = { id: 1, ts: 0, sessionId: 's', project: 'p', kind: 'mcp' } as const
  // Two servers can expose the same tool name; collapsing them would merge
  // unrelated work into one "habit".
  assert.equal(actionToken({ ...base, payload: { server: 'obsidian', tool: 'search-vault' } }),
    'mcp:obsidian:search-vault')
  assert.equal(actionToken({ ...base, payload: { server: 'tc-sql-atlas', tool: 'search-notes' } }),
    'mcp:tc-sql-atlas:search-notes')
  assert.notEqual(
    actionToken({ ...base, payload: { server: 'a', tool: 'search' } }),
    actionToken({ ...base, payload: { server: 'b', tool: 'search' } }),
  )
  // Rows written before the server was recorded still tokenise.
  assert.equal(actionToken({ ...base, payload: { tool: 'create-todo' } }), 'mcp:create-todo')
})

// ── Delegation: an agent-spawned session is not a user-spawned one ──────────

test('a delegated spawn tokenises differently from a hand-started one', () => {
  const base = { id: 1, ts: 0, sessionId: 'child', project: 'p', kind: 'session' } as const
  // Both are tagged kind 'user' by the registry — the parent link is the only
  // thing separating "I pressed the hotkey" from "an agent spawned this".
  assert.equal(
    actionToken({ ...base, payload: { action: 'spawn', sessionKind: 'user' } }),
    'session:spawn:user',
  )
  assert.equal(
    actionToken({ ...base, payload: { action: 'spawn', sessionKind: 'user', parentSessionId: 'parent-1' } }),
    'session:spawn:user:delegated',
  )
  assert.equal(
    actionToken({ ...base, payload: { action: 'end', sessionKind: 'user', parentSessionId: 'parent-1' } }),
    'session:end:user:delegated',
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

// ── Regression: shapes the redactor used to store verbatim ──────────────────
// Every case below was empirically confirmed to leak. A redactor that quietly
// keeps the credential is worse than none, because the privacy note in the
// store header claims the log is safe to keep for 60 days.

test('redactSecrets redacts the token after an auth scheme, not the scheme', () => {
  // Used to match a single \S+ after the colon: it replaced the word "Bearer"
  // and stored the token that followed it.
  const secret = 'aVeryRealLookingSessionToken123'
  for (const scheme of ['Bearer', 'Basic', 'Token', 'Digest']) {
    const out = redactSecrets(`curl -H "Authorization: ${scheme} ${secret}" https://api.example.com`)
    assert.ok(!out.includes(secret), `${scheme} token leaked: ${out}`)
    assert.match(out, new RegExp(`Authorization: ${scheme} <redacted>`))
  }
  // A bare credential with no scheme word is still redacted.
  assert.ok(!redactSecrets(`curl -H "Authorization: ${secret}"`).includes(secret))
  // Custom header variants.
  assert.ok(!redactSecrets(`curl -H "X-Api-Key: ${secret}"`).includes(secret))
  assert.ok(!redactSecrets(`curl -H "X-Hook-Secret: ${secret}"`).includes(secret))
})

test('redactSecrets redacts quoted values that contain spaces', () => {
  // A passphrase is exactly the kind of secret with spaces in it; the old
  // pattern stopped at the first space and stored the remainder.
  assert.equal(redactSecrets('PASSWORD="my secret pass" ./deploy.sh'), 'PASSWORD=<redacted> ./deploy.sh')
  assert.equal(redactSecrets("DB_PASSWORD='correct horse battery' psql"), 'DB_PASSWORD=<redacted> psql')
  assert.ok(!redactSecrets('API_KEY="two words here" run').includes('words'))
  assert.match(redactSecrets('--password "a b c" login'), /--password <redacted> login/)
})

test('redactSecrets redacts credentials embedded in a URL', () => {
  const out = redactSecrets('git clone https://alice:hunter2@github.com/org/repo.git')
  assert.ok(!out.includes('hunter2'), out)
  // Username and host survive — they are signal, and the command must stay
  // recognisable as "clone that repo" for mining to be worth anything.
  assert.match(out, /https:\/\/alice:<redacted>@github\.com/)
  assert.ok(!redactSecrets('psql postgres://user:s3cr3t@db.internal:5432/app').includes('s3cr3t'))
  // A URL with no credentials is untouched.
  assert.equal(redactSecrets('curl https://example.com/x'), 'curl https://example.com/x')
})

test('redactSecrets redacts the password half of curl -u / --user', () => {
  assert.match(redactSecrets('curl -u alice:hunter2 https://api.example.com'),
    /-u alice:<redacted>/)
  assert.match(redactSecrets('curl --user alice:hunter2 https://api.example.com'),
    /--user alice:<redacted>/)
  assert.ok(!redactSecrets('curl -u "alice:hunter2" https://x').includes('hunter2'))
  // Gated on the colon, so an unrelated -u keeps its argument.
  assert.equal(redactSecrets('sort -u names.txt'), 'sort -u names.txt')
})

test('redactSecrets still leaves non-secret commands intact', () => {
  // Over-redaction is its own failure: a log of <redacted> mines nothing.
  for (const cmd of [
    'npm run build',
    'git commit -m "fix the thing"',
    'docker run -u 1000 alpine',
    'NODE_ENV=production npm start',
    'curl https://example.com/health',
  ]) {
    assert.equal(redactSecrets(cmd), cmd)
  }
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
