import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../store'

interface SettingsProps {
  visible: boolean
  onClose: () => void
  onOpenShortcuts: () => void
}

export function Settings({ visible, onClose, onOpenShortcuts }: SettingsProps): JSX.Element {
  const baseProjectsDir = useStore((s) => s.baseProjectsDir)
  const setBaseProjectsDir = useStore((s) => s.setBaseProjectsDir)
  const autoFocusOnSpawn = useStore((s) => s.autoFocusOnSpawn)
  const setAutoFocusOnSpawn = useStore((s) => s.setAutoFocusOnSpawn)
  const persistExplorerPath = useStore((s) => s.persistExplorerPath)
  const setPersistExplorerPath = useStore((s) => s.setPersistExplorerPath)
  const explorerFollowsProject = useStore((s) => s.explorerFollowsProject)
  const setExplorerFollowsProject = useStore((s) => s.setExplorerFollowsProject)
  const [dirInput, setDirInput] = useState(baseProjectsDir || '')
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
            className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl max-h-[80vh] overflow-y-auto"
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
              <label className="text-xs text-zinc-400 block mb-1.5 flex items-center gap-1.5">
                Idle notification delay (seconds)
                <span className="relative group">
                  <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-zinc-600 text-[9px] text-zinc-500 cursor-help">?</span>
                  <span className="absolute left-5 top-1/2 -translate-y-1/2 w-64 p-2.5 bg-zinc-800 border border-zinc-600 rounded-lg text-[10px] text-zinc-300 leading-relaxed opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-50 shadow-xl">
                    Controls how quickly Claude Code's <code className="text-blue-400">idle_prompt</code> notification fires after finishing a response.
                    At 0.1s this is near-instant, making it effectively state-based rather than timer-based.
                    Session manager uses this signal to deliver queued messages from other sessions
                    and to send task prompts to spawned agents. A low value means sub-sessions
                    receive their prompts immediately instead of waiting.
                  </span>
                </span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={idleInput}
                  onChange={(e) => setIdleInput(e.target.value)}
                  onBlur={() => {
                    const seconds = Math.max(0.1, parseFloat(idleInput) || 60)
                    const ms = Math.round(seconds * 1000)
                    setIdleInput(String(seconds))
                    setIdleThreshold(ms)
                    window.api.setIdleThreshold(ms)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const seconds = Math.max(0.1, parseFloat(idleInput) || 60)
                      const ms = Math.round(seconds * 1000)
                      setIdleInput(String(seconds))
                      setIdleThreshold(ms)
                      window.api.setIdleThreshold(ms)
                    }
                  }}
                  min="0.1"
                  step="0.1"
                  className="w-20 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-200 focus:outline-none focus:border-zinc-500"
                />
                <span className="text-[10px] text-zinc-600">
                  {idleThreshold <= 200 ? '✓ recommended (near-instant)' : idleThreshold <= 1000 ? '✓ fast' : ''}
                </span>
              </div>
              <p className="text-[10px] text-zinc-600 mt-1">
                How quickly Claude Code fires the idle notification after finishing a response.
                Set to <button onClick={() => { setIdleInput('0.1'); setIdleThreshold(100); window.api.setIdleThreshold(100) }} className="text-blue-400 hover:text-blue-300">0.1s</button> for
                near-instant inter-session messaging. Default is 60s. Requires session restart.
              </p>
            </div>

            {/* Keyboard shortcuts */}
            <div className="border-t border-zinc-800 pt-4">
              <button
                onClick={() => { onClose(); onOpenShortcuts() }}
                className="w-full flex items-center justify-between px-3 py-2.5 bg-zinc-800 hover:bg-zinc-750 border border-zinc-700 hover:border-zinc-600 rounded-lg transition-colors group"
              >
                <div className="flex items-center gap-2.5">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-zinc-400">
                    <rect x="1" y="3" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                    <line x1="3.5" y1="5.5" x2="4.5" y2="5.5" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
                    <line x1="6" y1="5.5" x2="8" y2="5.5" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
                    <line x1="9.5" y1="5.5" x2="10.5" y2="5.5" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
                    <line x1="4" y1="7.5" x2="10" y2="7.5" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
                    <line x1="3.5" y1="9.5" x2="4.5" y2="9.5" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
                  </svg>
                  <span className="text-xs text-zinc-300">Keyboard shortcuts</span>
                </div>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-zinc-600 group-hover:text-zinc-400 transition-colors">
                  <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
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

