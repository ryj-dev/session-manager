import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { join, resolve } from 'path'
import { homedir, tmpdir } from 'os'

export function expandPath(p: string): string {
  if (p.startsWith('~/') || p.startsWith('~\\') || p === '~') {
    return join(homedir(), p.slice(1))
  }
  return p
}

/** Paths the renderer is allowed to read from. */
const ALLOWED_ROOTS = process.platform === 'win32'
  ? [homedir(), tmpdir()]
  : [homedir(), '/tmp', '/var/folders']

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

// ── Claude Code slash-command management for skills ─────────────────────────
//
// Two lifetimes share one prefix and one directory:
//
//  - EPHEMERAL (the default). The skills gallery installs a command so the
//    session you just spawned can use it, and every `sm-` file is wiped at
//    app start and app exit. Nothing is meant to outlive the app.
//  - PERSISTENT. A skill the user explicitly ACCEPTED from the observer's
//    insights inbox. The inbox reports it as "Installed" forever, so wiping it
//    on quit made that a lie — the user accepted a proposal and got a slash
//    command that silently disappeared the next time they closed the app.
//
// Persistence is marked in the file's own frontmatter rather than tracked in a
// side registry: the file IS the install, so a marker inside it cannot drift
// out of sync with what is on disk, and deleting the file by hand is a
// complete uninstall. Cleanup reads the marker and leaves those alone.
const CLAUDE_COMMANDS_DIR = join(homedir(), '.claude', 'commands')
const SKILL_PREFIX = 'sm-'

/** Frontmatter key that exempts a command file from cleanup. */
const PERSIST_KEY = 'sm-persistent'

function skillCommandName(skillName: string): string {
  const safeName = skillName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return `${SKILL_PREFIX}${safeName}`
}

export function installSkillCommand(
  skillName: string,
  content: string,
  opts: { persistent?: boolean } = {},
): string {
  mkdirSync(CLAUDE_COMMANDS_DIR, { recursive: true })
  const commandName = skillCommandName(skillName)
  const filePath = join(CLAUDE_COMMANDS_DIR, `${commandName}.md`)
  // Replace any existing frontmatter with one that sets the command name to match the filename
  const stripped = content.replace(/^---\n[\s\S]*?\n---\n*/, '')
  const frontmatter = opts.persistent
    ? `name: ${commandName}\n${PERSIST_KEY}: true`
    : `name: ${commandName}`
  writeFileSync(filePath, `---\n${frontmatter}\n---\n\n${stripped}`, 'utf-8')
  return commandName
}

export function uninstallSkillCommand(skillName: string): void {
  const filePath = join(CLAUDE_COMMANDS_DIR, `${skillCommandName(skillName)}.md`)
  try { unlinkSync(filePath) } catch { /* already gone */ }
}

/** True when a command file asked to survive cleanup. Unreadable files are
 *  treated as NOT persistent — the old behaviour, and the safe direction for a
 *  cleanup routine whose job is to leave no ephemeral files behind. */
function isPersistentSkillFile(filePath: string): boolean {
  try {
    const head = readFileSync(filePath, 'utf-8').slice(0, 512)
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(head)?.[1]
    return frontmatter ? new RegExp(`^${PERSIST_KEY}:\\s*true\\s*$`, 'm').test(frontmatter) : false
  } catch {
    return false
  }
}

/** Wipe every ephemeral skill command. Persistent ones (accepted from the
 *  insights inbox) are left in place — see the note above. */
export function cleanupAllSkillCommands(): void {
  try {
    const entries = readdirSync(CLAUDE_COMMANDS_DIR)
    for (const entry of entries) {
      if (!entry.startsWith(SKILL_PREFIX)) continue
      const filePath = join(CLAUDE_COMMANDS_DIR, entry)
      if (isPersistentSkillFile(filePath)) continue
      try { unlinkSync(filePath) } catch { /* ignore */ }
    }
  } catch { /* dir doesn't exist */ }
}
