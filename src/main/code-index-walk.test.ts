// Unit tests for code-index discovery + walker, run against throwaway temp
// repos. Run with: npm test  (node --test, native TS type-stripping).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listRepoFiles,
  changedSince,
  headCommit,
  isVendoredOrGenerated,
  langForPath
} from './code-index/walker.ts'
import { discoverRepos, normalizeToRepoRoot } from './code-index/discovery.ts'

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).toString().trim()
}

function makeRepo(base: string, name: string): string {
  const repoRoot = join(base, name)
  mkdirSync(repoRoot, { recursive: true })
  g(repoRoot, 'init', '-q')
  g(repoRoot, 'config', 'user.email', 'test@example.com')
  g(repoRoot, 'config', 'user.name', 'Test')
  g(repoRoot, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repoRoot, 'main.ts'), 'export const x = 1\n')
  g(repoRoot, 'add', '-A')
  g(repoRoot, 'commit', '-q', '-m', 'init')
  return repoRoot
}

const WALK_OPTS = { maxFileBytes: 512 * 1024, maxFiles: 20000 }

test('walker respects gitignore and skips binary/oversize/vendored files', () => {
  const base = mkdtempSync(join(tmpdir(), 'sm-ci-'))
  try {
    const repo = makeRepo(base, 'repo')
    writeFileSync(join(repo, '.gitignore'), '.env\nsecret/\n')
    writeFileSync(join(repo, '.env'), 'TOKEN=supersecret\n')
    mkdirSync(join(repo, 'secret'))
    writeFileSync(join(repo, 'secret', 'creds.ts'), 'export const k = "nope"\n')
    writeFileSync(join(repo, 'untracked.py'), 'x = 1\n')
    writeFileSync(join(repo, 'photo.png'), Buffer.from([0x89, 0x50, 0x00, 0x47]))
    writeFileSync(join(repo, 'big.ts'), 'x'.repeat(600 * 1024))
    mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
    writeFileSync(join(repo, 'app.min.js'), 'var a=1;\n')
    writeFileSync(join(repo, 'package-lock.json'), '{}\n')

    const result = listRepoFiles(repo, WALK_OPTS)
    const paths = result.files.map((f) => f.relPath).sort()
    // .env + secret/ are gitignored; .gitignore/png have no mapped extension;
    // big.ts oversize; node_modules + .min.js + lockfile vendored.
    assert.deepEqual(paths, ['main.ts', 'untracked.py'])
    assert.equal(result.truncated, false)
    assert.equal(result.skippedOversize, 1)
    const untracked = result.files.find((f) => f.relPath === 'untracked.py')
    assert.equal(untracked?.lang, 'python')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('walker caps files and reports truncation, keeping newest', () => {
  const base = mkdtempSync(join(tmpdir(), 'sm-ci-'))
  try {
    const repo = makeRepo(base, 'repo')
    for (let i = 0; i < 5; i++) writeFileSync(join(repo, `f${i}.ts`), `export const v${i} = ${i}\n`)
    const result = listRepoFiles(repo, { maxFileBytes: 512 * 1024, maxFiles: 3 })
    assert.equal(result.truncated, true)
    assert.equal(result.files.length, 3)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('changedSince sees staged, unstaged, untracked, and renames', () => {
  const base = mkdtempSync(join(tmpdir(), 'sm-ci-'))
  try {
    const repo = makeRepo(base, 'repo')
    writeFileSync(join(repo, 'staged.ts'), 'export const s = 1\n')
    g(repo, 'add', 'staged.ts')
    writeFileSync(join(repo, 'main.ts'), 'export const x = 2\n') // unstaged edit
    writeFileSync(join(repo, 'newfile.py'), 'y = 2\n') // untracked
    const changed = changedSince(repo)
    assert.ok(changed)
    assert.ok(changed.includes('staged.ts'))
    assert.ok(changed.includes('main.ts'))
    assert.ok(changed.includes('newfile.py'))

    // rename: both sides reported so stale rows get removed
    g(repo, 'commit', '-q', '-am', 'wip')
    g(repo, 'add', '-A')
    g(repo, 'commit', '-q', '-m', 'wip2')
    g(repo, 'mv', 'staged.ts', 'renamed.ts')
    const afterMv = changedSince(repo)
    assert.ok(afterMv)
    assert.ok(afterMv.includes('renamed.ts'))
    assert.ok(afterMv.includes('staged.ts'))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('headCommit returns a hash for a repo, null for a plain dir', () => {
  const base = mkdtempSync(join(tmpdir(), 'sm-ci-'))
  try {
    const repo = makeRepo(base, 'repo')
    assert.match(headCommit(repo) ?? '', /^[0-9a-f]{40}$/)
    const plain = join(base, 'plain')
    mkdirSync(plain)
    assert.equal(headCommit(plain), null)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('vendored/generated filters', () => {
  assert.equal(isVendoredOrGenerated('node_modules/x/index.js'), true)
  assert.equal(isVendoredOrGenerated('src/dist.ts'), false)
  assert.equal(isVendoredOrGenerated('dist/bundle.js'), true)
  assert.equal(isVendoredOrGenerated('app.min.js'), true)
  assert.equal(isVendoredOrGenerated('pnpm-lock.yaml'), true)
  assert.equal(isVendoredOrGenerated('src/lib/util.ts'), false)
  assert.equal(langForPath('a/b.tsx'), 'tsx')
  assert.equal(langForPath('a/b.rs'), 'text')
  assert.equal(langForPath('a/b.wasm'), null)
})

test('discovery finds baseDir repos, normalises session worktrees, dedupes, excludes', () => {
  const base = mkdtempSync(join(tmpdir(), 'sm-ci-'))
  try {
    const repoA = makeRepo(base, 'projects/repo-a')
    const repoB = makeRepo(base, 'projects/repo-b')
    mkdirSync(join(base, 'projects', 'not-a-repo'))
    // linked worktree of repo-a, as a pipeline worker session cwd
    const wtDir = join(base, 'projects', '.pipeline-worktrees', 'task1', 'branch')
    g(repoA, 'worktree', 'add', '-q', '-b', 'wt-branch', wtDir)

    const repos = discoverRepos({
      baseProjectsDir: join(base, 'projects'),
      sessionCwds: [wtDir, repoB, join(base, 'projects', 'not-a-repo')],
      excludedRepos: []
    })
    const names = repos.map((r) => r.name).sort()
    // worktree cwd normalises into repo-a (already discovered), not-a-repo dropped
    assert.deepEqual(names, ['repo-a', 'repo-b'])

    const excluded = discoverRepos({
      baseProjectsDir: join(base, 'projects'),
      sessionCwds: [],
      excludedRepos: [repoB]
    })
    assert.deepEqual(
      excluded.map((r) => r.name),
      ['repo-a']
    )

    // a worktree cwd resolves to the main root; the worktree path itself never appears
    const norm = normalizeToRepoRoot(wtDir)
    assert.ok(norm && norm.endsWith('repo-a'))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
