import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../store'

interface SettingsProps {
  visible: boolean
  onClose: () => void
  onOpenShortcuts: () => void
  onOpenStatusline: () => void
}

export function Settings({ visible, onClose, onOpenShortcuts, onOpenStatusline }: SettingsProps): JSX.Element {
  const baseProjectsDir = useStore((s) => s.baseProjectsDir)
  const setBaseProjectsDir = useStore((s) => s.setBaseProjectsDir)
  const autoFocusOnSpawn = useStore((s) => s.autoFocusOnSpawn)
  const setAutoFocusOnSpawn = useStore((s) => s.setAutoFocusOnSpawn)
  const persistExplorerPath = useStore((s) => s.persistExplorerPath)
  const setPersistExplorerPath = useStore((s) => s.setPersistExplorerPath)
  const explorerFollowsProject = useStore((s) => s.explorerFollowsProject)
  const setExplorerFollowsProject = useStore((s) => s.setExplorerFollowsProject)
  const messagePopup = useStore((s) => s.messagePopup)
  const setMessagePopup = useStore((s) => s.setMessagePopup)
  const messagePopupSeconds = useStore((s) => s.messagePopupSeconds)
  const setMessagePopupSeconds = useStore((s) => s.setMessagePopupSeconds)
  const [dirInput, setDirInput] = useState(baseProjectsDir || '')
  const [claudeMdInstalled, setClaudeMdInstalled] = useState<boolean | null>(null)
  const [claudeMdBusy, setClaudeMdBusy] = useState(false)
  const [claudeMdPreview, setClaudeMdPreview] = useState<string | null>(null)

  useEffect(() => {
    setDirInput(baseProjectsDir || '')
  }, [baseProjectsDir])

  // Check CLAUDE.md status when settings open
  useEffect(() => {
    if (!visible) return
    window.api.getClaudeMdStatus().then((s) => setClaudeMdInstalled(s.hasInstructions))
  }, [visible])

  const handleClaudeMdClick = useCallback(async () => {
    if (claudeMdInstalled) {
      // Remove directly (no preview needed)
      setClaudeMdBusy(true)
      try {
        const result = await window.api.removeClaudeMdInstructions()
        if (result.ok) setClaudeMdInstalled(false)
      } finally {
        setClaudeMdBusy(false)
      }
    } else {
      // Show preview before installing
      const preview = await window.api.getClaudeMdPreview()
      setClaudeMdPreview(preview)
    }
  }, [claudeMdInstalled])

  const handleClaudeMdConfirm = useCallback(async () => {
    setClaudeMdBusy(true)
    try {
      const result = await window.api.installClaudeMdInstructions()
      if (result.ok) setClaudeMdInstalled(true)
    } finally {
      setClaudeMdBusy(false)
      setClaudeMdPreview(null)
    }
  }, [])

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

            {/* Message popup behavior */}
            <div className="mb-4">
              <label className="text-xs text-zinc-400 block mb-1.5">
                Message popup behavior
              </label>
              <select
                value={messagePopup}
                onChange={(e) => setMessagePopup(e.target.value as 'manual' | 'timed' | 'disabled')}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-200 focus:outline-none focus:border-zinc-500 appearance-none cursor-pointer"
              >
                <option value="manual">Manual dismiss</option>
                <option value="timed">Auto-dismiss after timeout</option>
                <option value="disabled">Disabled (no popup)</option>
              </select>
              <p className="text-[10px] text-zinc-600 mt-1">
                How inter-session message popups behave (messages always reach Claude via monitor)
              </p>
            </div>

            {messagePopup === 'timed' && (
              <div className="mb-6">
                <label className="text-xs text-zinc-400 block mb-1.5">
                  Auto-dismiss after (seconds)
                </label>
                <input
                  type="number"
                  min={3}
                  max={120}
                  value={messagePopupSeconds}
                  onChange={(e) => setMessagePopupSeconds(Math.max(3, Math.min(120, parseInt(e.target.value) || 15)))}
                  className="w-20 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-200 focus:outline-none focus:border-zinc-500"
                />
              </div>
            )}

            {/* Editor buttons */}
            <div className="border-t border-zinc-800 pt-4 space-y-2">
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

              <button
                onClick={() => { onClose(); onOpenStatusline() }}
                className="w-full flex items-center justify-between px-3 py-2.5 bg-zinc-800 hover:bg-zinc-750 border border-zinc-700 hover:border-zinc-600 rounded-lg transition-colors group"
              >
                <div className="flex items-center gap-2.5">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-zinc-400">
                    <rect x="1" y="4.5" width="12" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
                    <line x1="3" y1="7" x2="5.5" y2="7" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
                    <line x1="7" y1="7" x2="8" y2="7" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
                    <line x1="9.5" y1="7" x2="11" y2="7" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
                  </svg>
                  <span className="text-xs text-zinc-300">Statusline</span>
                </div>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-zinc-600 group-hover:text-zinc-400 transition-colors">
                  <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {/* CLAUDE.md instructions */}
              {claudeMdInstalled !== null && (
                <button
                  onClick={handleClaudeMdClick}
                  disabled={claudeMdBusy}
                  className="w-full flex items-center justify-between px-3 py-2.5 bg-zinc-800 hover:bg-zinc-750 border border-zinc-700 hover:border-zinc-600 rounded-lg transition-colors group disabled:opacity-50"
                >
                  <div className="flex items-center gap-2.5">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-zinc-400">
                      <path d="M3 2h8a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" />
                      <path d="M4.5 5h5M4.5 7h5M4.5 9h3" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
                    </svg>
                    <div>
                      <span className="text-xs text-zinc-300">CLAUDE.md instructions</span>
                      <p className="text-[10px] text-zinc-600">
                        {claudeMdInstalled
                          ? 'Installed — teaches Claude about memory and session tools'
                          : 'Add memory and session management instructions to global CLAUDE.md'}
                      </p>
                    </div>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded border shrink-0 ${
                    claudeMdInstalled
                      ? 'text-emerald-400 border-emerald-800 bg-emerald-950/50'
                      : 'text-zinc-500 border-zinc-700 bg-zinc-900'
                  }`}>
                    {claudeMdBusy ? '...' : claudeMdInstalled ? 'Remove' : 'Install'}
                  </span>
                </button>
              )}
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

      {/* CLAUDE.md preview modal */}
      {claudeMdPreview && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="absolute inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setClaudeMdPreview(null)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="bg-zinc-900 border border-zinc-700 rounded-xl max-w-2xl w-full mx-4 shadow-2xl flex flex-col max-h-[80vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-zinc-800 shrink-0">
              <h3 className="text-sm font-medium text-zinc-200">Preview: CLAUDE.md additions</h3>
              <p className="text-[10px] text-zinc-500 mt-1">
                The following will be appended to ~/.claude/CLAUDE.md
              </p>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              <pre className="text-[11px] leading-relaxed font-mono text-emerald-400/80 whitespace-pre-wrap break-words">
                {claudeMdPreview.split('\n').map((line, i) => (
                  <div key={i} className="flex">
                    <span className="text-emerald-700 select-none w-5 shrink-0 text-right mr-3">{line.trim() ? '+' : ''}</span>
                    <span>{line}</span>
                  </div>
                ))}
              </pre>
            </div>

            <div className="px-5 py-4 border-t border-zinc-800 shrink-0 flex justify-end gap-2">
              <button
                onClick={() => setClaudeMdPreview(null)}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleClaudeMdConfirm}
                disabled={claudeMdBusy}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {claudeMdBusy ? 'Installing...' : 'Install'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

