import { useStore, type HotkeyMap } from '../store'

/** Human-readable labels for each hotkey action */
export const hotkeyLabels: Record<keyof HotkeyMap, string> = {
  spawnSession: 'Spawn Claude session',
  spawnTerminal: 'Spawn terminal',
  returnToGraph: 'Return to graph view',
  toggleExplorer: 'Toggle file explorer',
  toggleAgents: 'Toggle agents panel',
  toggleSkills: 'Toggle skills panel',
  toggleDesign: 'Toggle design panel',
  toggleMemory: 'Toggle memory panel',
  toggleNotesProject: 'Notes (project view)',
  toggleNotesGlobal: 'Notes (global todos)',
  openSettings: 'Open settings',
  copyFilePath: 'Copy file path (in file explorer)',
  togglePipeline: 'Toggle agentic pipeline'
}

/** All recognized modifier tokens in canonical order */
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift'] as const

/** Mac symbol for each modifier */
const MAC_SYMBOLS: Record<string, string> = {
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧'
}

/** Windows/Linux label for each modifier */
const WIN_SYMBOLS: Record<string, string> = {
  ctrl: 'Ctrl+',
  alt: 'Alt+',
  shift: 'Shift+'
}

const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')

/**
 * Build a normalized hotkey combo string from a KeyboardEvent.
 *
 * Uses `e.code` to resolve the physical key — this avoids the problem where
 * Alt/Opt produces special characters (e.g., opt+o → ø on macOS).
 *
 * Format: modifiers in order (ctrl, alt, shift) joined with '+', then the key.
 * Examples: "t", "shift+t", "alt+o", "ctrl+shift+k"
 *
 * The base app modifier (Cmd on Mac, Alt on Windows) is NOT included in the
 * combo string — it's always required and handled by the global handler.
 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  // Ignore modifier-only presses
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return null

  // Resolve the physical key from e.code
  const key = keyFromCode(e.code)
  if (!key) return null

  const parts: string[] = []
  if (e.ctrlKey && IS_MAC) parts.push('ctrl')  // On Mac, ctrl is an extra modifier; on Win it's the base
  if (e.altKey && IS_MAC) parts.push('alt')     // On Mac, alt/opt is an extra modifier; on Win it's the base
  if (e.shiftKey) parts.push('shift')
  parts.push(key)
  return parts.join('+')
}

/**
 * Extract a lowercase key identifier from a KeyboardEvent.code value.
 * Maps physical key codes to simple key names.
 */
function keyFromCode(code: string): string | null {
  // Letter keys: KeyA → a, KeyZ → z
  if (code.startsWith('Key')) return code.slice(3).toLowerCase()
  // Digit keys: Digit1 → 1
  if (code.startsWith('Digit')) return code.slice(5)
  // Punctuation and special keys
  const codeMap: Record<string, string> = {
    Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    Space: 'space', Enter: 'enter', Tab: 'tab',
    Backspace: 'backspace', Delete: 'delete',
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Escape: 'escape',
  }
  return codeMap[code] ?? null
}

/**
 * Format a raw hotkey combo string into display form.
 *
 * On Mac: prepends ⌘ (always implied) then modifier symbols, e.g. "⌘⌥⇧T"
 * On Windows: prepends "Alt+" (always implied) then modifier labels, e.g. "Alt+Shift+T"
 */
export function formatHotkey(raw: string): string {
  const parts = raw.split('+')
  const key = parts[parts.length - 1]
  const modifiers = new Set(parts.slice(0, -1))

  if (IS_MAC) {
    let display = '⌘'
    for (const mod of MODIFIER_ORDER) {
      if (modifiers.has(mod)) display += MAC_SYMBOLS[mod]
    }
    return display + key.toUpperCase()
  } else {
    let display = 'Alt+'
    for (const mod of MODIFIER_ORDER) {
      if (modifiers.has(mod)) display += WIN_SYMBOLS[mod]
    }
    return display + key.toUpperCase()
  }
}

/**
 * Parse a hotkey string into its constituent keys for keyboard highlighting.
 * Returns an array of key identifiers matching the keyboard layout component.
 */
export function parseHotkeyKeys(raw: string): string[] {
  const parts = raw.split('+')
  const key = parts[parts.length - 1]
  const modifiers = new Set(parts.slice(0, -1))

  const keys: string[] = [IS_MAC ? 'Meta' : 'Alt'] // Base modifier: Cmd on Mac, Alt on Windows
  if (modifiers.has('ctrl')) keys.push('Control')
  if (modifiers.has('alt') && IS_MAC) keys.push('Alt') // Only extra modifier on Mac
  if (modifiers.has('shift')) keys.push('Shift')
  keys.push(key.toUpperCase())
  return keys
}

/** Hook: get the formatted display string for a hotkey action */
export function useHotkeyDisplay(action: keyof HotkeyMap): string {
  const hotkey = useStore((s) => s.hotkeys[action])
  return formatHotkey(hotkey)
}
