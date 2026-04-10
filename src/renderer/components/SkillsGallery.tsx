import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { PanelItem } from '../hooks/usePanelItems'

interface SkillsGalleryProps {
  visible: boolean
  items: PanelItem[]
  onSpawn: (name: string, content: string) => void
  onClose: () => void
}

export function SkillsGallery({ visible, items, onSpawn, onClose }: SkillsGalleryProps): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedItem = items.find((i) => i.id === selectedId)

  useEffect(() => {
    if (!visible) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (selectedId) {
          setSelectedId(null)
        } else {
          onClose()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [visible, selectedId, onClose])

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="absolute inset-0 z-10 bg-[#0a0a0a] flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="h-10 flex items-center px-4 border-b border-zinc-800/50 shrink-0 titlebar-drag">
            {selectedId ? (
              <>
                <button
                  onClick={() => setSelectedId(null)}
                  className="titlebar-no-drag text-xs text-zinc-500 hover:text-zinc-300 transition-colors mr-3"
                >
                  ← Back
                </button>
                <span className="titlebar-no-drag text-xs text-zinc-300 font-medium">
                  {selectedItem?.name}
                </span>
              </>
            ) : (
              <>
                <span className="titlebar-no-drag text-xs text-zinc-300 font-medium">Skills</span>
                <span className="titlebar-no-drag text-[10px] text-zinc-600 ml-2">{items.length} skills</span>
              </>
            )}
            <span className="ml-auto titlebar-no-drag text-[10px] text-zinc-600">Esc close</span>
          </div>

          {/* Content */}
          {selectedId && selectedItem ? (
            <div className="flex-1 overflow-y-auto p-6">
              <div className="max-w-2xl mx-auto">
                <h1 className="text-lg text-zinc-200 font-medium mb-2">{selectedItem.name}</h1>
                <p className="text-sm text-zinc-500 mb-6">{selectedItem.description}</p>
                <pre className="text-xs text-zinc-400 bg-zinc-900 border border-zinc-800 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap">
                  {selectedItem.content}
                </pre>
                <button
                  onClick={() => onSpawn(selectedItem.name, selectedItem.content)}
                  className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
                >
                  Launch as new session
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-4">
              <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setSelectedId(item.id)}
                    className="group rounded-xl border border-zinc-800 hover:border-zinc-600 transition-all hover:scale-[1.02] bg-zinc-900 p-4 text-left"
                  >
                    <div className="text-sm text-zinc-300 font-medium mb-1 truncate">{item.name}</div>
                    {item.description && (
                      <div className="text-[11px] text-zinc-600 line-clamp-3">{item.description}</div>
                    )}
                  </button>
                ))}

                <button
                  onClick={() => onSpawn('New Skill', 'Create a new skill prompt template. Ask me what kind of skill I want to create, then generate a well-structured markdown prompt for it.')}
                  className="group rounded-xl border border-dashed border-zinc-700 hover:border-zinc-500 transition-all hover:scale-[1.02] bg-zinc-900/50 p-4 text-left flex flex-col items-center justify-center min-h-[100px]"
                >
                  <span className="text-lg text-zinc-600 group-hover:text-zinc-400 mb-1">+</span>
                  <span className="text-xs text-zinc-600 group-hover:text-zinc-400">Create new with Claude</span>
                </button>
              </div>

              {items.length === 0 && (
                <div className="text-center py-12">
                  <p className="text-sm text-zinc-600 mb-2">No skills yet</p>
                  <p className="text-xs text-zinc-700">Add .md files to resources/skills/</p>
                </div>
              )}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
