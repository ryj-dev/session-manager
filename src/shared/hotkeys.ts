/**
 * Single source of truth for the configurable hotkey actions and their
 * defaults, shared by the main process (settings-store, claude-tips,
 * observer messages, CLAUDE.md block) and the renderer (store, editor).
 *
 * Environment-neutral on purpose: no electron/node/DOM imports. Callers pass
 * their own platform flag (`process.platform === 'darwin'` in main,
 * `navigator.platform.startsWith('Mac')` in the renderer).
 *
 * Combo format: extra modifiers in canonical order (ctrl, alt, shift) joined
 * with '+', then the key — e.g. "t", "shift+t", "alt+c". The base app
 * modifier (Cmd on Mac, Alt on Windows/Linux) is always implied and never
 * part of the combo string.
 */

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
  copyFilePath: string
  togglePipeline: string
  toggleScheduled: string
  toggleCanvas: string
  shareTurn: string
  branchSession: string
  openOverview: string
  toggleGithub: string
}

/** Reserved, non-rebindable combos (checked directly in App.tsx's handler).
 *  The hotkey editor refuses to assign these to a configurable action. */
export const RESERVED_COMBOS: Record<string, string> = {
  'shift+w': 'Force-close session',
}

export function defaultHotkeysFor(isMac: boolean): HotkeyMap {
  return {
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
    // Mac: Cmd+Opt+C. Windows: Alt+Shift+C (Alt is the base app modifier on
    // Windows, so 'alt' isn't expressible as an extra; use shift instead).
    copyFilePath: isMac ? 'alt+c' : 'shift+c',
    togglePipeline: 'l',
    toggleScheduled: 'j',
    toggleCanvas: 'k',
    shareTurn: 'shift+s',
    branchSession: 'b',
    openOverview: 'p',
    toggleGithub: 'g',
  }
}

const MAC_SYMBOLS: Record<string, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧' }
const WIN_SYMBOLS: Record<string, string> = { ctrl: 'Ctrl+', alt: 'Alt+', shift: 'Shift+' }

/**
 * Format a raw combo string into display form. The base app modifier is
 * implied and always prepended: ⌘ on Mac ("⌘⌥⇧T"), "Alt+" elsewhere
 * ("Alt+Shift+T").
 */
export function formatHotkeyFor(raw: string, isMac: boolean): string {
  const parts = raw.split('+')
  const key = parts[parts.length - 1]
  const modifiers = new Set(parts.slice(0, -1))
  let display = isMac ? '⌘' : 'Alt+'
  for (const mod of ['ctrl', 'alt', 'shift']) {
    if (modifiers.has(mod)) display += isMac ? MAC_SYMBOLS[mod] : WIN_SYMBOLS[mod]
  }
  return display + key.toUpperCase()
}
