import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../store'
import { defaultShapeFor, MAX_SPLIT_N, pickShapeForDrop, resolveShape, type Shape, type SlotRect } from '../lib/splitLayouts'

/**
 * Cmd-hold-still preview modal. Drag a slot to reshape; release Cmd to commit.
 *
 * Used both for forming a new group (from graph view) and for reshaping/expanding
 * an existing one (from split view). The selection comes from
 * `selectedForGroupingIds` in either case.
 */
export function SplitArrangementModal(): JSX.Element | null {
  const isOpen = useStore((s) => s.isSplitModalOpen)
  const ids = useStore((s) => s.selectedForGroupingIds)
  const closeSplitModal = useStore((s) => s.closeSplitModal)
  const pendingShapeId = useStore((s) => s.pendingShapeId)
  const setPendingShapeId = useStore((s) => s.setPendingShapeId)
  const isExpandingExistingGroup = useStore((s) => s.isExpandingExistingGroup)
  const setExpandingExistingGroup = useStore((s) => s.setExpandingExistingGroup)
  const setViewMode = useStore((s) => s.setViewMode)
  const activeSplitGroupId = useStore((s) => s.activeSplitGroupId)

  const N = Math.min(ids.length, MAX_SPLIT_N)
  const shape = useMemo<Shape | null>(() => {
    if (N < 2) return null
    return pendingShapeId ? resolveShape(N, pendingShapeId) : defaultShapeFor(N)
  }, [N, pendingShapeId])

  if (!isOpen || N < 2 || !shape) return null

  return (
    <div className="absolute inset-0 z-50 pointer-events-none">
      <div
        className="absolute bottom-6 right-6 bg-zinc-900/95 border border-zinc-700 rounded-xl p-4 shadow-2xl pointer-events-auto"
        style={{ width: 320 }}
      >
        <div className="text-[11px] text-zinc-400 mb-2.5 flex items-center justify-between gap-2">
          <span>
            {ids.length} session{ids.length !== 1 ? 's' : ''} · drag to reshape
            {ids.length > MAX_SPLIT_N && (
              <span className="text-amber-500"> (max {MAX_SPLIT_N})</span>
            )}
          </span>
          <div className="flex items-center gap-1">
            {/* + Add button — opens graph for picking more sessions while still holding Cmd */}
            {activeSplitGroupId && (
              <button
                onClick={() => {
                  // Switch to graph-pick mode without losing the selection or Cmd state.
                  setExpandingExistingGroup(true)
                  closeSplitModal()
                  setViewMode('graph')
                }}
                className="text-zinc-500 hover:text-zinc-200 transition-colors text-[11px] -m-1 p-1 px-2 border border-zinc-700 rounded"
                title="Add more sessions from the graph"
              >
                +
              </button>
            )}
            <button
              onClick={() => closeSplitModal()}
              className="text-zinc-500 hover:text-zinc-200 transition-colors -m-1 p-1"
              title="Dismiss preview (selection kept)"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M3 3l6 6M9 3l-6 6" />
              </svg>
            </button>
          </div>
        </div>

        <ShapeDragArea
          n={N}
          shape={shape}
          onShapeChange={(s) => setPendingShapeId(s.id)}
        />

        <div className="text-[10px] text-zinc-600 mt-2.5 text-right">
          release ⌘ to {isExpandingExistingGroup ? 'apply' : activeSplitGroupId ? 'apply' : 'open'} · any key to cancel
        </div>
      </div>
    </div>
  )
}

interface ShapeDragAreaProps {
  n: number
  shape: Shape
  onShapeChange: (next: Shape) => void
}

function ShapeDragArea({ n, shape, onShapeChange }: ShapeDragAreaProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)

  // Imperative drag tracking via document-level listeners so the user can
  // drag past the modal edge.
  useEffect(() => {
    if (draggingIdx === null) return
    const onMove = (_e: MouseEvent): void => {
      // No-op for the visual at this iteration — we let layoutId animate to
      // the snapped position on mouseup. Could preview live by setting a
      // transform on the dragged tile here in a future polish.
    }
    const onUp = (e: MouseEvent): void => {
      const idx = draggingIdx
      const el = containerRef.current
      if (idx !== null && el) {
        const rect = el.getBoundingClientRect()
        const fx = (e.clientX - rect.left) / rect.width
        const fy = (e.clientY - rect.top) / rect.height
        // Only snap if drop is inside the preview (with small slack).
        if (fx > -0.05 && fx < 1.05 && fy > -0.05 && fy < 1.05) {
          const clampedFx = Math.max(0, Math.min(1, fx))
          const clampedFy = Math.max(0, Math.min(1, fy))
          const next = pickShapeForDrop(n, shape.id, idx, clampedFx, clampedFy)
          if (next && next.id !== shape.id) onShapeChange(next)
        }
      }
      setDraggingIdx(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [draggingIdx, shape, n, onShapeChange])

  return (
    <div
      ref={containerRef}
      className="aspect-[3/2] w-full bg-zinc-950/60 border border-zinc-800 rounded-lg p-1.5 grid gap-1 select-none"
      style={{
        gridTemplateColumns: `repeat(${shape.cols}, 1fr)`,
        gridTemplateRows: `repeat(${shape.rows}, 1fr)`,
      }}
    >
      <AnimatePresence>
        {shape.slots.map((slot, i) => (
          <DragSlot
            key={i}
            slot={slot}
            label={i + 1}
            isDragging={draggingIdx === i}
            onDragStart={() => setDraggingIdx(i)}
          />
        ))}
      </AnimatePresence>
    </div>
  )
}

interface DragSlotProps {
  slot: SlotRect
  label: number
  isDragging: boolean
  onDragStart: () => void
}

function DragSlot({ slot, label, isDragging, onDragStart }: DragSlotProps): JSX.Element {
  return (
    <motion.div
      layout
      transition={{ type: 'spring', stiffness: 350, damping: 30 }}
      onMouseDown={(e) => {
        e.preventDefault()
        onDragStart()
      }}
      className={`rounded-md border flex items-center justify-center text-zinc-300 text-xs font-mono cursor-grab ${
        isDragging
          ? 'bg-zinc-700 border-zinc-500 cursor-grabbing'
          : 'bg-zinc-800/70 border-zinc-700 hover:bg-zinc-800 hover:border-zinc-600'
      }`}
      style={{
        gridColumn: `${slot.col + 1} / span ${slot.colSpan}`,
        gridRow: `${slot.row + 1} / span ${slot.rowSpan}`,
      }}
    >
      {label}
    </motion.div>
  )
}
