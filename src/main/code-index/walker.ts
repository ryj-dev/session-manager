/**
 * Per-repo file enumeration for the code index.
 *
 * Delegates ignore logic entirely to git (`ls-files --exclude-standard`):
 * nested .gitignore files, negations, global excludes all behave exactly as
 * the user expects, and gitignored files (.env, dist/, node_modules/) are
 * out by construction. Untracked-but-not-ignored files are included so a
 * brand-new file is searchable before its first commit.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface WalkedFile {
  relPath: string
  absPath: string
  size: number
  mtime: number
  lang: string | null
}

export interface WalkResult {
  files: WalkedFile[]
  /** Files dropped by the per-repo cap (not by size/vendor filters). */
  truncated: boolean
  skippedOversize: number
}

export const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  // Indexed as fixed-window text chunks (no symbols) — still searchable.
  '.md': 'text',
  '.json': 'text',
  '.yaml': 'text',
  '.yml': 'text',
  '.toml': 'text',
  '.sh': 'text',
  '.zsh': 'text',
  '.sql': 'text',
  '.go': 'text',
  '.rs': 'text',
  '.rb': 'text',
  '.java': 'text',
  '.css': 'text',
  '.html': 'text',
  '.graphql': 'text',
  '.prisma': 'text'
}

// Belt-and-braces for repos that commit their build output or vendored deps.
const EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'out',
  'build',
  'target',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.pipeline-worktrees'
])

const EXCLUDED_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'uv.lock',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock'
])

/** True when the rel path should be skipped regardless of git tracking. */
export function isVendoredOrGenerated(relPath: string): boolean {
  const parts = relPath.split('/')
  const base = parts[parts.length - 1]
  if (EXCLUDED_FILES.has(base)) return true
  if (/\.min\.(js|css)$/.test(base)) return true
  for (let i = 0; i < parts.length - 1; i++) {
    if (EXCLUDED_SEGMENTS.has(parts[i])) return true
  }
  return false
}

/** Cheap binary sniff: NUL byte in the first 8KB. */
export function looksBinary(absPath: string): boolean {
  let fd: number | null = null
  try {
    fd = fs.openSync(absPath, 'r')
    const buf = Buffer.alloc(8192)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true
    return false
  } catch {
    return true // unreadable → treat as binary, skip
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

export function langForPath(relPath: string): string | null {
  return LANG_BY_EXT[path.extname(relPath).toLowerCase()] ?? null
}

export interface WalkOptions {
  maxFileBytes: number
  maxFiles: number
}

export function listRepoFiles(repoRoot: string, opts: WalkOptions): WalkResult {
  let stdout: string
  try {
    stdout = execFileSync(
      'git',
      ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    )
  } catch (err) {
    throw new Error(`git ls-files failed in ${repoRoot}: ${err instanceof Error ? err.message : err}`)
  }

  const candidates: WalkedFile[] = []
  let skippedOversize = 0
  for (const relPath of stdout.split('\0')) {
    if (!relPath) continue
    const lang = langForPath(relPath)
    if (lang === null) continue
    if (isVendoredOrGenerated(relPath)) continue
    const absPath = path.join(repoRoot, relPath)
    let st: fs.Stats
    try {
      st = fs.statSync(absPath)
    } catch {
      continue // deleted-but-tracked; skip
    }
    if (!st.isFile()) continue
    if (st.size > opts.maxFileBytes) {
      skippedOversize++
      continue
    }
    if (looksBinary(absPath)) continue
    candidates.push({
      relPath,
      absPath,
      size: st.size,
      mtime: Math.floor(st.mtimeMs),
      lang
    })
  }

  // Over the cap: keep the newest N (most likely to be queried) and say so.
  let truncated = false
  let files = candidates
  if (candidates.length > opts.maxFiles) {
    truncated = true
    files = [...candidates].sort((a, b) => b.mtime - a.mtime).slice(0, opts.maxFiles)
  }
  return { files, truncated, skippedOversize }
}

/** HEAD commit hash, or null when unavailable (empty repo, not git). */
export function headCommit(repoRoot: string): string | null {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/**
 * Rel paths touched since the last commit (staged, unstaged, untracked).
 * Cheap staleness probe for app-start reindexing. null = git unavailable.
 */
export function changedSince(repoRoot: string): string[] | null {
  let stdout: string
  try {
    stdout = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '-z'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    })
  } catch {
    return null
  }
  const out: string[] = []
  // -z format: XY <path>\0, with renames emitting a second NUL-separated path.
  const entries = stdout.split('\0').filter(Boolean)
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    out.push(entry.slice(3))
    if (xy[0] === 'R' || xy[0] === 'C') {
      // rename/copy: next entry is the origin path — include it too so the
      // old location's rows get removed, then skip past it.
      const origin = entries[i + 1]
      if (origin) out.push(origin)
      i++
    }
  }
  return out
}
