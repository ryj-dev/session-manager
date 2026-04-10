import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'

export interface HotkeyMap {
  spawnSession: string
  spawnTerminal: string
  returnToGraph: string
  toggleExplorer: string
  toggleAgents: string
  toggleSkills: string
  toggleDesign: string
  openSettings: string
}

export const defaultHotkeys: HotkeyMap = {
  spawnSession: 't',
  spawnTerminal: 'shift+t',
  returnToGraph: 'w',
  toggleExplorer: 'e',
  toggleAgents: 'a',
  toggleSkills: 's',
  toggleDesign: 'd',
  openSettings: 'o'
}

export interface AppSettings {
  baseProjectsDir: string | null
  autoFocusOnSpawn: boolean
  persistExplorerPath: boolean
  explorerFollowsProject: boolean
  hotkeys: HotkeyMap
}

const defaults: AppSettings = {
  baseProjectsDir: null,
  autoFocusOnSpawn: true,
  persistExplorerPath: true,
  explorerFollowsProject: true,
  hotkeys: { ...defaultHotkeys }
}

function getSettingsPath(): string {
  const dir = join(app.getPath('userData'), 'state')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'settings.json')
}

export function loadSettings(): AppSettings {
  try {
    const data = readFileSync(getSettingsPath(), 'utf-8')
    const parsed = JSON.parse(data)
    return { ...defaults, ...parsed }
  } catch {
    return { ...defaults }
  }
}

export function saveSettings(settings: AppSettings): void {
  writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2))
}
