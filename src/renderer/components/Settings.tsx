import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore, defaultHotkeys, type HotkeyMap } from '../store'

interface SettingsProps {
  visible: boolean
  onClose: () => void
}

export function Settings({ visible, onClose }: SettingsProps): JSX.Element {
  const baseProjectsDir = useStore((s) => s.baseProjectsDir)
  const setBaseProjectsDir = useStore((s) => s.setBaseProjectsDir)
  const autoFocusOnSpawn = useStore((s) => s.autoFocusOnSpawn)
  const setAutoFocusOnSpawn = useStore((s) => s.setAutoFocusOnSpawn)
  const persistExplorerPath = useStore((s) => s.persistExplorerPath)
  const setPersistExplorerPath = useStore((s) => s.setPersistExplorerPath)
  const explorerFollowsProject = useStore((s) => s.explorerFollowsProject)
  const setExplorerFollowsProject = useStore((s) => s.setExplorerFollowsProject)
  const hotkeys = useStore((s) => s.hotkeys)
  const setHotkeys = useStore((s) => s.setHotkeys)
  const [dirInput, setDirInput] = useState(baseProjectsDir || '')
  const [editingHotkey, setEditingHotkey] = useState<keyof HotkeyMap | null>(null)
  const [idleThreshold, setIdleThreshold] = useState<number>(60000)
  const [idleInput, setIdleInput] = useState('')

  // Load idle threshold on mount
  useEffect(() => {
    if (!visible) return
    window.api.getIdleThreshold().then((ms) => {
      setIdleThreshold(ms)
      setIdleInput(String(ms / 1000))
    })
  }, [visible])

  const handleHotkeyCapture = useCallback((e: KeyboardEvent) => {
    if (!editingHotkey) return
    e.preventDefault()
    e.stopPropagation()
    // Ignore modifier-only presses
    if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return
    const combo = (e.shiftKey ? 'shift+' : '') + e.key.toLowerCase()
    setHotkeys({ ...hotkeys, [editingHotkey]: combo })
    setEditingHotkey(null)
  }, [editingHotkey, hotkeys, setHotkeys])

  useEffect(() => {
    if (!editingHotkey) return
    window.addEventListener('keydown', handleHotkeyCapture, true)
    return () => window.removeEventListener('keydown', handleHotkeyCapture, true)
  }, [editingHotkey, handleHotkeyCapture])

  useEffect(() => {
    setDirInput(baseProjectsDir || '')
  }, [baseProjectsDir])

  useEffect(() => {
    if (!visible) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [visible, onClose])

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-medium text-zinc-200 mb-5">Settings</h2>

            {/* Base projects directory */}
            <div className="mb-4">
              <label className="text-xs text-zinc-400 block mb-1.5">
                Default projects directory
              </label>
              <input
                type="text"
                value={dirInput}
                onChange={(e) => setDirInput(e.target.value)}
                onBlur={() => setBaseProjectsDir(dirInput)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setBaseProjectsDir(dirInput)
                }}
                placeholder="~/Documents/projects"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
              />
              <p className="text-[10px] text-zinc-600 mt-1">
                Base directory for file explorer and new sessions
              </p>
            </div>

            {/* Auto-focus on spawn */}
            <div className="mb-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoFocusOnSpawn}
                  onChange={(e) => setAutoFocusOnSpawn(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-zinc-600 bg-zinc-800 accent-blue-500"
                />
                <span className="text-xs text-zinc-300">Auto-focus new sessions</span>
              </label>
              <p className="text-[10px] text-zinc-600 mt-1 ml-5">
                Automatically enter a session after spawning it
              </p>
            </div>

            {/* Persist explorer path */}
            <div className="mb-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={persistExplorerPath}
                  onChange={(e) => setPersistExplorerPath(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-zinc-600 bg-zinc-800 accent-blue-500"
                />
                <span className="text-xs text-zinc-300">Remember explorer location</span>
              </label>
              <p className="text-[10px] text-zinc-600 mt-1 ml-5">
                Reopen file explorer where you left off instead of the default directory
              </p>
            </div>

            {/* Explorer follows project */}
            <div className="mb-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={explorerFollowsProject}
                  onChange={(e) => setExplorerFollowsProject(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-zinc-600 bg-zinc-800 accent-blue-500"
                />
                <span className="text-xs text-zinc-300">Default to active project directory</span>
              </label>
              <p className="text-[10px] text-zinc-600 mt-1 ml-5">
                When opening explorer from a terminal, start at that project's directory
              </p>
            </div>

            {/* Claude Code settings */}
            <div className="mb-6">
              <label className="text-xs text-zinc-400 block mb-1.5">
                Idle notification delay (seconds)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={idleInput}
                  onChange={(e) => setIdleInput(e.target.value)}
                  onBlur={() => {
                    const seconds = Math.max(1, parseInt(idleInput) || 60)
                    const ms = seconds * 1000
                    setIdleInput(String(seconds))
                    setIdleThreshold(ms)
                    window.api.setIdleThreshold(ms)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const seconds = Math.max(1, parseInt(idleInput) || 60)
                      const ms = seconds * 1000
                      setIdleInput(String(seconds))
                      setIdleThreshold(ms)
                      window.api.setIdleThreshold(ms)
                    }
                  }}
                  min="1"
                  className="w-20 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-200 focus:outline-none focus:border-zinc-500"
                />
                <span className="text-[10px] text-zinc-600">
                  {idleThreshold === 5000 ? '✓ recommended' : idleThreshold < 5000 ? 'very aggressive' : ''}
                </span>
              </div>
              <p className="text-[10px] text-zinc-600 mt-1">
                How quickly Claude Code fires the idle notification after finishing a response.
                Recommended: <button onClick={() => { setIdleInput('5'); setIdleThreshold(5000); window.api.setIdleThreshold(5000) }} className="text-blue-400 hover:text-blue-300">5s</button> for
                fast inter-session messaging. Default is 60s. Requires session restart.
              </p>
            </div>

            {/* Hotkeys */}
            <div className="border-t border-zinc-800 pt-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs text-zinc-400">Keyboard shortcuts</h3>
                <button
                  onClick={() => setHotkeys({ ...defaultHotkeys })}
                  className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
                >
                  Reset defaults
                </button>
              </div>
              <div className="space-y-2">
                <EditableHotkeyRow
                  action="spawnSession"
                  label="Spawn Claude session"
                  hotkey={hotkeys.spawnSession}
                  editing={editingHotkey === 'spawnSession'}
                  onEdit={() => setEditingHotkey('spawnSession')}
                />
                <EditableHotkeyRow
                  action="spawnTerminal"
                  label="Spawn terminal"
                  hotkey={hotkeys.spawnTerminal}
                  editing={editingHotkey === 'spawnTerminal'}
                  onEdit={() => setEditingHotkey('spawnTerminal')}
                />
                <EditableHotkeyRow
                  action="returnToGraph"
                  label="Return to graph view"
                  hotkey={hotkeys.returnToGraph}
                  editing={editingHotkey === 'returnToGraph'}
                  onEdit={() => setEditingHotkey('returnToGraph')}
                />
                <EditableHotkeyRow
                  action="toggleExplorer"
                  label="Toggle file explorer"
                  hotkey={hotkeys.toggleExplorer}
                  editing={editingHotkey === 'toggleExplorer'}
                  onEdit={() => setEditingHotkey('toggleExplorer')}
                />
                <EditableHotkeyRow
                  action="toggleAgents"
                  label="Toggle agents panel"
                  hotkey={hotkeys.toggleAgents}
                  editing={editingHotkey === 'toggleAgents'}
                  onEdit={() => setEditingHotkey('toggleAgents')}
                />
                <EditableHotkeyRow
                  action="toggleSkills"
                  label="Toggle skills panel"
                  hotkey={hotkeys.toggleSkills}
                  editing={editingHotkey === 'toggleSkills'}
                  onEdit={() => setEditingHotkey('toggleSkills')}
                />
                <EditableHotkeyRow
                  action="toggleDesign"
                  label="Toggle design panel"
                  hotkey={hotkeys.toggleDesign}
                  editing={editingHotkey === 'toggleDesign'}
                  onEdit={() => setEditingHotkey('toggleDesign')}
                />
                <EditableHotkeyRow
                  action="toggleMemory"
                  label="Toggle memory panel"
                  hotkey={hotkeys.toggleMemory}
                  editing={editingHotkey === 'toggleMemory'}
                  onEdit={() => setEditingHotkey('toggleMemory')}
                />
                <EditableHotkeyRow
                  action="openSettings"
                  label="Open settings"
                  hotkey={hotkeys.openSettings}
                  editing={editingHotkey === 'openSettings'}
                  onEdit={() => setEditingHotkey('openSettings')}
                />
                {/* Non-configurable */}
                <HotkeyRow keys="Enter" label="Focus selected session" />
                <HotkeyRow keys="← → ↑ ↓" label="Navigate sessions / explorer" />
                <HotkeyRow keys="⌘Q" label="Quit app" />
              </div>
            </div>

            <div className="mt-5 flex justify-end">
              <button
                onClick={onClose}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium rounded-lg transition-colors"
              >
                Close
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function HotkeyRow({ keys, label }: { keys: string; label: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-zinc-500">{label}</span>
      <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 text-[10px] font-mono">
        {keys}
      </kbd>
    </div>
  )
}

function EditableHotkeyRow({
  label,
  hotkey,
  editing,
  onEdit
}: {
  action: string
  label: string
  hotkey: string
  editing: boolean
  onEdit: () => void
}): JSX.Element {
  const display = hotkey.startsWith('shift+')
    ? '⇧' + hotkey.slice(6).toUpperCase()
    : hotkey.length === 1 ? hotkey.toUpperCase() : hotkey
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-zinc-500">{label}</span>
      <button
        onClick={onEdit}
        className={`px-1.5 py-0.5 rounded border text-[10px] font-mono transition-colors min-w-[40px] text-center ${
          editing
            ? 'bg-blue-900/40 border-blue-500 text-blue-300 animate-pulse'
            : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-zinc-500'
        }`}
      >
        {editing ? '...' : `⌘${display}`}
      </button>
    </div>
  )
}
