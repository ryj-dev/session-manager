import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore, type Session } from '../store'
import { defaultShapeFor, MAX_SPLIT_N, pickShapeForDrop, resolveShape, type Shape, type SlotRect } from '../lib/splitLayouts'
import { projectColor, projectColorDim } from '../lib/simulation'

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
  const sessions = useStore((s) => s.sessions)
  const setGroupingSelection = useStore((s) => s.setGroupingSelection)
  const closeSplitModal = useStore((s) => s.closeSplitModal)
  const pendingShapeId = useStore((s) => s.pendingShapeId)
  const setPendingShapeId = useStore((s) => s.setPendingShapeId)
  const isExpandingExistingGroup = useStore((s) => s.isExpandingExistingGroup)
  const setExpandingExistingGroup = useStore((s) => s.setExpandingExistingGroup)
  const setViewMode = useStore((s) => s.setViewMode)
  const activeSplitGroupId = useStore((s) => s.activeSplitGroupId)

  const slotSessions = useMemo<(Session | undefined)[]>(() => {
    return ids.slice(0, MAX_SPLIT_N).map((id) => sessions.find((s) => s.id === id))
  }, [ids, sessions])

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
          slotSessions={slotSessions}
          onShapeChange={(s) => setPendingShapeId(s.id)}
          onReorder={(a, b) => {
            const next = ids.slice()
            const tmp = next[a]
            next[a] = next[b]
            next[b] = tmp
            setGroupingSelection(next)
          }}
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
  slotSessions: (Session | undefined)[]
  onShapeChange: (next: Shape) => void
  onReorder: (a: number, b: number) => void
}

/** Index of the slot in `shape` whose cell contains the cursor fraction, or -1. */
function slotAtFraction(shape: Shape, fx: number, fy: number): number {
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return -1
  const cx = Math.min(shape.cols - 1, Math.max(0, Math.floor(fx * shape.cols)))
  const cy = Math.min(shape.rows - 1, Math.max(0, Math.floor(fy * shape.rows)))
  for (let i = 0; i < shape.slots.length; i++) {
    const s = shape.slots[i]
    if (cx >= s.col && cx < s.col + s.colSpan && cy >= s.row && cy < s.row + s.rowSpan) {
      return i
    }
  }
  return -1
}

function ShapeDragArea({ n, shape, slotSessions, onShapeChange, onReorder }: ShapeDragAreaProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)

  // Imperative drag tracking via document-level listeners so the user can
  // drag past the modal edge. The shape updates live during the drag so the
  // preview tracks the cursor; mouseup just settles the drag state.
  // `shape` is read via a ref to avoid restarting the listeners on every
  // intermediate shape change (which would drop the active drag).
  const shapeRef = useRef(shape)
  shapeRef.current = shape
  const onShapeChangeRef = useRef(onShapeChange)
  onShapeChangeRef.current = onShapeChange
  const onReorderRef = useRef(onReorder)
  onReorderRef.current = onReorder
  // Mutable drag index so swaps mid-gesture continue to track the same session
  // through its new slot position without restarting the listener effect.
  const draggingIdxRef = useRef<number | null>(draggingIdx)
  draggingIdxRef.current = draggingIdx

  useEffect(() => {
    if (draggingIdx === null) return
    const applyFromEvent = (e: MouseEvent): void => {
      const el = containerRef.current
      if (!el) return
      const idx = draggingIdxRef.current
      if (idx === null) return
      const rect = el.getBoundingClientRect()
      const fx = (e.clientX - rect.left) / rect.width
      const fy = (e.clientY - rect.top) / rect.height
      if (fx <= -0.05 || fx >= 1.05 || fy <= -0.05 || fy >= 1.05) return
      const clampedFx = Math.max(0, Math.min(1, fx))
      const clampedFy = Math.max(0, Math.min(1, fy))
      const cur = shapeRef.current

      // Reorder: if the cursor is over a different slot of the current shape,
      // swap the dragged session with whatever sits there and follow the move.
      const overIdx = slotAtFraction(cur, clampedFx, clampedFy)
      if (overIdx !== -1 && overIdx !== idx) {
        onReorderRef.current(idx, overIdx)
        draggingIdxRef.current = overIdx
        setDraggingIdx(overIdx)
        return
      }

      // Reshape: pick the candidate shape whose dragged slot best matches the
      // cursor. Only commits when it would actually change the shape.
      const next = pickShapeForDrop(n, cur.id, idx, clampedFx, clampedFy)
      if (next && next.id !== cur.id) onShapeChangeRef.current(next)
    }
    const onMove = (e: MouseEvent): void => applyFromEvent(e)
    const onUp = (e: MouseEvent): void => {
      applyFromEvent(e)
      setDraggingIdx(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [draggingIdx, n])

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
        {shape.slots.map((slot, i) => {
          const session = slotSessions[i]
          return (
            <DragSlot
              key={session?.id ?? `slot-${i}`}
              slot={slot}
              label={i + 1}
              session={session}
              isDragging={draggingIdx === i}
              onDragStart={() => setDraggingIdx(i)}
            />
          )
        })}
      </AnimatePresence>
    </div>
  )
}

interface DragSlotProps {
  slot: SlotRect
  label: number
  session: Session | undefined
  isDragging: boolean
  onDragStart: () => void
}

function DragSlot({ slot, label, session, isDragging, onDragStart }: DragSlotProps): JSX.Element {
  const tint = session ? projectColor(session.projectPath) : null
  const tintDim = session ? projectColorDim(session.projectPath) : null
  return (
    <motion.div
      layout
      transition={{ type: 'spring', stiffness: 350, damping: 30 }}
      onMouseDown={(e) => {
        e.preventDefault()
        onDragStart()
      }}
      className={`rounded-md border flex items-center justify-center gap-1.5 text-xs font-mono cursor-grab overflow-hidden px-1.5 ${
        isDragging ? 'cursor-grabbing' : ''
      }`}
      style={{
        gridColumn: `${slot.col + 1} / span ${slot.colSpan}`,
        gridRow: `${slot.row + 1} / span ${slot.rowSpan}`,
        backgroundColor: tintDim ?? (isDragging ? 'rgb(63 63 70)' : 'rgb(39 39 42 / 0.7)'),
        borderColor: tint ?? (isDragging ? 'rgb(113 113 122)' : 'rgb(63 63 70)'),
        color: tint ?? 'rgb(212 212 216)',
        boxShadow: isDragging ? `inset 0 0 0 1px ${tint ?? 'rgb(113 113 122)'}` : undefined,
      }}
    >
      <span className="opacity-60 shrink-0">{label}</span>
      {session && (
        <span className="truncate text-[10px] min-w-0" title={session.projectPath}>
          {session.projectName}
        </span>
      )}
    </motion.div>
  )
}
