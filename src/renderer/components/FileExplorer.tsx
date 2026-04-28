import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../store'
import { formatHotkey, comboFromEvent } from '../lib/hotkeys'

interface FsEntry {
  name: string
  path: string
  isDirectory: boolean
}

interface FileExplorerProps {
  visible: boolean
  initialPath?: string
  persistPath?: boolean
  onSpawnInDir: (dir: string) => void
  onClose: () => void
  onPathChange?: (path: string) => void
}

export function FileExplorer({
  visible,
  initialPath,
  persistPath = true,
  onSpawnInDir,
  onClose,
  onPathChange
}: FileExplorerProps): JSX.Element {
  const baseProjectsDir = useStore((s) => s.baseProjectsDir)
  const setBaseProjectsDir = useStore((s) => s.setBaseProjectsDir)
  const hotkeys = useStore((s) => s.hotkeys)
  const [currentPath, setCurrentPath] = useState<string>('')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const lastInitialPathRef = useRef<string | undefined>(undefined)

  // Initialize path on open.
  // - If initialPath provided (focused session project), use it
  // - If persistPath enabled and we have a previous location, keep it
  // - Otherwise fall back to default directory
  useEffect(() => {
    if (!visible) return

    const initialPathChanged = initialPath !== lastInitialPathRef.current
    lastInitialPathRef.current = initialPath

    // If initialPath was provided and changed, always use it
    if (initialPath && initialPathChanged) {
      setCurrentPath(initialPath)
      return
    }

    // Keep persisted location if setting is on and we have one
    if (persistPath && currentPath) return

    const init = async (): Promise<void> => {
      const startDir = baseProjectsDir || (await window.api.getHomeDir())
      setCurrentPath(startDir)
    }
    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialPath])

  // Load directory contents and notify parent of path changes
  useEffect(() => {
    if (!currentPath) return

    onPathChange?.(currentPath)
    window.api.readDirectory(currentPath).then((result) => {
      // Show directories first, then files
      const sorted = result.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return a.name.localeCompare(b.name)
      })
      setEntries(sorted)
      setSelectedIndex(0)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps — onPathChange is a stable ref setter, don't re-run on identity change
  }, [currentPath])

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const selected = list.children[selectedIndex] as HTMLElement | undefined
    if (selected) {
      selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [selectedIndex])

  // Keyboard navigation
  useEffect(() => {
    if (!visible) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      // Configurable copy-path hotkey: requires the app base modifier (Cmd on Mac, Alt on Windows).
      const isMac = navigator.platform.startsWith('Mac')
      const baseMeta = isMac ? e.metaKey : e.altKey
      if (baseMeta) {
        const combo = comboFromEvent(e)
        if (combo && combo === hotkeys.copyFilePath) {
          e.preventDefault()
          const pathToCopy = entries[selectedIndex]?.path || currentPath
          navigator.clipboard.writeText(pathToCopy)
          return
        }
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) => Math.min(prev + 1, entries.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) => Math.max(prev - 1, 0))
          break
        case 'ArrowRight':
        case 'Enter':
          e.preventDefault()
          if (entries[selectedIndex]?.isDirectory) {
            setCurrentPath(entries[selectedIndex].path)
          }
          break
        case 'ArrowLeft':
        case 'Backspace':
          e.preventDefault()
          // Go up one directory
          const parent = currentPath.split('/').slice(0, -1).join('/')
          if (parent) {
            setCurrentPath(parent)
          }
          break
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [visible, entries, selectedIndex, currentPath, onClose, hotkeys.copyFilePath])

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.2 }}
          className="absolute inset-y-0 left-0 w-80 z-30 bg-zinc-900/95 backdrop-blur-xl border-r border-zinc-800 flex flex-col"
        >
          {/* Header */}
          <div className="h-10 flex items-center px-3 border-b border-zinc-800/50 shrink-0 titlebar-drag">
            <span className="titlebar-no-drag text-xs text-zinc-400 font-medium truncate">
              {currentPath}
            </span>
          </div>

          {/* Breadcrumb hint */}
          <div className="px-3 py-1.5 border-b border-zinc-800/30">
            <span className="text-[10px] text-zinc-600">
              ← back · → enter · {formatHotkey(hotkeys.spawnSession)} spawn here · {formatHotkey(hotkeys.copyFilePath)} copy path
            </span>
          </div>

          {/* Directory listing */}
          <div ref={listRef} className="flex-1 overflow-y-auto py-1">
            {entries.map((entry, index) => (
              <div
                key={entry.path}
                className={`
                  px-3 py-1.5 flex items-center gap-2 cursor-pointer text-sm
                  ${index === selectedIndex ? 'bg-blue-500/20 text-blue-300' : 'text-zinc-400 hover:bg-zinc-800/50'}
                `}
                onClick={() => {
                  setSelectedIndex(index)
                  if (entry.isDirectory) {
                    setCurrentPath(entry.path)
                  }
                }}
              >
                <span className="text-zinc-600 text-xs">
                  {entry.isDirectory ? '📁' : '📄'}
                </span>
                <span className="truncate">{entry.name}</span>
              </div>
            ))}
            {entries.length === 0 && (
              <div className="px-3 py-4 text-xs text-zinc-600 text-center">
                Empty directory
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-3 py-2 border-t border-zinc-800/50 space-y-1.5">
            <div className="text-[10px] text-zinc-600">
              <kbd className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">{formatHotkey(hotkeys.spawnSession)}</kbd>
              {' '}spawn session here ·{' '}
              <kbd className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">Esc</kbd>
              {' '}close
            </div>
            <button
              onClick={() => {
                if (currentPath) {
                  setBaseProjectsDir(currentPath)
                }
              }}
              className="w-full text-left text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Set current directory as default
              {baseProjectsDir === currentPath && (
                <span className="text-green-500 ml-1">✓</span>
              )}
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
