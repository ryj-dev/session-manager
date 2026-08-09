/**
 * Repo discovery for the code index.
 *
 * Sources: top-level entries of the base projects directory that are git
 * repos, plus the cwd of every live session (normalised to the main worktree
 * root so pipeline worktrees index into their repo's rows, not as their own
 * repos). The `excludedRepos` policy is applied here so an excluded repo is
 * invisible to indexing and to every scope, including fleet.
 */

import fs from 'node:fs'
import path from 'node:path'
import { getMainWorktreeRoot } from '../git-worktree'

export interface DiscoveredRepo {
  /** Canonical main-worktree root (realpath). */
  root: string
  name: string
  source: 'baseDir' | 'session'
}

export interface DiscoveryInputs {
  baseProjectsDir: string | null
  sessionCwds: string[]
  excludedRepos: string[]
}

function isGitRepoRoot(dir: string): boolean {
  try {
    // .git is a directory in a normal checkout, a FILE in worktrees/submodules.
    return fs.existsSync(path.join(dir, '.git'))
  } catch {
    return false
  }
}

function canonical(dir: string): string | null {
  try {
    return fs.realpathSync(dir)
  } catch {
    return null
  }
}

/** Normalise any directory (possibly a worktree, possibly nested) to its
 *  main repo root. Returns null for non-git directories. */
export function normalizeToRepoRoot(dir: string): string | null {
  const root = getMainWorktreeRoot(dir)
  if (!root) return null
  if (root.split(path.sep).includes('.pipeline-worktrees')) return null
  return canonical(root)
}

export function discoverRepos(inputs: DiscoveryInputs): DiscoveredRepo[] {
  const excluded = new Set(
    inputs.excludedRepos.map((r) => canonical(r) ?? r)
  )
  const seen = new Map<string, DiscoveredRepo>()

  const add = (root: string | null, source: DiscoveredRepo['source']): void => {
    if (!root || excluded.has(root) || seen.has(root)) return
    seen.set(root, { root, name: path.basename(root), source })
  }

  if (inputs.baseProjectsDir) {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(inputs.baseProjectsDir, { withFileTypes: true })
    } catch {
      /* base dir unreadable — sessions still discovered below */
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.')) continue
      const dir = path.join(inputs.baseProjectsDir, entry.name)
      if (!isGitRepoRoot(dir)) continue
      // Normalise through git: a top-level entry can itself be a linked
      // worktree (.git file), which must index into its main repo instead.
      add(normalizeToRepoRoot(dir), 'baseDir')
    }
  }

  for (const cwd of inputs.sessionCwds) {
    add(normalizeToRepoRoot(cwd), 'session')
  }

  return [...seen.values()]
}
