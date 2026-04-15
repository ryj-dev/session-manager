import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, cpSync, existsSync } from 'fs'
import { execSync } from 'child_process'

const MARKETPLACE_NAME = 'session-manager-local'
const PLUGIN_NAME = 'session-manager'
const PLUGIN_FULL = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`

function getPluginInstallPath(): string {
  return join(app.getPath('userData'), 'plugin')
}

function getPluginSourcePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', 'plugin')
    : join(app.getAppPath(), 'resources', 'plugin')
}

function claudeCli(args: string): string | null {
  try {
    return execSync(`claude ${args}`, {
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[plugin-manager] claude ${args} failed:`, msg)
    return null
  }
}

function isMarketplaceAdded(): boolean {
  const output = claudeCli('plugin marketplace list')
  return output != null && output.includes(MARKETPLACE_NAME)
}

function isPluginInstalled(): boolean {
  const output = claudeCli('plugin list')
  return output != null && output.includes(PLUGIN_FULL)
}

export function installPlugin(): void {
  const installPath = getPluginInstallPath()
  const sourcePath = getPluginSourcePath()

  // Copy marketplace + plugin files to app data
  mkdirSync(installPath, { recursive: true })
  cpSync(sourcePath, installPath, { recursive: true })

  // Register marketplace if not already added
  if (!isMarketplaceAdded()) {
    claudeCli(`plugin marketplace add "${installPath}"`)
    console.log('[plugin-manager] registered marketplace:', MARKETPLACE_NAME)
  }

  // Install plugin if not already installed
  if (!isPluginInstalled()) {
    claudeCli(`plugin install ${PLUGIN_FULL}`)
    console.log('[plugin-manager] installed plugin:', PLUGIN_FULL)
  } else {
    console.log('[plugin-manager] plugin already installed:', PLUGIN_FULL)
  }
}

export function uninstallPlugin(): void {
  if (isPluginInstalled()) {
    claudeCli(`plugin uninstall ${PLUGIN_FULL}`)
    console.log('[plugin-manager] uninstalled plugin:', PLUGIN_FULL)
  }

  if (isMarketplaceAdded()) {
    claudeCli(`plugin marketplace remove ${MARKETPLACE_NAME}`)
    console.log('[plugin-manager] removed marketplace:', MARKETPLACE_NAME)
  }
}
