import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// fs-service resolves ~/.claude/commands from homedir() at module load, so
// point HOME at a scratch dir BEFORE importing it. Everything below then
// operates on that dir instead of the developer's real command directory.
const HOME = mkdtempSync(join(tmpdir(), 'sm-skills-'))
process.env.HOME = HOME
process.env.USERPROFILE = HOME

const {
  installSkillCommand,
  uninstallSkillCommand,
  cleanupAllSkillCommands,
} = await import('./fs-service.ts')

const commandsDir = join(HOME, '.claude', 'commands')
const filePath = (name: string): string => join(commandsDir, `${name}.md`)

test.after(() => { rmSync(HOME, { recursive: true, force: true }) })

// A skill accepted from the insights inbox is a deliberate user action, and
// the inbox reports it as "Installed" forever. Wiping it at app exit — which
// is right for the gallery's throwaway installs — made that a standing lie.

test('a gallery skill is ephemeral: cleanup removes it', () => {
  const name = installSkillCommand('Ephemeral Helper', 'do the thing')
  assert.equal(name, 'sm-ephemeral-helper')
  assert.ok(existsSync(filePath(name)))

  cleanupAllSkillCommands()
  assert.equal(existsSync(filePath(name)), false)
})

test('an accepted skill survives cleanup, i.e. survives app quit', () => {
  const name = installSkillCommand('Morning Check', 'run the checks', { persistent: true })
  assert.ok(existsSync(filePath(name)))

  // Cleanup runs at both app start and app exit — a persistent skill has to
  // come through several of them intact, not just one.
  cleanupAllSkillCommands()
  cleanupAllSkillCommands()
  assert.ok(existsSync(filePath(name)), 'accepted skill was wiped on quit')
  assert.match(readFileSync(filePath(name), 'utf-8'), /run the checks/)
})

test('cleanup removes ephemeral skills without touching persistent neighbours', () => {
  const keep = installSkillCommand('Keeper', 'keep me', { persistent: true })
  const drop = installSkillCommand('Dropper', 'drop me')

  cleanupAllSkillCommands()
  assert.ok(existsSync(filePath(keep)))
  assert.equal(existsSync(filePath(drop)), false)
})

test('a persistent skill is still explicitly uninstallable', () => {
  const name = installSkillCommand('Removable', 'body', { persistent: true })
  uninstallSkillCommand('Removable')
  assert.equal(existsSync(filePath(name)), false)
})

test('reinstalling over a persistent skill can make it ephemeral again', () => {
  // The marker lives in the file, so the file is the single source of truth —
  // there is no side registry that can drift out of sync with what is on disk.
  const name = installSkillCommand('Flipper', 'body', { persistent: true })
  installSkillCommand('Flipper', 'body')
  cleanupAllSkillCommands()
  assert.equal(existsSync(filePath(name)), false)
})
