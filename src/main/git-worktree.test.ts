// Unit tests for the git-worktree lifecycle, run against throwaway temp repos.
// Run with: npm test  (node --test, native TS type-stripping on Node 22+).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getRepoRoot,
  getMainWorktreeRoot,
  sanitizeBranch,
  branchNameFor,
  addWorktree,
  mergeWorktree,
  removeWorktree,
  runExclusive,
} from './git-worktree.ts'

/** Run a git command in `cwd`, throwing on failure (test setup helper). */
function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).toString().trim()
}

/** Create an initialized git repo with one commit. Returns { base, repoRoot }.
 *  `base` is the parent temp dir (siblings .pipeline-worktrees live here too). */
function makeRepo(): { base: string; repoRoot: string } {
  const base = mkdtempSync(join(tmpdir(), 'sm-wt-'))
  const repoRoot = join(base, 'repo')
  mkdirSync(repoRoot)
  g(repoRoot, 'init', '-q')
  g(repoRoot, 'config', 'user.email', 'test@example.com')
  g(repoRoot, 'config', 'user.name', 'Test')
  g(repoRoot, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repoRoot, 'file.txt'), 'base\n')
  g(repoRoot, 'add', '-A')
  g(repoRoot, 'commit', '-q', '-m', 'initial')
  return { base, repoRoot }
}

function configureWorktreeUser(worktreePath: string): void {
  g(worktreePath, 'config', 'user.email', 'test@example.com')
  g(worktreePath, 'config', 'user.name', 'Test')
  g(worktreePath, 'config', 'commit.gpgsign', 'false')
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('sanitizeBranch / branchNameFor produce git-safe names', () => {
  assert.equal(sanitizeBranch('CSV Export!'), 'csv-export')
  assert.equal(sanitizeBranch(''), 'worker')
  assert.match(branchNameFor('519bbf21-aaaa', 'Auth Guard'), /^pipeline\/519bbf21\/auth-guard$/)
})

test('getRepoRoot returns root for a repo and null for a non-git dir', () => {
  const { base, repoRoot } = makeRepo()
  // A dedicated dir that is NOT inside any git repo (mkdtemp under the OS tmp
  // root, which isn't a working tree). tmpdir() itself could coincidentally be
  // inside a repo on some setups, so make our own isolated dir.
  const nonGit = mkdtempSync(join(tmpdir(), 'sm-nogit-'))
  try {
    const root = getRepoRoot(repoRoot)
    assert.ok(root && existsSync(join(root, '.git')), 'should resolve a repo root')
    assert.equal(getRepoRoot(nonGit), null, 'non-git dir should resolve to null')
    assert.equal(getMainWorktreeRoot(nonGit), null, 'non-git dir has no main worktree')
  } finally {
    rmSync(base, { recursive: true, force: true })
    rmSync(nonGit, { recursive: true, force: true })
  }
})

test('getMainWorktreeRoot returns the MAIN repo even from inside a linked worktree', () => {
  const { base, repoRoot } = makeRepo()
  try {
    const branch = branchNameFor('mainroot1', 'feature')
    const ref = addWorktree({ repoRoot, taskId: 'mainroot1', branch })
    // Compare git-derived paths to each other (git canonicalizes symlinks, e.g.
    // /var → /private/var on macOS, so don't compare against constructed paths).
    const wtToplevel = getRepoRoot(ref.worktreePath)        // the linked worktree
    const mainFromWt = getMainWorktreeRoot(ref.worktreePath) // should be the repo
    const repoCanonical = getRepoRoot(repoRoot)
    // From inside the linked worktree, getRepoRoot returns the worktree itself —
    // exactly the trap that caused the data-loss blocker...
    assert.notEqual(wtToplevel, mainFromWt, 'worktree toplevel must differ from the main root')
    // ...whereas getMainWorktreeRoot resolves back to the integration repo.
    assert.equal(mainFromWt, repoCanonical, 'main worktree root = the repo')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('addWorktree creates the branch and directory', () => {
  const { base, repoRoot } = makeRepo()
  try {
    const branch = branchNameFor('task1234', 'feature')
    const ref = addWorktree({ repoRoot, taskId: 'task1234', branch })
    assert.equal(ref.branch, branch)
    assert.ok(existsSync(ref.worktreePath), 'worktree dir should exist')
    const branches = g(repoRoot, 'branch', '--list', branch)
    assert.ok(branches.includes(branch), 'branch should exist')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('mergeWorktree returns merged:true for a clean (non-conflicting) change', async () => {
  const { base, repoRoot } = makeRepo()
  try {
    const branch = branchNameFor('clean1', 'feature')
    const ref = addWorktree({ repoRoot, taskId: 'clean1', branch })
    configureWorktreeUser(ref.worktreePath)
    // Add a NEW file in the worktree (uncommitted) — no overlap with main.
    writeFileSync(join(ref.worktreePath, 'feature.txt'), 'hello\n')

    const result = await mergeWorktree({ repoRoot, branch, worktreePath: ref.worktreePath })
    assert.deepEqual(result, { merged: true })
    assert.ok(existsSync(join(repoRoot, 'feature.txt')), 'merged file should land in repo root')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('mergeWorktree returns conflicts and leaves NO merge in progress on conflict', async () => {
  const { base, repoRoot } = makeRepo()
  try {
    const branch = branchNameFor('conf1', 'feature')
    const ref = addWorktree({ repoRoot, taskId: 'conf1', branch })
    configureWorktreeUser(ref.worktreePath)
    // Diverge: worktree edits file.txt (uncommitted), main edits the same line.
    writeFileSync(join(ref.worktreePath, 'file.txt'), 'worker change\n')
    writeFileSync(join(repoRoot, 'file.txt'), 'main change\n')
    g(repoRoot, 'commit', '-aqm', 'main change')

    const result = await mergeWorktree({ repoRoot, branch, worktreePath: ref.worktreePath })
    assert.equal(result.merged, false)
    assert.ok(!result.merged && result.conflicts.includes('file.txt'), 'should report the conflicting file')

    // The merge must have been aborted: no MERGE_HEAD, clean working tree.
    assert.throws(() => g(repoRoot, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), 'MERGE_HEAD should not exist')
    assert.equal(g(repoRoot, 'status', '--porcelain'), '', 'repo should be clean after abort')
    // Worktree is intentionally NOT removed on conflict.
    assert.ok(existsSync(ref.worktreePath), 'worktree kept for a fix worker')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('removeWorktree deletes the directory and the branch', async () => {
  const { base, repoRoot } = makeRepo()
  try {
    const branch = branchNameFor('rm1', 'feature')
    const ref = addWorktree({ repoRoot, taskId: 'rm1', branch })
    configureWorktreeUser(ref.worktreePath)
    writeFileSync(join(ref.worktreePath, 'feature.txt'), 'hi\n')
    await mergeWorktree({ repoRoot, branch, worktreePath: ref.worktreePath })

    removeWorktree({ repoRoot, worktreePath: ref.worktreePath, branch })
    assert.ok(!existsSync(ref.worktreePath), 'worktree dir should be gone')
    assert.equal(g(repoRoot, 'branch', '--list', branch), '', 'branch should be deleted')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('runExclusive serializes concurrent operations per key', async () => {
  const order: string[] = []
  const a = runExclusive('repoX', async () => {
    order.push('a-start')
    await delay(40)
    order.push('a-end')
  })
  const b = runExclusive('repoX', async () => {
    order.push('b-start')
    await delay(5)
    order.push('b-end')
  })
  await Promise.all([a, b])
  // b must not start until a fully finishes — proves the mutex serializes.
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'])
})

test('runExclusive survives a rejecting link without breaking the chain', async () => {
  const order: string[] = []
  const a = runExclusive('repoY', async () => { order.push('a'); throw new Error('boom') }).catch(() => {})
  const b = runExclusive('repoY', async () => { order.push('b') })
  await Promise.all([a, b])
  assert.deepEqual(order, ['a', 'b'])
})
