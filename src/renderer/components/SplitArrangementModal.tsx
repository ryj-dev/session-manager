import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, type Session } from '../store'
import {
  defaultLayoutFor,
  getDividers,
  getLeaves,
  MAX_SPLIT_N,
  moveLeaf,
  setDividerPosition,
  setDividersPosition,
  swapLeaves,
  type Layout,
  type LayoutDivider,
  type LayoutLeafView,
  type LayoutPath,
} from '../lib/splitLayouts'
import { projectColor, projectColorDim } from '../lib/simulation'

/**
 * Cmd-hold-still preview modal — N-ary container layout editor.
 *
 *   • Drag a tile's interior  → swap with whatever tile the cursor enters.
 *   • Drag a divider          → resize only the two adjacent children.
 *   • Snap                    → dragged divider locks onto any other same-dir
 *                               divider within tolerance; aligned dividers
 *                               highlight while dragging.
 *   • Shift + drag a divider  → move every snap-aligned divider together.
 */
export function SplitArrangementModal(): JSX.Element | null {
  const isOpen = useStore((s) => s.isSplitModalOpen)
  const ids = useStore((s) => s.selectedForGroupingIds)
  const sessions = useStore((s) => s.sessions)
  const closeSplitModal = useStore((s) => s.closeSplitModal)
  const pendingLayout = useStore((s) => s.pendingLayout)
  const setPendingLayout = useStore((s) => s.setPendingLayout)
  const isExpandingExistingGroup = useStore((s) => s.isExpandingExistingGroup)
  const setExpandingExistingGroup = useStore((s) => s.setExpandingExistingGroup)
  const setViewMode = useStore((s) => s.setViewMode)
  const activeSplitGroupId = useStore((s) => s.activeSplitGroupId)

  const clamped = useMemo(() => ids.slice(0, MAX_SPLIT_N), [ids])

  const editingLayout = useMemo<Layout | null>(() => {
    if (pendingLayout && layoutCoversIds(pendingLayout, clamped)) return pendingLayout
    return defaultLayoutFor(clamped)
  }, [pendingLayout, clamped])

  useEffect(() => {
    if (!isOpen) return
    if (!editingLayout) return
    if (pendingLayout !== editingLayout) setPendingLayout(editingLayout)
  }, [isOpen, editingLayout, pendingLayout, setPendingLayout])

  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])

  if (!isOpen || clamped.length < 2 || !editingLayout) return null

  return (
    <div className="absolute inset-0 z-50 pointer-events-none">
      <div
        className="absolute bottom-6 right-6 bg-zinc-900/95 border border-zinc-700 rounded-xl p-4 shadow-2xl pointer-events-auto"
        style={{ width: 320 }}
      >
        <div className="text-[11px] text-zinc-400 mb-2.5 flex items-center justify-between gap-2">
          <span>
            {ids.length} session{ids.length !== 1 ? 's' : ''} · drag to rearrange
            {ids.length > MAX_SPLIT_N && (
              <span className="text-amber-500"> (max {MAX_SPLIT_N})</span>
            )}
          </span>
          <div className="flex items-center gap-1">
            {activeSplitGroupId && (
              <button
                onClick={() => {
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

        <LayoutEditor
          layout={editingLayout}
          sessionsById={sessionsById}
          onChange={setPendingLayout}
        />

        <div className="text-[10px] text-zinc-600 mt-2.5 text-right">
          release ⌘ to {isExpandingExistingGroup ? 'apply' : activeSplitGroupId ? 'apply' : 'open'} · shift+drag aligned edges together
        </div>
      </div>
    </div>
  )
}

function layoutCoversIds(layout: Layout, ids: string[]): boolean {
  const leaves = getLeaves(layout)
  if (leaves.length !== ids.length) return false
  const have = new Set(leaves.map((l) => l.id))
  return ids.every((id) => have.has(id))
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

interface LayoutEditorProps {
  layout: Layout
  sessionsById: Map<string, Session>
  onChange: (next: Layout) => void
}

type DragState =
  | { kind: 'tile'; leafId: string }
  | {
      kind: 'edge'
      /** Targets being moved — `[{path, idx}]` for a single, or N for shift+drag. */
      targets: { containerPath: LayoutPath; dividerIdx: number }[]
      dir: 'row' | 'col'
    }
  | null

const EDGE_HIT_PX = 6
/** Snap tolerance in canvas-fraction units (≈ 2% of editor extent). */
const SNAP_TOL = 0.02

type DropHint =
  | { kind: 'swap'; leafId: string }
  | { kind: 'edge'; leafId: string; where: 'left' | 'right' | 'top' | 'bottom' }

/** Edge band thickness as a fraction of the leaf's extent. */
const EDGE_BAND = 0.25

function dropZoneFor(cfx: number, cfy: number, leaf: LayoutLeafView): 'center' | 'left' | 'right' | 'top' | 'bottom' {
  const dx = (cfx - leaf.x) / leaf.w
  const dy = (cfy - leaf.y) / leaf.h
  const distLeft = dx
  const distRight = 1 - dx
  const distTop = dy
  const distBottom = 1 - dy
  const minD = Math.min(distLeft, distRight, distTop, distBottom)
  if (minD >= EDGE_BAND) return 'center'
  if (minD === distLeft) return 'left'
  if (minD === distRight) return 'right'
  if (minD === distTop) return 'top'
  return 'bottom'
}

function LayoutEditor({ layout, sessionsById, onChange }: LayoutEditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState>(null)
  /** Keys of dividers that are currently visually aligned to the dragged one. */
  const [alignedKeys, setAlignedKeys] = useState<Set<string>>(new Set())
  /** Last applied drop hint while tile-dragging — used to avoid re-applying
   *  the same swap/move on every mousemove inside one zone. */
  const [dropHint, setDropHint] = useState<DropHint | null>(null)
  const dropHintRef = useRef<DropHint | null>(dropHint)
  dropHintRef.current = dropHint

  const layoutRef = useRef(layout); layoutRef.current = layout
  const dragRef = useRef(drag); dragRef.current = drag
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange

  useEffect(() => {
    if (drag === null) {
      setAlignedKeys(new Set())
      setDropHint(null)
      dropHintRef.current = null
      return
    }
    const onMove = (e: MouseEvent): void => handlePointer(e)
    const onUp = (e: MouseEvent): void => {
      handlePointer(e)
      setDrag(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    function handlePointer(e: MouseEvent): void {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const fx = (e.clientX - rect.left) / rect.width
      const fy = (e.clientY - rect.top) / rect.height
      if (fx < -0.05 || fx > 1.05 || fy < -0.05 || fy > 1.05) return
      const cfx = Math.max(0, Math.min(1, fx))
      const cfy = Math.max(0, Math.min(1, fy))
      const d = dragRef.current
      if (!d) return
      const cur = layoutRef.current

      if (d.kind === 'edge') {
        const raw = d.dir === 'row' ? cfx : cfy
        // Snap: against all other same-direction dividers (excluding the
        // ones we're already dragging).
        const draggingKeys = new Set(
          d.targets.map((t) => `${t.containerPath.join('.')}:${t.dividerIdx}`)
        )
        const dividers = getDividers(cur)
        let snapped = raw
        const newlyAligned = new Set<string>()
        for (const other of dividers) {
          if (other.dir !== d.dir) continue
          if (draggingKeys.has(other.key)) continue
          if (Math.abs(other.axis - raw) < SNAP_TOL) {
            snapped = other.axis
            newlyAligned.add(other.key)
          }
        }
        setAlignedKeys(newlyAligned)
        const next = setDividersPosition(cur, d.targets, snapped)
        if (next !== cur) onChangeRef.current(next)
        return
      }

      // Tile-drag: pick the target leaf under the cursor, then choose between
      // swap (cursor in the leaf's centre region) and relocate (cursor near an
      // edge, restructures the tree).
      const leaves = getLeaves(cur)
      const over = leaves.find(
        (l) => cfx >= l.x && cfx <= l.x + l.w && cfy >= l.y && cfy <= l.y + l.h
      )
      if (!over || over.id === d.leafId) {
        if (dropHintRef.current) {
          dropHintRef.current = null
          setDropHint(null)
        }
        return
      }
      const zone = dropZoneFor(cfx, cfy, over)
      const newHint = zone === 'center'
        ? { kind: 'swap' as const, leafId: over.id }
        : { kind: 'edge' as const, leafId: over.id, where: zone }
      // Only mutate the layout when (target leaf, zone) changes — keeps the
      // tree stable while the cursor wiggles inside one region.
      const lastHint = dropHintRef.current
      const sameAsLast =
        lastHint &&
        lastHint.kind === newHint.kind &&
        lastHint.leafId === newHint.leafId &&
        (lastHint.kind === 'swap' || (newHint.kind === 'edge' && lastHint.where === newHint.where))
      if (sameAsLast) return
      dropHintRef.current = newHint
      setDropHint(newHint)
      const next = zone === 'center'
        ? swapLeaves(cur, d.leafId, over.id)
        : moveLeaf(cur, d.leafId, over.id, zone)
      if (next !== cur) onChangeRef.current(next)
    }
  }, [drag])

  const dividers = useMemo(() => getDividers(layout), [layout])
  const leaves = useMemo(() => getLeaves(layout), [layout])
  const leafOrderById = useMemo(() => {
    const m = new Map<string, number>()
    leaves.forEach((l, i) => m.set(l.id, i + 1))
    return m
  }, [leaves])

  const draggingDividerKeys = useMemo(() => {
    if (drag?.kind !== 'edge') return new Set<string>()
    return new Set(drag.targets.map((t) => `${t.containerPath.join('.')}:${t.dividerIdx}`))
  }, [drag])

  return (
    <div
      ref={containerRef}
      className="relative aspect-[3/2] w-full bg-zinc-950/60 border border-zinc-800 rounded-lg select-none overflow-hidden"
      onMouseDown={(e) => {
        const el = containerRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const px = e.clientX - rect.left
        const py = e.clientY - rect.top
        const w = rect.width
        const h = rect.height

        // Edge hit-test first.
        for (const div of dividers) {
          const axisPx = div.dir === 'row' ? div.axis * w : div.axis * h
          const cursorAxisPx = div.dir === 'row' ? px : py
          if (Math.abs(cursorAxisPx - axisPx) > EDGE_HIT_PX) continue
          const startPx = div.dir === 'row' ? div.start * h : div.start * w
          const endPx = div.dir === 'row' ? div.end * h : div.end * w
          const cursorPerpPx = div.dir === 'row' ? py : px
          if (cursorPerpPx < startPx || cursorPerpPx > endPx) continue
          e.preventDefault()

          // Shift+drag: include all snap-aligned same-direction dividers.
          if (e.shiftKey) {
            const targets = dividers
              .filter(
                (other) =>
                  other.dir === div.dir &&
                  Math.abs(other.axis - div.axis) < SNAP_TOL
              )
              .map((d) => ({ containerPath: d.containerPath, dividerIdx: d.dividerIdx }))
            setDrag({ kind: 'edge', targets, dir: div.dir })
          } else {
            setDrag({
              kind: 'edge',
              targets: [{ containerPath: div.containerPath, dividerIdx: div.dividerIdx }],
              dir: div.dir,
            })
          }
          return
        }

        // Tile hit-test.
        const fx = px / w
        const fy = py / h
        const leaf = leaves.find(
          (l) => fx >= l.x && fx <= l.x + l.w && fy >= l.y && fy <= l.y + l.h
        )
        if (leaf) {
          e.preventDefault()
          setDrag({ kind: 'tile', leafId: leaf.id })
        }
      }}
    >
      {leaves.map((leaf) => {
        const session = sessionsById.get(leaf.id)
        const isDragging = drag?.kind === 'tile' && drag.leafId === leaf.id
        return (
          <LeafTile
            key={leaf.id}
            leaf={leaf}
            session={session}
            label={leafOrderById.get(leaf.id) ?? 0}
            isDragging={isDragging}
          />
        )
      })}

      {dividers.map((d) => (
        <DividerStrip
          key={d.key}
          divider={d}
          isDragging={draggingDividerKeys.has(d.key)}
          isAligned={alignedKeys.has(d.key)}
        />
      ))}
    </div>
  )
}

interface LeafTileProps {
  leaf: LayoutLeafView
  session: Session | undefined
  label: number
  isDragging: boolean
}

function LeafTile({ leaf, session, label, isDragging }: LeafTileProps): JSX.Element {
  const tint = session ? projectColor(session.projectPath) : null
  const tintDim = session ? projectColorDim(session.projectPath) : null
  const PADDING = 2
  return (
    <div
      className="absolute flex items-center justify-center gap-1.5 rounded-md border text-xs font-mono overflow-hidden cursor-grab"
      style={{
        left: `calc(${leaf.x * 100}% + ${PADDING}px)`,
        top: `calc(${leaf.y * 100}% + ${PADDING}px)`,
        width: `calc(${leaf.w * 100}% - ${PADDING * 2}px)`,
        height: `calc(${leaf.h * 100}% - ${PADDING * 2}px)`,
        backgroundColor: tintDim ?? (isDragging ? 'rgb(63 63 70)' : 'rgb(39 39 42 / 0.7)'),
        borderColor: tint ?? (isDragging ? 'rgb(113 113 122)' : 'rgb(63 63 70)'),
        color: tint ?? 'rgb(212 212 216)',
        boxShadow: isDragging ? `inset 0 0 0 1px ${tint ?? 'rgb(113 113 122)'}` : undefined,
        transition: isDragging ? 'none' : 'left 140ms ease, top 140ms ease, width 140ms ease, height 140ms ease',
      }}
    >
      <span className="opacity-60 shrink-0">{label}</span>
      {session && (
        <span className="truncate text-[10px] min-w-0" title={session.projectPath}>
          {session.projectName}
        </span>
      )}
    </div>
  )
}

interface DividerStripProps {
  divider: LayoutDivider
  isDragging: boolean
  isAligned: boolean
}

function DividerStrip({ divider, isDragging, isAligned }: DividerStripProps): JSX.Element {
  const style: React.CSSProperties = divider.dir === 'row'
    ? {
        left: `calc(${divider.axis * 100}% - ${EDGE_HIT_PX}px)`,
        top: `${divider.start * 100}%`,
        width: EDGE_HIT_PX * 2,
        height: `${(divider.end - divider.start) * 100}%`,
        cursor: 'ew-resize',
      }
    : {
        top: `calc(${divider.axis * 100}% - ${EDGE_HIT_PX}px)`,
        left: `${divider.start * 100}%`,
        height: EDGE_HIT_PX * 2,
        width: `${(divider.end - divider.start) * 100}%`,
        cursor: 'ns-resize',
      }
  const bg = isDragging
    ? 'rgba(255,255,255,0.22)'
    : isAligned
      ? 'rgba(96,165,250,0.35)' // blue-400-ish — visible alignment indicator
      : 'transparent'
  return (
    <div className="absolute" style={style}>
      <div className="absolute inset-0 transition-colors" style={{ backgroundColor: bg }} />
    </div>
  )
}

// Silence the unused-direct-import lint — `setDividerPosition` is kept exported
// for callers who don't need the multi-target form; we use it indirectly via
// `setDividersPosition` here.
void setDividerPosition
