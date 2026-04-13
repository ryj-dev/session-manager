import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'

export function expandPath(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(1))
  }
  return p
}

/** Paths the renderer is allowed to read from. */
const ALLOWED_ROOTS = [homedir(), '/tmp', '/var/folders']

function assertAllowedPath(target: string): void {
  const resolved = resolve(target)
  if (!ALLOWED_ROOTS.some((root) => resolved.startsWith(root))) {
    throw new Error(`Access denied: ${target}`)
  }
}

export interface FsEntry {
  name: string
  path: string
  isDirectory: boolean
}

export function readDirectory(dirPath: string): FsEntry[] {
  try {
    dirPath = expandPath(dirPath)
    assertAllowedPath(dirPath)
    const entries = readdirSync(dirPath, { withFileTypes: true })
    return entries
      .filter(entry => !entry.name.startsWith('.'))
      .map(entry => ({
        name: entry.name,
        path: join(dirPath, entry.name),
        isDirectory: entry.isDirectory()
      }))
      .sort((a, b) => {
        // Directories first, then alphabetical
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return a.name.localeCompare(b.name)
      })
  } catch {
    return []
  }
}

export function getHomeDir(): string {
  return homedir()
}

export function readFile(filePath: string): string {
  try {
    const resolved = expandPath(filePath)
    assertAllowedPath(resolved)
    return readFileSync(resolved, 'utf-8')
  } catch {
    return ''
  }
}

export function isDirectory(path: string): boolean {
  try {
    const resolved = expandPath(path)
    assertAllowedPath(resolved)
    return statSync(resolved).isDirectory()
  } catch {
    return false
  }
}

// Claude Code slash command management for skills
const CLAUDE_COMMANDS_DIR = join(homedir(), '.claude', 'commands')
const SKILL_PREFIX = 'sm-'

export function installSkillCommand(skillName: string, content: string): string {
  mkdirSync(CLAUDE_COMMANDS_DIR, { recursive: true })
  const safeName = skillName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  const commandName = `${SKILL_PREFIX}${safeName}`
  const filePath = join(CLAUDE_COMMANDS_DIR, `${commandName}.md`)
  // Replace any existing frontmatter with one that sets the command name to match the filename
  const stripped = content.replace(/^---\n[\s\S]*?\n---\n*/, '')
  const withFrontmatter = `---\nname: ${commandName}\n---\n\n${stripped}`
  writeFileSync(filePath, withFrontmatter, 'utf-8')
  return commandName
}

export function uninstallSkillCommand(skillName: string): void {
  const safeName = skillName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  const filePath = join(CLAUDE_COMMANDS_DIR, `${SKILL_PREFIX}${safeName}.md`)
  try { unlinkSync(filePath) } catch { /* already gone */ }
}

export function cleanupAllSkillCommands(): void {
  try {
    const entries = readdirSync(CLAUDE_COMMANDS_DIR)
    for (const entry of entries) {
      if (entry.startsWith(SKILL_PREFIX)) {
        try { unlinkSync(join(CLAUDE_COMMANDS_DIR, entry)) } catch { /* ignore */ }
      }
    }
  } catch { /* dir doesn't exist */ }
}
