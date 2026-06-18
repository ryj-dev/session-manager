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
  workingTreeDiff,
  rangeDiff,
  resolveDiff,
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

test('mergeWorktree is idempotent — a second pass after merge+prune reports merged:true', async () => {
  const { base, repoRoot } = makeRepo()
  try {
    const branch = branchNameFor('idem1', 'feature')
    const ref = addWorktree({ repoRoot, taskId: 'idem1', branch })
    configureWorktreeUser(ref.worktreePath)
    writeFileSync(join(ref.worktreePath, 'feature.txt'), 'hello\n')

    // First completion: merge + prune (as finalizeTaskCompletion does on success).
    const first = await mergeWorktree({ repoRoot, branch, worktreePath: ref.worktreePath })
    assert.deepEqual(first, { merged: true })
    removeWorktree({ repoRoot, worktreePath: ref.worktreePath, branch })
    assert.equal(g(repoRoot, 'branch', '--list', branch), '', 'branch pruned after first pass')

    // Second completion (the `auto`-mode double-fire): the branch is gone. This must
    // NOT be misreported as a conflict — the work is already integrated.
    const second = await mergeWorktree({ repoRoot, branch, worktreePath: ref.worktreePath })
    assert.deepEqual(second, { merged: true }, 'a re-run against a pruned branch is a no-op success')
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

// ── Diff helpers: workingTreeDiff / rangeDiff / resolveDiff ──────────────────

test('workingTreeDiff on a non-git dir → ok:false, not a git repository', () => {
  const nonGit = mkdtempSync(join(tmpdir(), 'sm-nogit-'))
  try {
    const r = workingTreeDiff(nonGit)
    assert.equal(r.ok, false)
    assert.equal(r.error, 'not a git repository')
    assert.equal(r.empty, true)
  } finally {
    rmSync(nonGit, { recursive: true, force: true })
  }
})

test('workingTreeDiff on a clean repo → ok:true, empty:true, no files', () => {
  const { base, repoRoot } = makeRepo()
  try {
    const r = workingTreeDiff(repoRoot)
    assert.equal(r.ok, true)
    assert.equal(r.empty, true)
    assert.deepEqual(r.files, [])
    assert.equal(r.diff, '')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('workingTreeDiff surfaces a modified tracked file', () => {
  const { base, repoRoot } = makeRepo()
  try {
    writeFileSync(join(repoRoot, 'file.txt'), 'base\nmodified line\n')
    const r = workingTreeDiff(repoRoot)
    assert.equal(r.ok, true)
    assert.equal(r.empty, false)
    assert.ok(r.files.includes('file.txt'), 'changed tracked file listed')
    assert.match(r.diff, /modified line/, 'diff contains the new hunk')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('workingTreeDiff surfaces untracked files — top-level, in a NEW dir, and special/non-ASCII names (B2)', () => {
  const { base, repoRoot } = makeRepo()
  try {
    // (a) plain new top-level file
    writeFileSync(join(repoRoot, 'new.txt'), 'brand new\n')
    // (b) a file inside a BRAND-NEW directory — default porcelain collapses this
    // to `?? newdir/`; --untracked-files=all must expand it to the file path.
    mkdirSync(join(repoRoot, 'newdir'))
    writeFileSync(join(repoRoot, 'newdir', 'inside.txt'), 'nested new\n')
    // (c) a name with a space AND a non-ASCII char — default porcelain C-quotes
    // this; `-z` must deliver it verbatim so --no-index produces a real diff.
    const special = 'spécial file.txt'
    writeFileSync(join(repoRoot, special), 'accented new\n')

    const r = workingTreeDiff(repoRoot)
    assert.equal(r.ok, true)
    assert.equal(r.empty, false)
    assert.ok(r.files.includes('new.txt'), 'top-level untracked file listed')
    assert.ok(r.files.includes('newdir/inside.txt'), 'file inside a new dir listed (not the collapsed dir)')
    assert.ok(!r.files.includes('newdir/'), 'the collapsed directory entry must NOT appear')
    assert.ok(r.files.includes(special), 'special/non-ASCII name listed verbatim')
    assert.match(r.diff, /brand new/, 'top-level new file content in diff')
    assert.match(r.diff, /nested new/, 'new-dir file content in diff')
    assert.match(r.diff, /accented new/, 'special-name file content in diff')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('rangeDiff with a bad ref → ok:false, unknown ref', () => {
  const { base, repoRoot } = makeRepo()
  try {
    const r = rangeDiff(repoRoot, 'no-such-ref', 'HEAD')
    assert.equal(r.ok, false)
    assert.equal(r.error, 'unknown ref no-such-ref')
    assert.equal(r.empty, true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('rangeDiff over base...target reports target-only changes; identical refs → empty', () => {
  const { base, repoRoot } = makeRepo()
  try {
    const baseSha = g(repoRoot, 'rev-parse', 'HEAD')
    writeFileSync(join(repoRoot, 'feature.txt'), 'feature work\n')
    g(repoRoot, 'add', '-A')
    g(repoRoot, 'commit', '-q', '-m', 'add feature')
    const targetSha = g(repoRoot, 'rev-parse', 'HEAD')

    const r = rangeDiff(repoRoot, baseSha, targetSha)
    assert.equal(r.ok, true)
    assert.equal(r.empty, false)
    assert.ok(r.files.includes('feature.txt'), 'the target-only file is listed')
    assert.match(r.diff, /feature work/, 'diff contains the added content')

    const identical = rangeDiff(repoRoot, targetSha, targetSha)
    assert.equal(identical.ok, true)
    assert.equal(identical.empty, true, 'identical refs produce an empty diff')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('resolveDiff dispatches for both working-tree and range sources', () => {
  const { base, repoRoot } = makeRepo()
  try {
    // working-tree dispatch → workingTreeDiff
    writeFileSync(join(repoRoot, 'file.txt'), 'base\nwt change\n')
    const wt = resolveDiff({ kind: 'working-tree' }, { workdir: repoRoot, repoRoot })
    assert.equal(wt.ok, true)
    assert.equal(wt.empty, false)
    assert.match(wt.diff, /wt change/)

    // range dispatch → rangeDiff
    const baseSha = g(repoRoot, 'rev-parse', 'HEAD')
    g(repoRoot, 'add', '-A')
    g(repoRoot, 'commit', '-q', '-m', 'commit wt change')
    const targetSha = g(repoRoot, 'rev-parse', 'HEAD')
    const range = resolveDiff(
      { kind: 'range', base: baseSha, target: targetSha },
      { workdir: repoRoot, repoRoot },
    )
    assert.equal(range.ok, true)
    assert.ok(range.files.includes('file.txt'))
    assert.match(range.diff, /wt change/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
