import { app } from 'electron'
import { join } from 'path'
import { readFileSync, mkdirSync } from 'fs'
import { atomicWriteSync } from './atomic-write'

export interface HotkeyMap {
  spawnSession: string
  spawnTerminal: string
  returnToGraph: string
  toggleExplorer: string
  toggleAgents: string
  toggleSkills: string
  toggleDesign: string
  openSettings: string
  toggleMemory: string
  toggleNotesProject: string
  toggleNotesGlobal: string
}

export const defaultHotkeys: HotkeyMap = {
  spawnSession: 't',
  spawnTerminal: 'shift+t',
  returnToGraph: 'w',
  toggleExplorer: 'e',
  toggleAgents: 'a',
  toggleSkills: 's',
  toggleDesign: 'd',
  openSettings: 'o',
  toggleMemory: 'm',
  toggleNotesProject: 'n',
  toggleNotesGlobal: 'shift+n',
}

export type MessagePopupMode = 'manual' | 'timed' | 'disabled'

export interface DisabledIntegrations {
  mcp?: boolean
  hooks?: boolean
  plugin?: boolean
}

export interface AppSettings {
  baseProjectsDir: string | null
  autoFocusOnSpawn: boolean
  persistExplorerPath: boolean
  explorerFollowsProject: boolean
  hotkeys: HotkeyMap
  messagePopup: MessagePopupMode
  messagePopupSeconds: number
  notesShowInactive?: boolean
  notesProjectViewDefault?: 'project' | 'global'
  notesZoom?: number
  disabledIntegrations?: DisabledIntegrations
}

const defaults: AppSettings = {
  baseProjectsDir: null,
  autoFocusOnSpawn: true,
  persistExplorerPath: true,
  explorerFollowsProject: true,
  hotkeys: { ...defaultHotkeys },
  messagePopup: 'manual',
  messagePopupSeconds: 15,
  notesShowInactive: false,
  notesProjectViewDefault: 'project',
  notesZoom: 1.15,
  disabledIntegrations: {},
}

export function setDisabledIntegration(key: keyof DisabledIntegrations, value: boolean): void {
  const current = loadSettings()
  const disabled: DisabledIntegrations = { ...(current.disabledIntegrations ?? {}) }
  if (value) disabled[key] = true
  else delete disabled[key]
  saveSettings({ ...current, disabledIntegrations: disabled })
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
    return { ...defaults, ...parsed, hotkeys: { ...defaults.hotkeys, ...parsed.hotkeys } }
  } catch {
    return { ...defaults }
  }
}

export function saveSettings(settings: AppSettings): void {
  atomicWriteSync(getSettingsPath(), JSON.stringify(settings, null, 2))
}
