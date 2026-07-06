import { useEffect } from 'react'
import { motion } from 'framer-motion'
import type { Session } from '../../store'
import { CanvasDock } from './CanvasDock'

/**
 * Full-viewport canvas view — used from narrow split panes (via
 * CompactArtifactCard) and the dock's expand button. Minimize (⤡), Escape,
 * and backdrop-click all do the same thing: shrink back to the in-pane view.
 * Dismissing the canvas is only possible from the non-expanded dock.
 */
export function ArtifactOverlay({ session, onClose }: { session: Session; onClose: () => void }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12 }}
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full h-full max-w-6xl rounded-lg border border-zinc-800 overflow-hidden shadow-2xl">
        <CanvasDock session={session} variant="overlay" onMinimize={onClose} />
      </div>
    </motion.div>
  )
}
