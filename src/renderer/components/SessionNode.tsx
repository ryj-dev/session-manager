import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { useStore, type Session, type SessionStatus } from '../store'
import { projectColor, projectColorGlow } from '../lib/simulation'

interface SessionNodeProps {
  session: Session
  x: number
  y: number
  isSelected: boolean
  onClick: () => void
  onHover?: (mouseX: number, mouseY: number) => void
}

const THUMB_WIDTH = 192
const THUMB_HEIGHT = 120

// Status → border/glow color mapping
const STATUS_STYLES: Record<SessionStatus, { border: string; glow: string; dot: string } | null> = {
  working:    { border: 'border-amber-400', glow: 'shadow-[0_0_12px_rgba(251,191,36,0.3)]', dot: 'bg-amber-400' },
  permission: { border: 'border-blue-400',  glow: 'shadow-[0_0_12px_rgba(96,165,250,0.3)]',  dot: 'bg-blue-400' },
  finished:   { border: 'border-green-400', glow: 'shadow-[0_0_12px_rgba(74,222,128,0.3)]',  dot: 'bg-green-400' },
  seen:       null, // no indicator
  exited:     null, // no indicator
}

export function SessionNode({
  session,
  x,
  y,
  isSelected,
  onClick,
  onHover
}: SessionNodeProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hasNudgedRef = useRef(false)
  const lastMousePosRef = useRef<{ x: number; y: number } | null>(null)

  // Draw snapshot onto the thumbnail canvas
  // Uses the same 3x multiplier as the snapshot capture so this is a 1:1 copy — no downscale.
  useEffect(() => {
    if (!session.snapshot || !canvasRef.current) return
    const canvas = canvasRef.current

    // Match the snapshot backing resolution exactly (192×3 = 576, 120×3 = 360)
    canvas.width = THUMB_WIDTH * 3
    canvas.height = THUMB_HEIGHT * 3

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.drawImage(session.snapshot, 0, 0, canvas.width, canvas.height)
  }, [session.snapshot])

  return (
    <motion.div
      className="absolute cursor-pointer group"
      style={{
        left: x - THUMB_WIDTH / 2,
        top: y - THUMB_HEIGHT / 2,
        width: THUMB_WIDTH,
        height: THUMB_HEIGHT
      }}
      onClick={onClick}
      onMouseEnter={(e) => {
        if (!hasNudgedRef.current) {
          hasNudgedRef.current = true
          lastMousePosRef.current = { x: e.clientX, y: e.clientY }
          onHover?.(e.clientX, e.clientY)
        }
      }}
      onMouseLeave={(e) => {
        // Only reset if the mouse has moved significantly from where it entered.
        // This filters out fake leave/re-enter cycles caused by the nudge shifting the element.
        const last = lastMousePosRef.current
        if (last) {
          const dx = e.clientX - last.x
          const dy = e.clientY - last.y
          const moved = Math.sqrt(dx * dx + dy * dy)
          if (moved > 10) {
            hasNudgedRef.current = false
            lastMousePosRef.current = null
          }
        } else {
          hasNudgedRef.current = false
        }
      }}
      whileHover={{ scale: 1.05 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25, layout: { duration: 0 } }}
    >
      {/* Thumbnail container */}
      <div
        className={`
          relative w-full h-full rounded-lg overflow-hidden
          border transition-all duration-300
          ${STATUS_STYLES[session.status]?.border ?? 'border-zinc-700/50'}
          ${!isSelected ? (STATUS_STYLES[session.status]?.glow ?? '') : ''}
          ${isSelected ? 'ring-2 ring-offset-1 ring-offset-[#0a0a0a]' : ''}
        `}
        style={isSelected ? {
          boxShadow: '0 0 12px rgba(255,255,255,0.25)',
          '--tw-ring-color': 'rgba(255,255,255,0.7)',
        } as React.CSSProperties : undefined}
      >
        {/* Terminal snapshot */}
        <canvas
          ref={canvasRef}
          className="w-full h-full bg-[#0a0a0a]"
        />

        {/* Overlay with title */}
        {session.terminalTitle && (
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-2 py-1.5">
            <span className="text-[10px] text-zinc-300 font-medium truncate block">
              {(() => {
                const clean = session.terminalTitle?.replace(/[✳*\u2800-\u28FF]\s*/g, '').trim() ?? ''
                const lower = clean.toLowerCase()
                const isDefault = clean === '' || ['claude code', 'claude'].includes(lower) || lower.endsWith('claude.exe') || lower.endsWith('claude')
                return isDefault ? session.projectName : session.terminalTitle
              })()}
            </span>
          </div>
        )}

        {/* Status indicator dot */}
        {STATUS_STYLES[session.status] && (
          <div className="absolute top-1.5 right-1.5">
            <div className={`w-2 h-2 rounded-full ${STATUS_STYLES[session.status]!.dot} ${session.status === 'working' ? 'animate-pulse' : ''}`} />
          </div>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </motion.div>
  )
}
