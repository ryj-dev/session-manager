import { useState, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore, defaultHotkeys, type HotkeyMap } from '../store'
import { formatHotkey, parseHotkeyKeys, hotkeyLabels, comboFromEvent } from '../lib/hotkeys'

interface KeyboardShortcutsProps {
  visible: boolean
  onClose: () => void
}

// ── Keyboard layout ───────────────────────────────────────────────────

interface KeyDef {
  id: string       // Unique key identifier for highlighting
  label: string    // Display label
  width?: number   // Width multiplier (1 = standard key)
}

const KEYBOARD_ROWS: KeyDef[][] = [
  // Row 1: Number row
  [
    { id: '`', label: '`' },
    { id: '1', label: '1' },
    { id: '2', label: '2' },
    { id: '3', label: '3' },
    { id: '4', label: '4' },
    { id: '5', label: '5' },
    { id: '6', label: '6' },
    { id: '7', label: '7' },
    { id: '8', label: '8' },
    { id: '9', label: '9' },
    { id: '0', label: '0' },
    { id: '-', label: '-' },
    { id: '=', label: '=' },
    { id: 'Backspace', label: 'delete', width: 1.5 },
  ],
  // Row 2: QWERTY
  [
    { id: 'Tab', label: 'tab', width: 1.5 },
    { id: 'Q', label: 'Q' },
    { id: 'W', label: 'W' },
    { id: 'E', label: 'E' },
    { id: 'R', label: 'R' },
    { id: 'T', label: 'T' },
    { id: 'Y', label: 'Y' },
    { id: 'U', label: 'U' },
    { id: 'I', label: 'I' },
    { id: 'O', label: 'O' },
    { id: 'P', label: 'P' },
    { id: '[', label: '[' },
    { id: ']', label: ']' },
    { id: '\\', label: '\\' },
  ],
  // Row 3: Home row
  [
    { id: 'CapsLock', label: 'caps', width: 1.75 },
    { id: 'A', label: 'A' },
    { id: 'S', label: 'S' },
    { id: 'D', label: 'D' },
    { id: 'F', label: 'F' },
    { id: 'G', label: 'G' },
    { id: 'H', label: 'H' },
    { id: 'J', label: 'J' },
    { id: 'K', label: 'K' },
    { id: 'L', label: 'L' },
    { id: ';', label: ';' },
    { id: "'", label: "'" },
    { id: 'Enter', label: 'return', width: 1.75 },
  ],
  // Row 4: Shift row
  [
    { id: 'Shift', label: 'shift', width: 2.25 },
    { id: 'Z', label: 'Z' },
    { id: 'X', label: 'X' },
    { id: 'C', label: 'C' },
    { id: 'V', label: 'V' },
    { id: 'B', label: 'B' },
    { id: 'N', label: 'N' },
    { id: 'M', label: 'M' },
    { id: ',', label: ',' },
    { id: '.', label: '.' },
    { id: '/', label: '/' },
    { id: 'ShiftRight', label: 'shift', width: 2.25 },
  ],
  // Row 5: Bottom row
  [
    { id: 'Fn', label: 'fn', width: 1 },
    { id: 'Control', label: 'ctrl', width: 1.25 },
    { id: 'Alt', label: 'opt', width: 1.25 },
    { id: 'Meta', label: '⌘', width: 1.5 },
    { id: 'Space', label: '', width: 5 },
    { id: 'MetaRight', label: '⌘', width: 1.5 },
    { id: 'AltRight', label: 'opt', width: 1.25 },
    { id: 'ArrowLeft', label: '←', width: 1 },
    { id: 'ArrowUp+ArrowDown', label: '↑↓', width: 1 },
    { id: 'ArrowRight', label: '→', width: 1 },
  ],
]

// Non-configurable shortcuts displayed in the list
const FIXED_SHORTCUTS: { keys: string; label: string }[] = [
  { keys: 'Enter', label: 'Focus selected session' },
  { keys: '← →', label: 'Cycle sessions in project' },
  { keys: '↑ ↓', label: 'Switch between projects' },
  { keys: 'Esc', label: 'Close overlays / panels' },
  { keys: '⌘Q', label: 'Quit app' },
  { keys: '⌘⇧W', label: 'Force-close session' },
]

// Map fixed shortcut display keys to keyboard key IDs for highlighting
function fixedShortcutKeyIds(keys: string): string[] {
  switch (keys) {
    case 'Enter': return ['Enter']
    case '← →': return ['ArrowLeft', 'ArrowRight']
    case '↑ ↓': return ['ArrowUp+ArrowDown']
    case 'Esc': return ['Escape']
    case '⌘Q': return ['Meta', 'Q']
    case '⌘⇧W': return ['Meta', 'Shift', 'W']
    default: return []
  }
}

// ── Key component ─────────────────────────────────────────────────────

const KEY_SIZE = 44
const KEY_GAP = 4

function Key({ def, highlighted }: { def: KeyDef; highlighted: boolean }): JSX.Element {
  const width = (def.width ?? 1) * KEY_SIZE + (def.width ? (def.width - 1) * KEY_GAP : 0)

  return (
    <div
      className={`
        flex items-center justify-center rounded-md border text-[10px] font-medium
        transition-all duration-150 select-none shrink-0
        ${highlighted
          ? 'bg-blue-500/30 border-blue-400/60 text-blue-200 shadow-[0_0_12px_rgba(59,130,246,0.3)]'
          : 'bg-zinc-800/80 border-zinc-700/60 text-zinc-500'
        }
      `}
      style={{ width, height: KEY_SIZE }}
    >
      {def.label}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────

export function KeyboardShortcuts({ visible, onClose }: KeyboardShortcutsProps): JSX.Element {
  const hotkeys = useStore((s) => s.hotkeys)
  const setHotkeys = useStore((s) => s.setHotkeys)
  const [editingAction, setEditingAction] = useState<keyof HotkeyMap | null>(null)
  const [hoveredKeys, setHoveredKeys] = useState<Set<string>>(new Set())

  // Escape to close (but not while editing)
  useEffect(() => {
    if (!visible) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (editingAction) {
          setEditingAction(null)
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [visible, onClose, editingAction])

  // Hotkey capture when editing — uses comboFromEvent to handle Alt/Opt correctly
  const handleHotkeyCapture = useCallback((e: KeyboardEvent) => {
    if (!editingAction) return
    e.preventDefault()
    e.stopPropagation()
    const combo = comboFromEvent(e)
    if (!combo) return
    setHotkeys({ ...hotkeys, [editingAction]: combo })
    setEditingAction(null)
  }, [editingAction, hotkeys, setHotkeys])

  useEffect(() => {
    if (!editingAction) return
    window.addEventListener('keydown', handleHotkeyCapture, true)
    return () => window.removeEventListener('keydown', handleHotkeyCapture, true)
  }, [editingAction, handleHotkeyCapture])

  // Build list of configurable actions
  const configurableActions = useMemo(() => {
    return (Object.keys(hotkeyLabels) as (keyof HotkeyMap)[]).map((action) => ({
      action,
      label: hotkeyLabels[action],
      display: formatHotkey(hotkeys[action]),
      keyIds: parseHotkeyKeys(hotkeys[action]),
    }))
  }, [hotkeys])

  const handleHoverConfigurable = useCallback((keyIds: string[]) => {
    setHoveredKeys(new Set(keyIds))
  }, [])

  const handleHoverFixed = useCallback((keys: string) => {
    setHoveredKeys(new Set(fixedShortcutKeyIds(keys)))
  }, [])

  const handleHoverClear = useCallback(() => {
    setHoveredKeys(new Set())
  }, [])

  // Highlight set: combine hover and editing states
  const highlightedKeys = useMemo(() => {
    if (editingAction) {
      const keys = parseHotkeyKeys(hotkeys[editingAction])
      return new Set(keys)
    }
    return hoveredKeys
  }, [editingAction, hotkeys, hoveredKeys])

  // Check if a keyboard key ID should be highlighted
  const isHighlighted = useCallback((keyId: string): boolean => {
    // Handle composite keys like "ArrowUp+ArrowDown"
    if (keyId.includes('+')) {
      return keyId.split('+').some((k) => highlightedKeys.has(k))
    }
    // Match either side of symmetric modifier keys
    if (keyId === 'ShiftRight' && highlightedKeys.has('Shift')) return true
    if (keyId === 'MetaRight' && highlightedKeys.has('Meta')) return true
    if (keyId === 'AltRight' && highlightedKeys.has('Alt')) return true
    return highlightedKeys.has(keyId)
  }, [highlightedKeys])

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="absolute inset-0 z-50 bg-zinc-950 flex flex-col"
        >
          {/* Titlebar drag region */}
          <div className="h-10 flex items-center px-4 shrink-0 titlebar-drag border-b border-zinc-800/50">
            <button
              onClick={onClose}
              className="titlebar-no-drag flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M7.5 2.5L4 6L7.5 9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Settings
            </button>
            <span className="ml-3 text-xs text-zinc-400 font-medium">Keyboard Shortcuts</span>
            <span className="ml-auto titlebar-no-drag text-[10px] text-zinc-600">Esc close</span>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-6 py-8">
              {/* Visual keyboard */}
              <div className="flex flex-col items-center gap-1 mb-10">
                {KEYBOARD_ROWS.map((row, ri) => (
                  <div key={ri} className="flex gap-1">
                    {row.map((keyDef) => (
                      <Key key={keyDef.id} def={keyDef} highlighted={isHighlighted(keyDef.id)} />
                    ))}
                  </div>
                ))}
              </div>

              {/* Shortcuts list */}
              <div className="flex gap-8 overflow-x-auto pb-4">
                {/* Configurable shortcuts */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs text-zinc-400 font-medium">Configurable</h3>
                    <button
                      onClick={() => setHotkeys({ ...defaultHotkeys })}
                      className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
                    >
                      Reset defaults
                    </button>
                  </div>
                  <div className="space-y-1">
                    {configurableActions.map(({ action, label, display, keyIds }) => (
                      <div
                        key={action}
                        className="flex items-center justify-between py-1.5 px-2 rounded-md hover:bg-zinc-800/50 transition-colors cursor-default"
                        onMouseEnter={() => handleHoverConfigurable(keyIds)}
                        onMouseLeave={handleHoverClear}
                      >
                        <span className="text-xs text-zinc-400">{label}</span>
                        <button
                          onClick={() => setEditingAction(action)}
                          className={`px-2 py-0.5 rounded border text-[10px] font-mono transition-all min-w-[48px] text-center ${
                            editingAction === action
                              ? 'bg-blue-500/20 border-blue-400/50 text-blue-300 animate-pulse'
                              : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-zinc-500'
                          }`}
                        >
                          {editingAction === action ? 'press key...' : display}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Fixed shortcuts */}
                <div className="flex-1 min-w-0">
                  <h3 className="text-xs text-zinc-400 font-medium mb-3">Fixed</h3>
                  <div className="space-y-1">
                    {FIXED_SHORTCUTS.map(({ keys, label }) => (
                      <div
                        key={keys}
                        className="flex items-center justify-between py-1.5 px-2 rounded-md hover:bg-zinc-800/50 transition-colors cursor-default"
                        onMouseEnter={() => handleHoverFixed(keys)}
                        onMouseLeave={handleHoverClear}
                      >
                        <span className="text-xs text-zinc-400">{label}</span>
                        <kbd className="px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-500 text-[10px] font-mono min-w-[48px] text-center">
                          {keys}
                        </kbd>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
