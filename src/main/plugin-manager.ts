import { app } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync, cpSync, rmSync, readFileSync, existsSync } from 'fs'
import { atomicWriteSync } from './atomic-write'

const PLUGIN_NAME = 'session-manager@local'
const PLUGIN_VERSION = '1.0.0'

function getPluginInstallPath(): string {
  return join(app.getPath('userData'), 'plugin')
}

function getInstalledPluginsPath(): string {
  return join(homedir(), '.claude', 'plugins', 'installed_plugins.json')
}

function getSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

function getPluginSourcePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', 'plugin')
    : join(app.getAppPath(), 'resources', 'plugin')
}

export function installPlugin(): void {
  const installPath = getPluginInstallPath()
  const sourcePath = getPluginSourcePath()

  // Copy plugin files to app data
  mkdirSync(installPath, { recursive: true })
  cpSync(sourcePath, installPath, { recursive: true })

  // Register in installed_plugins.json
  const pluginsPath = getInstalledPluginsPath()
  let pluginsFile: { version: number; plugins: Record<string, unknown[]> } = { version: 2, plugins: {} }
  try {
    pluginsFile = JSON.parse(readFileSync(pluginsPath, 'utf-8'))
  } catch { /* file doesn't exist yet */ }

  const now = new Date().toISOString()
  pluginsFile.plugins[PLUGIN_NAME] = [{
    scope: 'user',
    installPath,
    version: PLUGIN_VERSION,
    installedAt: now,
    lastUpdated: now,
  }]

  mkdirSync(join(homedir(), '.claude', 'plugins'), { recursive: true })
  atomicWriteSync(pluginsPath, JSON.stringify(pluginsFile, null, 2) + '\n')

  // Enable in settings.json
  const settingsPath = getSettingsPath()
  let settings: Record<string, unknown> = {}
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  } catch { /* file doesn't exist */ }

  const enabled = (settings.enabledPlugins ?? {}) as Record<string, boolean>
  enabled[PLUGIN_NAME] = true
  settings.enabledPlugins = enabled
  atomicWriteSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')

  console.log('[plugin-manager] installed plugin at', installPath)
}

export function uninstallPlugin(): void {
  // Remove from installed_plugins.json
  const pluginsPath = getInstalledPluginsPath()
  try {
    if (existsSync(pluginsPath)) {
      const pluginsFile = JSON.parse(readFileSync(pluginsPath, 'utf-8'))
      delete pluginsFile.plugins?.[PLUGIN_NAME]
      atomicWriteSync(pluginsPath, JSON.stringify(pluginsFile, null, 2) + '\n')
    }
  } catch { /* non-critical */ }

  // Remove from settings.json enabledPlugins
  const settingsPath = getSettingsPath()
  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      if (settings.enabledPlugins) {
        delete settings.enabledPlugins[PLUGIN_NAME]
        if (Object.keys(settings.enabledPlugins).length === 0) {
          delete settings.enabledPlugins
        }
        atomicWriteSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
      }
    }
  } catch { /* non-critical */ }

  console.log('[plugin-manager] uninstalled plugin')
}
