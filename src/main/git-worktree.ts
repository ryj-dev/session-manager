// Git worktree lifecycle for the agentic pipeline's parallel fan-out.
//
// When the orchestrator fans out implementation across several workers, each
// worker can build in an ISOLATED git worktree on its own branch. When a worker
// finishes, its branch is merged back into the integration branch and the
// worktree is removed — at which point the worker's pipeline node becomes
// read-only (Option B: worktrees are read-only AFTER merge).
//
// Everything shells out to `git` via execFileSync (`git -C <dir> ...`). The
// module deliberately depends only on Node built-ins (no electron) so it can be
// unit-tested against a throwaway temp repo.

import { execFileSync } from 'child_process'
import { join } from 'path'

/** Typed error so callers (hook-server) can surface a clean milestone/warning. */
export class GitWorktreeError extends Error {
  readonly detail?: string
  constructor(message: string, detail?: string) {
    super(message)
    this.name = 'GitWorktreeError'
    this.detail = detail
  }
}

// The Electron main process often starts with a minimal PATH. Augment it with
// the common locations git lives in so `git` resolves without a login shell.
const GIT_PATH = [
  process.env.PATH || '',
  '/usr/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
].filter(Boolean).join(':')

interface GitResult {
  status: number
  stdout: string
  stderr: string
}

/** Run a git command. Never throws on non-zero exit — returns the captured
 *  status/stdout/stderr so callers can branch on it (e.g. merge conflicts). */
function git(args: string[]): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: GIT_PATH },
    })
    return { status: 0, stdout: stdout.toString(), stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; message?: string }
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : (e.message ?? ''),
    }
  }
}

/** Resolve the repository root for a directory, or null if it isn't a repo.
 *  NOTE: from inside a LINKED worktree this returns the worktree's own root,
 *  not the main repo — use `getMainWorktreeRoot` when you need the integration
 *  repo (e.g. for merging). */
export function getRepoRoot(dir: string): string | null {
  const r = git(['-C', dir, 'rev-parse', '--show-toplevel'])
  if (r.status !== 0) return null
  const root = r.stdout.trim()
  return root || null
}

/** Resolve the MAIN (primary) worktree root for any dir inside the repo — even
 *  when `dir` is itself a linked worktree (where `rev-parse --show-toplevel`
 *  would return the worktree, not the repo). `git worktree list` always lists
 *  the main worktree FIRST. Returns null if `dir` isn't a git repo.
 *
 *  Critical for merge/cleanup: merging "into" a worktree path is a no-op
 *  ("already up to date") that would silently report success and then
 *  force-delete the worktree — i.e. data loss. Always integrate into the main
 *  worktree. */
export function getMainWorktreeRoot(dir: string): string | null {
  const r = git(['-C', dir, 'worktree', 'list', '--porcelain'])
  if (r.status !== 0) return null
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      const p = line.slice('worktree '.length).trim()
      return p || null
    }
  }
  return null
}

/** Sanitize a single label into a git-ref-safe path component (no slashes). */
export function sanitizeBranch(label: string): string {
  const cleaned = (label || 'worker')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/\.+$/g, '') // git refs may not end with a dot
  return cleaned || 'worker'
}

/** Full namespaced branch name for a worker: `pipeline/<taskShort>/<label>`.
 *  Namespacing prevents collisions across tasks/workers in the same repo. */
export function branchNameFor(taskId: string, label: string): string {
  const taskShort = sanitizeBranch(String(taskId).slice(0, 8)) || 'task'
  return `pipeline/${taskShort}/${sanitizeBranch(label)}`
}

/** Deterministic worktree path — a SIBLING of the repo (under
 *  `../.pipeline-worktrees/<taskId>/<sanitized-branch>`) to avoid nested-git and
 *  cross-volume issues that arise from placing worktrees inside the repo. */
export function worktreePathFor(repoRoot: string, taskId: string, branch: string): string {
  const safeTask = sanitizeBranch(String(taskId).slice(0, 16)) || 'task'
  const safeBranch = branch.replace(/[/\\]/g, '-').replace(/[^a-z0-9._-]+/gi, '-')
  return join(repoRoot, '..', '.pipeline-worktrees', safeTask, safeBranch)
}

export interface AddWorktreeOpts {
  repoRoot: string
  taskId: string
  /** Full branch name (typically from branchNameFor). */
  branch: string
  /** Base ref to branch from. Defaults to HEAD. */
  baseRef?: string
}

export interface WorktreeRef {
  worktreePath: string
  branch: string
}

/** Create a new worktree on a fresh branch (or check out an existing branch
 *  into a worktree if the branch already exists). */
export function addWorktree(opts: AddWorktreeOpts): WorktreeRef {
  const { repoRoot, taskId, branch, baseRef } = opts
  const worktreePath = worktreePathFor(repoRoot, taskId, branch)

  // Preferred: create the branch and worktree in one step.
  let r = git(['-C', repoRoot, 'worktree', 'add', '-b', branch, worktreePath, baseRef || 'HEAD'])
  if (r.status === 0) return { worktreePath, branch }

  // Fallback: the branch already exists — check it out into a worktree.
  const r2 = git(['-C', repoRoot, 'worktree', 'add', worktreePath, branch])
  if (r2.status === 0) return { worktreePath, branch }

  throw new GitWorktreeError(
    `Failed to create worktree for branch ${branch}`,
    [r.stderr, r2.stderr].filter(Boolean).join(' | '),
  )
}

export interface MergeWorktreeOpts {
  repoRoot: string
  branch: string
  worktreePath: string
}

export type MergeResult =
  | { merged: true }
  | { merged: false; conflicts: string[] }

// ── Per-repo merge mutex ─────────────────────────────────────────────────────
// Two workers must never merge into the integration branch concurrently. We
// serialize per-repoRoot with an in-process promise chain.

const repoChains = new Map<string, Promise<unknown>>()

/** Run `fn` exclusively with respect to other callers for the same repoRoot.
 *  Calls are serialized in arrival order; a rejection doesn't break the chain. */
export function runExclusive<T>(repoRoot: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = repoChains.get(repoRoot) ?? Promise.resolve()
  const next = prev.then(() => fn(), () => fn())
  // Keep the chain alive even if this link rejects.
  repoChains.set(repoRoot, next.then(() => undefined, () => undefined))
  return next
}

/** Merge a worker's branch back into the integration branch (the repo's current
 *  HEAD branch). Auto-commits dirty worktree changes first (best-effort). On a
 *  merge conflict, aborts the merge (leaving the repo clean) and returns the
 *  conflicting files WITHOUT removing the worktree, so a fix worker can resolve.
 *  Serialized per-repo via the merge mutex. */
export function mergeWorktree(opts: MergeWorktreeOpts): Promise<MergeResult> {
  const { repoRoot, branch, worktreePath } = opts
  return runExclusive(repoRoot, () => {
    // (0) Idempotency backstop. Completion can run twice against the same task —
    //     under `auto`, the approval auto-advance merges + prunes the branch, then
    //     the orchestrator's explicit set-stage 'done' fires a SECOND completion.
    //     By then the branch is gone, so `git merge` errors out with zero
    //     conflicting files and would be misreported as a conflict (overwriting a
    //     genuinely-merged task with integrationStatus:'conflict'). A branch we can
    //     no longer resolve was already merged + pruned by the first pass — there is
    //     nothing left to do, so report success.
    if (git(['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${branch}^{commit}`]).status !== 0) {
      return { merged: true }
    }

    // (a) Commit any uncommitted work in the worktree so the merge sees it.
    //     Verify the commit actually captured it — a failed commit (e.g. no git
    //     identity configured) would otherwise let us merge an INCOMPLETE branch
    //     and then delete the worktree, silently losing the worker's latest work.
    const dirty = git(['-C', worktreePath, 'status', '--porcelain'])
    if (dirty.status === 0 && dirty.stdout.trim()) {
      git(['-C', worktreePath, 'add', '-A'])
      const commit = git(['-C', worktreePath, 'commit', '-m', `pipeline: ${branch} wip`])
      if (commit.status !== 0) {
        const recheck = git(['-C', worktreePath, 'status', '--porcelain'])
        // Still dirty after committing → the commit genuinely failed; refuse to
        // merge incomplete work rather than lose it.
        if (recheck.status !== 0 || recheck.stdout.trim()) {
          throw new GitWorktreeError(
            `Failed to commit worktree changes for ${branch} before merge`,
            commit.stderr || commit.stdout,
          )
        }
      }
    }

    // (b) Merge the branch into the integration branch.
    const merge = git(['-C', repoRoot, 'merge', '--no-ff', '--no-edit', branch])
    if (merge.status === 0) return { merged: true }

    // (c) Non-zero: distinguish a real conflict from another failure.
    const unmerged = git(['-C', repoRoot, 'diff', '--name-only', '--diff-filter=U'])
    const conflicts = unmerged.stdout.split('\n').map((s) => s.trim()).filter(Boolean)

    // Abort so the integration branch is left clean regardless of cause.
    git(['-C', repoRoot, 'merge', '--abort'])

    if (conflicts.length > 0) return { merged: false, conflicts }

    throw new GitWorktreeError(
      `Merge of ${branch} failed`,
      merge.stderr || merge.stdout,
    )
  })
}

export interface RemoveWorktreeOpts {
  repoRoot: string
  worktreePath: string
  branch: string
}

/** Remove a worktree and delete its branch (best-effort), then prune stale
 *  worktree metadata. Safe to call even if some steps have already happened. */
export function removeWorktree(opts: RemoveWorktreeOpts): void {
  const { repoRoot, worktreePath, branch } = opts
  // Force-remove the worktree (it may hold uncommitted/untracked files).
  git(['-C', repoRoot, 'worktree', 'remove', worktreePath, '--force'])
  // Delete the now-merged branch (best-effort — swallow if not fully merged).
  git(['-C', repoRoot, 'branch', '-d', branch])
  // Clean up any dangling worktree administrative entries.
  git(['-C', repoRoot, 'worktree', 'prune'])
}

// ── Diff resolution (send-to-review) ─────────────────────────────────────────
// The send-to-review flow reviews work done OUTSIDE the pipeline. The diff is
// resolved from git — either the uncommitted working tree, or a committed
// base...target range — and handed to the orchestrator as the review subject.

/** Where a diff is sourced from. Mirrors the `DiffSource` type in
 *  pipeline-store.ts (kept duplicated here so this module stays electron-free
 *  and independently unit-testable). */
export type DiffSource =
  | { kind: 'working-tree' }
  | { kind: 'range'; base: string; target: string }

export interface DiffResult {
  ok: boolean
  diff: string        // unified diff text (possibly truncated)
  files: string[]     // changed file paths
  status?: string     // `git status --porcelain` (working-tree only)
  empty: boolean      // resolved cleanly but no changes
  truncated?: boolean // diff exceeded the size cap
  error?: string      // not-a-repo / bad ref / etc.
}

/** Cap the diff size. Past this the returned `diff` is truncated and
 *  `truncated` is set; the caller stores this (capped) string as the `diff`
 *  artifact and emits a truncation milestone + a note in the review prompt, so
 *  the cut is surfaced rather than silent. */
const DIFF_CAP_BYTES = 200_000

/** Apply the size cap to a diff string, flagging truncation. */
function capDiff(diff: string): { diff: string; truncated: boolean } {
  if (diff.length <= DIFF_CAP_BYTES) return { diff, truncated: false }
  return { diff: diff.slice(0, DIFF_CAP_BYTES), truncated: true }
}

/** Diff the uncommitted working tree (staged + unstaged + untracked) against
 *  HEAD. Runs in `dir` directly — used by review-in-place, so it must see the
 *  real edits, not a clean worktree checkout. */
export function workingTreeDiff(dir: string): DiffResult {
  const top = git(['-C', dir, 'rev-parse', '--show-toplevel'])
  if (top.status !== 0) {
    return { ok: false, diff: '', files: [], empty: true, error: 'not a git repository' }
  }

  // Tracked changes (staged + unstaged) vs HEAD.
  const tracked = git(['-C', dir, 'diff', 'HEAD'])
  const names = git(['-C', dir, 'diff', '--name-only', 'HEAD'])
  const trackedFiles = names.stdout.split('\n').map((s) => s.trim()).filter(Boolean)

  // Untracked files: surface them as "new file" diffs so reviewers can see
  // brand-new code without mutating the index. `--no-index` exits 1 but emits a
  // valid diff; the null device differs per platform.
  //
  // `-z --untracked-files=all` is essential: `-z` gives NUL-separated, UNQUOTED
  // paths (default porcelain C-quotes non-ASCII/special names, which would then
  // not be a real path and get silently skipped), and `--untracked-files=all`
  // expands a new directory into its individual files (default collapses it to a
  // single `?? newdir/` entry whose `--no-index` diff errors, hiding every file
  // inside). Tokens must NOT be trimmed — filenames can have leading/trailing
  // spaces. Each NUL-delimited porcelain entry is `XY <path>`; for `??` strip the
  // 3-char `?? ` prefix.
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
  const status = git(['-C', dir, 'status', '--porcelain', '-z', '--untracked-files=all'])
  const untracked: string[] = []
  let untrackedDiff = ''
  if (status.status === 0) {
    for (const entry of status.stdout.split('\0')) {
      if (!entry) continue
      if (entry.startsWith('?? ')) {
        const file = entry.slice(3)
        if (!file) continue
        untracked.push(file)
        const nd = git(['-C', dir, 'diff', '--no-index', '--', nullDevice, file])
        if (nd.stdout) untrackedDiff += nd.stdout
      }
    }
  }

  const combined = tracked.stdout + untrackedDiff
  const files = [...trackedFiles, ...untracked]
  const empty = !tracked.stdout.trim() && untracked.length === 0
  const { diff, truncated } = capDiff(combined)
  return {
    ok: true,
    diff,
    files,
    status: status.status === 0 ? status.stdout : undefined,
    empty,
    truncated,
  }
}

/** Diff a committed range `base...target` (three-dot = changes on target since
 *  the merge-base — the "what this branch added" semantics). Read-only: needs
 *  no checkout, so it runs against the main repo root. */
export function rangeDiff(repoRoot: string, base: string, target: string): DiffResult {
  for (const ref of [base, target]) {
    if (git(['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status !== 0) {
      return { ok: false, diff: '', files: [], empty: true, error: `unknown ref ${ref}` }
    }
  }
  const spec = `${base}...${target}`
  const d = git(['-C', repoRoot, 'diff', spec])
  const names = git(['-C', repoRoot, 'diff', '--name-only', spec])
  const files = names.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  const empty = !d.stdout.trim()
  const { diff, truncated } = capDiff(d.stdout)
  return { ok: true, diff, files, empty, truncated }
}

/** Resolve a diff per its source descriptor. Working-tree reads `ctx.workdir`
 *  (the real project dir, where uncommitted edits live); range reads
 *  `ctx.repoRoot` read-only. */
export function resolveDiff(source: DiffSource, ctx: { workdir: string; repoRoot: string }): DiffResult {
  return source.kind === 'working-tree'
    ? workingTreeDiff(ctx.workdir)
    : rangeDiff(ctx.repoRoot, source.base, source.target)
}
