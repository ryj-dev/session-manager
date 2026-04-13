import { app } from 'electron'
import { join } from 'path'
import { readFileSync, mkdirSync } from 'fs'
import { atomicWriteSync } from './atomic-write'

export interface SavedSession {
  claudeSessionId: string
  projectPath: string
  terminalTitle: string | null
  savedAt: number
}

interface SessionStoreData {
  sessions: SavedSession[]
}

function getStorePath(): string {
  const dir = join(app.getPath('userData'), 'state')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'sessions.json')
}

export function loadSavedSessions(): SavedSession[] {
  try {
    const data = readFileSync(getStorePath(), 'utf-8')
    const parsed: SessionStoreData = JSON.parse(data)
    return parsed.sessions || []
  } catch {
    return []
  }
}

export function saveSessions(sessions: SavedSession[]): void {
  const data: SessionStoreData = { sessions }
  atomicWriteSync(getStorePath(), JSON.stringify(data, null, 2))
}

export function clearSavedSessions(): void {
  saveSessions([])
}
