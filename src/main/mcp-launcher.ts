/**
 * MCP server lifecycle management.
 * Registers/unregisters the memory MCP server in ~/.claude.json on app start/quit.
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { atomicWriteSync } from './atomic-write'

const MCP_JSON_PATH = join(homedir(), '.claude.json')
const MCP_ENTRY_KEY = 'session-manager'

/**
 * Register the MCP server in ~/.claude.json.
 * The server entry points to the bundled mcp-server.js file.
 */
export function registerMcpServer(serverScriptPath: string, memoriesDir: string, dataDir: string, notesDir?: string): void {
  let config: Record<string, unknown> = {}
  try {
    if (existsSync(MCP_JSON_PATH)) {
      config = JSON.parse(readFileSync(MCP_JSON_PATH, 'utf-8'))
    }
  } catch {
    config = {}
  }

  const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>
  mcpServers[MCP_ENTRY_KEY] = {
    type: 'stdio',
    command: 'node',
    args: [serverScriptPath],
    env: {
      SM_MEMORIES_DIR: memoriesDir,
      SM_DATA_DIR: dataDir,
      ...(notesDir ? { SM_NOTES_DIR: notesDir } : {}),
    },
  }
  config.mcpServers = mcpServers

  atomicWriteSync(MCP_JSON_PATH, JSON.stringify(config, null, 2) + '\n')
  console.log('[mcp-launcher] registered in', MCP_JSON_PATH)
}

/**
 * Remove the MCP server entry from ~/.claude.json.
 */
export function unregisterMcpServer(): void {
  try {
    if (!existsSync(MCP_JSON_PATH)) return

    const config = JSON.parse(readFileSync(MCP_JSON_PATH, 'utf-8')) as Record<string, unknown>
    const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>

    if (!(MCP_ENTRY_KEY in mcpServers)) return

    delete mcpServers[MCP_ENTRY_KEY]

    // Remove mcpServers key entirely if empty
    if (Object.keys(mcpServers).length === 0) {
      delete config.mcpServers
    } else {
      config.mcpServers = mcpServers
    }

    atomicWriteSync(MCP_JSON_PATH, JSON.stringify(config, null, 2) + '\n')
    console.log('[mcp-launcher] unregistered from', MCP_JSON_PATH)
  } catch (err) {
    console.error('[mcp-launcher] failed to unregister:', err)
  }
}

/**
 * Get the path to the bundled MCP server script.
 */
export function getMcpServerScriptPath(): string {
  // In dev: out/main/mcp-server.js relative to app root
  // In production: next to the main process bundle
  return join(__dirname, 'mcp-server.js')
}
