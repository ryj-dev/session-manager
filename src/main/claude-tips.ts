import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { loadSettings } from './settings-store'
import { atomicWriteSync } from './atomic-write'
import { formatHotkeyFor } from '../shared/hotkeys'

/**
 * Session Manager spinner tips — injected into Claude Code via its
 * `spinnerTipsOverride` setting, passed per-spawn with `--settings <file>` so
 * only sessions spawned from this app see them. `excludeDefault: false` mixes
 * them in with Claude Code's own built-in tips.
 *
 * Content is derived from the bundled wiki (docs/wiki) — 1–2 tips per feature,
 * with the wiki itself getting top billing so users learn the docs exist.
 */

/** Main-process formatHotkey: the base app modifier (Cmd on Mac, Alt on
 *  Windows) is implied and always prepended. Delegates to the shared module. */
export function formatHotkey(raw: string): string {
  return formatHotkeyFor(raw, process.platform === 'darwin')
}

/** Build the tip list from the current hotkey bindings. All actions are in
 *  the shared HotkeyMap, so loadSettings() always supplies every key. */
export function buildTips(hotkeys: Record<string, string>): string[] {
  const fh = (action: string): string => formatHotkey(hotkeys[action] ?? '?')

  const tips = [
    // The wiki gets two tips — it's the feature that teaches all the others
    `Ask Claude how any feature of this app works — it ships a wiki (search-wiki / read-wiki-article) and Claude will consult it`,
    `Wondering what this app can do? Ask your session to run list-wiki-articles — one doc per feature`,
    // Graph + sessions
    `${fh('returnToGraph')} returns to the graph — every session is a node, colored by live status`,
    `Quit safely: sessions are saved on exit and restored next launch via claude --resume`,
    `Sessions can message each other — ask Claude to send-message another session instead of copy-pasting between terminals`,
    `Ask Claude to spawn a session for parallel work — it appears in the graph and can report back when done`,
    `${fh('branchSession')} forks the focused session — explore an alternative without losing the original`,
    `Group up to 9 sessions into a tiled split view — reshape the layout live with a preview`,
    `${fh('openOverview')} lists every live session — graph, pipeline, scheduled, observer — with uptime, parentage, and kill`,
    // Knowledge + todos
    `${fh('toggleMemory')} opens the memory graph — Claude writes knowledge notes with wikilinks as it works`,
    `${fh('toggleNotesGlobal')} opens todos — one shared list that you and every agent read and write`,
    // Panels
    `${fh('toggleAgents')} opens specialist agents — each spawns with a hard-restricted tool set`,
    `${fh('toggleSkills')} injects slash-command skills into a new or already-running session`,
    `${fh('toggleDesign')} previews ~60 brand design systems in light and dark`,
    `${fh('toggleExplorer')} browses directories — spawn a session straight into one`,
    // Automation
    `${fh('togglePipeline')} opens the agentic pipeline — a backlog todo becomes plan → implement → review in an isolated worktree`,
    `${fh('toggleScheduled')} schedules recurring Claude runs — daily, on an interval, or first launch of the day`,
    `An opt-in observer digests your finished sessions and proposes automations — review them in the insights inbox (${fh('openOverview')})`,
    // Canvas + sharing
    `Ask for results "on the canvas" — sortable tables, reports, and annotated screenshots beside the terminal (${fh('toggleCanvas')})`,
    `${fh('shareTurn')} exports the current turn (prompt, tool calls, result) as markdown`,
    // Settings
    `Every hotkey is rebindable — ${fh('openSettings')} opens Settings`,
  ]
  // Attribute every tip so it's never mistaken for one of Claude Code's own.
  // No "tip" in the attribution: Claude Code's spinner hardcodes a `Tip: ${text}`
  // prefix onto whichever tip it shows, so ours render as
  // "Tip: Session Manager — …" (verified in cli 2.1.220; not configurable).
  return tips.map((tip) => `Session Manager — ${tip}`)
}

/**
 * If the "inject spinner tips" setting is on, (re)write the Claude settings
 * fragment and return its path for `claude --settings <path>`; null when off.
 * Rewritten on every spawn so hotkey rebinds are reflected immediately.
 */
export function ensureTipsSettingsFile(): string | null {
  const settings = loadSettings()
  if (!settings.injectSpinnerTips) return null
  const dir = join(app.getPath('userData'), 'state')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'claude-spinner-tips.json')
  const fragment = {
    spinnerTipsOverride: {
      tips: buildTips(settings.hotkeys as unknown as Record<string, string>),
      excludeDefault: false,
    },
  }
  try {
    atomicWriteSync(path, JSON.stringify(fragment, null, 2))
  } catch (err) {
    console.warn('[claude-tips] failed to write tips settings file:', err)
    return null
  }
  return path
}
