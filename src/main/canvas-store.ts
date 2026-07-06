import { app } from 'electron'
import { join, dirname } from 'path'
import { readFileSync, mkdirSync, watch, type FSWatcher } from 'fs'
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
 *  most-recent MAX_CANVAS_ARTIFACTS globally (append order = chronological). */
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
  updateArtifacts((all) => [...all, artifact].slice(-MAX_CANVAS_ARTIFACTS))
  return artifact
}

/** Remove all artifacts for a session. Not called automatically (artifacts
 *  outlive sessions by design) — exported for a future "clear" affordance. */
export function deleteArtifactsForSession(sessionId: string): CanvasArtifact[] {
  return updateArtifacts((all) => all.filter((a) => a.sessionId !== sessionId))
}
