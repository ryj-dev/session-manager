import { app } from 'electron'
import { join } from 'path'
import { readFileSync, mkdirSync } from 'fs'
import { atomicWriteSync } from './atomic-write'

// Persisted composite/split-view groupings. Members are referenced by
// claudeSessionId (stable across restarts) rather than the per-launch PTY id,
// so a group survives a clean quit/relaunch and can be reconstructed once the
// corresponding sessions resume.

export interface SavedSplitGroup {
  id: string
  claudeSessionIds: string[]
  shapeId: string | null
}

interface SplitGroupsData {
  groups: SavedSplitGroup[]
}

function storePath(): string {
  const dir = join(app.getPath('userData'), 'state')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'composite-groups.json')
}

export function loadSplitGroups(): SavedSplitGroup[] {
  try {
    const data = readFileSync(storePath(), 'utf-8')
    const parsed: SplitGroupsData = JSON.parse(data)
    return parsed.groups || []
  } catch {
    return []
  }
}

export function saveSplitGroups(groups: SavedSplitGroup[]): void {
  const data: SplitGroupsData = { groups }
  atomicWriteSync(storePath(), JSON.stringify(data, null, 2))
}

export function clearSplitGroups(): void {
  saveSplitGroups([])
}
