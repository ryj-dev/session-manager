import { app } from 'electron'
import { join, dirname } from 'path'
import { readFileSync, mkdirSync, watch, readdirSync, unlinkSync, type FSWatcher } from 'fs'
import { randomUUID } from 'crypto'
import { atomicWriteSync } from './atomic-write'
import { MAX_CANVAS_ARTIFACTS, type CanvasArtifact, type CanvasArtifactPayload, type CanvasArtifactSource } from './canvas-types'

// Source of truth for canvas artifacts (the declarative UI payloads sessions
// emit via the canvas-show MCP tool, plus auto-displayed user-sent images).
//
// Lives in the main process so that BOTH the renderer (via IPC) and the
// hook-server can read and mutate it. The renderer keeps a mirror, refreshed
// on the 'canvas:changed' broadcast (the broadcast lives in hook-server — NOT
// here). Same cache + fs.watch + atomic read-modify-write discipline as
// schedule-store.ts.
//
// This file is pure persistence: no IPC, no broadcasts, no validation.

interface CanvasData {
  artifacts: CanvasArtifact[]
}

let cache: CanvasArtifact[] | null = null
let watcher: FSWatcher | null = null

function storePath(): string {
  const dir = join(app.getPath('userData'), 'state')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'canvas.json')
}

/** Directory for images the app itself owns (clipboard pastes saved by the
 *  stash). ONLY files under this dir are ever garbage-collected — user-owned
 *  image paths referenced by artifacts are never touched. */
export function canvasImagesDir(): string {
  const dir = join(app.getPath('userData'), 'canvas-images')
  mkdirSync(dir, { recursive: true })
  return dir
}

function isOwnedImagePath(path: string | undefined): path is string {
  return !!path && dirname(path) === canvasImagesDir()
}

/** Best-effort unlink of an app-owned pasted-image file. */
function gcOwnedImage(path: string | undefined): void {
  if (!isOwnedImagePath(path)) return
  try { unlinkSync(path) } catch { /* already gone / locked — sweep catches it */ }
}

/** Parse the current on-disk artifact list. Never throws (missing/corrupt → []). */
function readArtifactsFromDisk(): CanvasArtifact[] {
  try {
    const parsed: CanvasData = JSON.parse(readFileSync(storePath(), 'utf-8'))
    return parsed.artifacts || []
  } catch {
    return []
  }
}

/** Watch canvas.json so any out-of-process write drops our cache. Best-effort. */
function ensureWatcher(): void {
  if (watcher) return
  try {
    watcher = watch(dirname(storePath()), { recursive: false }, (_event, filename) => {
      if (!filename || filename === 'canvas.json') cache = null
    })
    watcher.unref?.()
  } catch { /* watch is optional — mutators still read fresh from disk */ }
}

function loadArtifacts(): CanvasArtifact[] {
  ensureWatcher()
  if (cache) return cache
  cache = readArtifactsFromDisk()
  return cache
}

function persist(artifacts: CanvasArtifact[]): CanvasArtifact[] {
  cache = artifacts
  atomicWriteSync(storePath(), JSON.stringify({ artifacts }, null, 2))
  return artifacts
}

/** Atomic read-modify-write keyed off the CURRENT on-disk state — the single
 *  write path for every mutator (see schedule-store.ts for the rationale). */
function updateArtifacts(fn: (artifacts: CanvasArtifact[]) => CanvasArtifact[]): CanvasArtifact[] {
  ensureWatcher()
  return persist(fn(readArtifactsFromDisk()))
}

// ── Reads ────────────────────────────────────────────────────────────────────

export function getArtifacts(): CanvasArtifact[] {
  return loadArtifacts()
}

/** Lookup by id — the canvas:// protocol handler serves image files ONLY via
 *  this (id → registered path), never from a caller-supplied path. */
export function getArtifactById(id: string): CanvasArtifact | undefined {
  return loadArtifacts().find((a) => a.id === id)
}

export function getArtifactsForSession(sessionId: string, claudeSessionId?: string | null): CanvasArtifact[] {
  return loadArtifacts().filter(
    (a) => a.sessionId === sessionId || (claudeSessionId != null && a.claudeSessionId === claudeSessionId),
  )
}

// ── Mutators ─────────────────────────────────────────────────────────────────

/** Append a validated artifact. Stamps id + createdAt and prunes to the
 *  most-recent MAX_CANVAS_ARTIFACTS globally (append order = chronological).
 *  Pruned artifacts whose image file lives in canvas-images/ (clipboard
 *  pastes) have that file deleted — it can never be referenced again. */
export function addArtifact(
  payload: CanvasArtifactPayload,
  meta: { sessionId: string; claudeSessionId: string | null; source: CanvasArtifactSource },
): CanvasArtifact {
  const artifact = {
    ...payload,
    ...meta,
    id: randomUUID(),
    createdAt: Date.now(),
  } as CanvasArtifact
  updateArtifacts((all) => {
    const next = [...all, artifact]
    const dropped = next.slice(0, Math.max(0, next.length - MAX_CANVAS_ARTIFACTS))
    for (const d of dropped) {
      if ('image' in d) gcOwnedImage(d.image.path)
    }
    return next.slice(-MAX_CANVAS_ARTIFACTS)
  })
  return artifact
}

/** Startup sweep: delete files in canvas-images/ that no artifact references —
 *  clipboard pastes that were never confirmed by a submit (app quit mid-prompt)
 *  or whose artifact was pruned by an older build. Call once from app ready. */
export function sweepOrphanedImages(): void {
  try {
    const dir = canvasImagesDir()
    const referenced = new Set(
      loadArtifacts().flatMap((a) => ('image' in a ? [a.image.path] : [])),
    )
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (!referenced.has(full)) {
        try { unlinkSync(full) } catch { /* best-effort */ }
      }
    }
  } catch { /* dir unreadable — nothing to sweep */ }
}

/** Remove all artifacts for a session. Not called automatically (artifacts
 *  outlive sessions by design) — exported for a future "clear" affordance. */
export function deleteArtifactsForSession(sessionId: string): CanvasArtifact[] {
  return updateArtifacts((all) => {
    for (const a of all) {
      if (a.sessionId === sessionId && 'image' in a) gcOwnedImage(a.image.path)
    }
    return all.filter((a) => a.sessionId !== sessionId)
  })
}
