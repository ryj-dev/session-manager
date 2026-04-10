import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../store'
import { DesignItem } from '../hooks/usePanelItems'

interface DesignGalleryProps {
  visible: boolean
  items: DesignItem[]
  onClose: () => void
}

export function DesignGallery({ visible, items, onClose }: DesignGalleryProps): JSX.Element {
  const designDarkMode = useStore((s) => s.designDarkMode)
  const toggleDesignDarkMode = useStore((s) => s.toggleDesignDarkMode)
  const [fullscreenItem, setFullscreenItem] = useState<DesignItem | null>(null)

  // Use a ref so the IPC callback always sees the latest state
  const escapeHandlerRef = useRef<() => void>()
  escapeHandlerRef.current = () => {
    if (fullscreenItem) {
      setFullscreenItem(null)
    } else {
      onClose()
    }
  }

  // Listen for Escape via main process (works even when iframe has focus)
  useEffect(() => {
    if (!visible) return
    return window.api.onGlobalEscape(() => {
      escapeHandlerRef.current?.()
    })
  }, [visible])

  const getPreviewUrl = (item: DesignItem): string => {
    const filename = designDarkMode ? 'preview-dark.html' : 'preview.html'
    return `design://${item.id}/${filename}`
  }

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
            <span className="titlebar-no-drag text-xs text-zinc-300 font-medium">Design Systems</span>
            <span className="titlebar-no-drag text-[10px] text-zinc-600 ml-2">{items.length} brands</span>

            {/* Light/Dark toggle */}
            <div className="ml-auto titlebar-no-drag flex items-center gap-3">
              <button
                onClick={toggleDesignDarkMode}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-zinc-800/50 hover:bg-zinc-800 transition-colors text-[10px] text-zinc-400"
              >
                {designDarkMode ? (
                  <>
                    <span className="text-yellow-400">☾</span> Dark
                  </>
                ) : (
                  <>
                    <span className="text-yellow-500">☀</span> Light
                  </>
                )}
              </button>
              <span className="text-[10px] text-zinc-600">Esc close</span>
            </div>
          </div>

          {/* Grid */}
          <div className="flex-1 overflow-y-auto p-4">
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setFullscreenItem(item)}
                  className="group relative rounded-xl overflow-hidden border border-zinc-800 hover:border-zinc-600 transition-all hover:scale-[1.02] bg-zinc-900 text-left"
                >
                  {/* Preview iframe */}
                  <div className="relative w-full aspect-[16/10] overflow-hidden bg-zinc-950">
                    <iframe
                      src={getPreviewUrl(item)}
                      sandbox="allow-same-origin"
                      className="w-[200%] h-[200%] origin-top-left scale-50 pointer-events-none border-0"
                      tabIndex={-1}
                    />
                  </div>

                  {/* Brand info */}
                  <div className="p-3 flex items-center gap-2">
                    <div
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: item.brandColor }}
                    />
                    <span className="text-xs text-zinc-300 font-medium truncate">
                      {item.name}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Full-screen preview overlay */}
          <AnimatePresence>
            {fullscreenItem && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="absolute inset-0 z-20 bg-[#0a0a0a] flex flex-col"
              >
                {/* Fullscreen header */}
                <div className="h-10 flex items-center px-4 border-b border-zinc-800/50 shrink-0 titlebar-drag">
                  <button
                    onClick={() => setFullscreenItem(null)}
                    className="titlebar-no-drag text-xs text-zinc-500 hover:text-zinc-300 transition-colors mr-3"
                  >
                    ← Back
                  </button>
                  <div
                    className="w-2.5 h-2.5 rounded-full shrink-0 mr-2"
                    style={{ backgroundColor: fullscreenItem.brandColor }}
                  />
                  <span className="titlebar-no-drag text-xs text-zinc-300 font-medium">
                    {fullscreenItem.name}
                  </span>
                  <div className="ml-auto titlebar-no-drag flex items-center gap-3">
                    <button
                      onClick={toggleDesignDarkMode}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-zinc-800/50 hover:bg-zinc-800 transition-colors text-[10px] text-zinc-400"
                    >
                      {designDarkMode ? (
                        <>
                          <span className="text-yellow-400">☾</span> Dark
                        </>
                      ) : (
                        <>
                          <span className="text-yellow-500">☀</span> Light
                        </>
                      )}
                    </button>
                    <span className="text-[10px] text-zinc-600">Esc back</span>
                  </div>
                </div>

                {/* Full-screen iframe */}
                <div className="flex-1 min-h-0">
                  <iframe
                    src={getPreviewUrl(fullscreenItem)}
                    sandbox="allow-same-origin"
                    className="w-full h-full border-0"
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
