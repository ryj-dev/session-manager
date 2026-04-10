import { useState, useEffect, useRef, ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

export interface SidebarPickerItem {
  id: string
  name: string
  description: string
  content?: string
}

interface SidebarPickerProps<T extends SidebarPickerItem = SidebarPickerItem> {
  visible: boolean
  items: T[]
  title: string
  onSelect: (item: T) => void
  onClose: () => void
  renderItem?: (item: T, isSelected: boolean) => ReactNode
}

export function SidebarPicker<T extends SidebarPickerItem>({
  visible,
  items,
  title,
  onSelect,
  onClose,
  renderItem
}: SidebarPickerProps<T>): JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0)
  }, [items])

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
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          e.stopPropagation()
          setSelectedIndex((prev) => Math.min(prev + 1, items.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          e.stopPropagation()
          setSelectedIndex((prev) => Math.max(prev - 1, 0))
          break
        case 'Enter':
          e.preventDefault()
          e.stopPropagation()
          if (items[selectedIndex]) {
            onSelect(items[selectedIndex])
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
  }, [visible, items, selectedIndex, onSelect, onClose])

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
            <span className="titlebar-no-drag text-xs text-zinc-400 font-medium">
              {title}
            </span>
            <span className="ml-auto titlebar-no-drag text-[10px] text-zinc-600">
              {items.length} items
            </span>
          </div>

          {/* Breadcrumb hint */}
          <div className="px-3 py-1.5 border-b border-zinc-800/30">
            <span className="text-[10px] text-zinc-600">
              ↑↓ navigate · Enter select · Esc close
            </span>
          </div>

          {/* Item list */}
          <div ref={listRef} className="flex-1 overflow-y-auto py-1">
            {items.map((item, index) => (
              <div
                key={item.id}
                className={`
                  px-3 py-1.5 cursor-pointer text-sm
                  ${index === selectedIndex ? 'bg-blue-500/20 text-blue-300' : 'text-zinc-400 hover:bg-zinc-800/50'}
                `}
                onClick={() => {
                  setSelectedIndex(index)
                  onSelect(item)
                }}
              >
                {renderItem ? (
                  renderItem(item, index === selectedIndex)
                ) : (
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium truncate">{item.name}</span>
                    {item.description && (
                      <span className="text-[11px] text-zinc-600 truncate">{item.description}</span>
                    )}
                  </div>
                )}
              </div>
            ))}
            {items.length === 0 && (
              <div className="px-3 py-4 text-xs text-zinc-600 text-center">
                No items found
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-3 py-2 border-t border-zinc-800/50">
            <div className="text-[10px] text-zinc-600">
              <kbd className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">Enter</kbd>
              {' '}inject into session ·{' '}
              <kbd className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">Esc</kbd>
              {' '}close
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
