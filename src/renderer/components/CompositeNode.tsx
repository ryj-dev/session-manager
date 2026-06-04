import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { useStore, type Session, type SessionStatus } from '../store'
import { getLeaves, type Layout } from '../lib/splitLayouts'
import { COMPOSITE_WIDTH, COMPOSITE_HEIGHT } from '../hooks/useSimulation'

interface CompositeNodeProps {
  groupId: string
  x: number
  y: number
  isSelected: boolean
  onClick: (e: React.MouseEvent) => void
}

const STATUS_BORDER: Record<SessionStatus, string | null> = {
  working: 'rgb(251 191 36)',
  permission: 'rgb(96 165 250)',
  finished: 'rgb(74 222 128)',
  seen: null,
  exited: null,
}

const STATUS_DOT: Record<SessionStatus, string | null> = {
  working: 'bg-amber-400',
  permission: 'bg-blue-400',
  finished: 'bg-green-400',
  seen: null,
  exited: null,
}

/**
 * Graph-view representation of a split group: a single bigger node tiling
 * each member's snapshot in the actual layout shape, with per-tile status
 * borders and edges to every project hub the group spans.
 *
 * Click anywhere → enter the split view for this group.
 */
export function CompositeNode({ groupId, x, y, isSelected, onClick }: CompositeNodeProps): JSX.Element | null {
  const splitGroups = useStore((s) => s.splitGroups)
  const sessions = useStore((s) => s.sessions)

  const group = splitGroups.find((g) => g.id === groupId)
  if (!group) return null

  const sessionsById = new Map(sessions.map((s) => [s.id, s]))
  const liveMembers: Session[] = group.orderedSessionIds
    .map((id) => sessionsById.get(id))
    .filter((s): s is Session => Boolean(s))

  if (liveMembers.length < 2) return null

  // Pull the layout tree directly off the group — leaves were already
  // reconciled to live sessions in the store.
  const layout: Layout = group.layout
  const leaves = getLeaves(layout)

  return (
    <motion.div
      className="absolute cursor-pointer group"
      style={{
        left: x - COMPOSITE_WIDTH / 2,
        top: y - COMPOSITE_HEIGHT / 2,
        width: COMPOSITE_WIDTH,
        height: COMPOSITE_HEIGHT,
      }}
      onClick={(e) => onClick(e)}
      whileHover={{ scale: 1.04 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
    >
      <div
        className="relative w-full h-full rounded-lg overflow-hidden bg-zinc-950"
        style={{
          outline: '1px solid rgb(63 63 70 / 0.9)',
          boxShadow: isSelected
            ? '0 0 16px rgba(255,255,255,0.3)'
            : '0 4px 24px rgba(0,0,0,0.5)',
        }}
      >
        {/* Inner area mirroring the actual layout tree */}
        <div className="absolute inset-1">
          {leaves.map((leaf) => {
            const session = sessionsById.get(leaf.id)
            if (!session) return null
            const statusBorder = STATUS_BORDER[session.status]
            return (
              <CompositeTile
                key={session.id}
                session={session}
                leafX={leaf.x}
                leafY={leaf.y}
                leafW={leaf.w}
                leafH={leaf.h}
                statusBorder={statusBorder}
              />
            )
          })}
        </div>

        {/* Selection ring (keyboard-selected composite) */}
        {isSelected && (
          <div
            className="absolute inset-0 pointer-events-none rounded-lg"
            style={{ boxShadow: 'inset 0 0 0 2px rgba(255,255,255,0.85)' }}
          />
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

        {/* Member count badge */}
        <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 text-[10px] font-mono text-zinc-200 bg-black/70 rounded pointer-events-none">
          {liveMembers.length}
        </div>
      </div>
    </motion.div>
  )
}

interface CompositeTileProps {
  session: Session
  leafX: number
  leafY: number
  leafW: number
  leafH: number
  statusBorder: string | null
}

function CompositeTile({ session, leafX, leafY, leafW, leafH, statusBorder }: CompositeTileProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dotClass = STATUS_DOT[session.status]

  useEffect(() => {
    if (!session.snapshot || !canvasRef.current) return
    const canvas = canvasRef.current
    canvas.width = session.snapshot.width
    canvas.height = session.snapshot.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(session.snapshot, 0, 0)
  }, [session.snapshot, session.snapshotVersion])

  return (
    <div
      className="absolute rounded-sm overflow-hidden bg-[#0a0a0a]"
      style={{
        left: `calc(${leafX * 100}% + 1px)`,
        top: `calc(${leafY * 100}% + 1px)`,
        width: `calc(${leafW * 100}% - 2px)`,
        height: `calc(${leafH * 100}% - 2px)`,
        outline: statusBorder ? `1.5px solid ${statusBorder}` : '1px solid rgb(39 39 42 / 0.6)',
      }}
    >
      <canvas ref={canvasRef} className="w-full h-full block" />
      {dotClass && (
        <div className="absolute top-0.5 right-0.5">
          <div className={`w-1.5 h-1.5 rounded-full ${dotClass} ${session.status === 'working' ? 'animate-pulse' : ''}`} />
        </div>
      )}
    </div>
  )
}
