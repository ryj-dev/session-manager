import { useRef, useEffect, useCallback, useMemo } from 'react'
import { useStore } from '../store'
import { useSimulation, type EdgeData } from '../hooks/useSimulation'
import { projectColor, projectColorDim, projectColorMid, projectColorGlow, rectEdgePoint } from '../lib/simulation'
import { SessionNode } from './SessionNode'

// ── Node dimensions ────────────────────────────────────────────────────

const THUMB_WIDTH = 192
const THUMB_HEIGHT = 120
const HUB_PILL_HEIGHT = 28

// ── Curved edge with perimeter attachment ──────────────────────────────

const HUB_EDGE_GAP = 8 // intentional gap between hub pill and edge start

function curvedEdgePath(edge: EdgeData, hubHalfW: number): string {
  // Hub attachment: point on hub pill perimeter + gap (gap baked into hubHalfW)
  const hubPt = rectEdgePoint(
    edge.hubX, edge.hubY,
    edge.spokeAnchorX, edge.spokeAnchorY,
    hubHalfW, HUB_PILL_HEIGHT / 2 + HUB_EDGE_GAP
  )

  // Spoke attachment: fixed precomputed anchor point (moves rigidly with terminal)
  const spokePt = { x: edge.spokeAnchorX, y: edge.spokeAnchorY }

  const dx = spokePt.x - hubPt.x
  const dy = spokePt.y - hubPt.y
  const dist = Math.sqrt(dx * dx + dy * dy)

  // Perpendicular offset for subtle curve (scales with distance)
  const curvature = Math.min(dist * 0.08, 20)

  // Normal vector (perpendicular to the line)
  const nx = -dy / (dist || 1)
  const ny = dx / (dist || 1)

  // Control point: midpoint + perpendicular offset
  const mx = (hubPt.x + spokePt.x) / 2 + nx * curvature
  const my = (hubPt.y + spokePt.y) / 2 + ny * curvature

  return `M ${hubPt.x} ${hubPt.y} Q ${mx} ${my} ${spokePt.x} ${spokePt.y}`
}

// ── Hotkey badge ───────────────────────────────────────────────────────

function Hotkey({ keys, label, small }: { keys: string; label: string; small?: boolean }): JSX.Element {
  return (
    <div className={`flex items-center gap-2 ${small ? '' : 'justify-center'}`}>
      <kbd className={`${small ? 'px-1 py-0 text-[10px]' : 'px-1.5 py-0.5 text-xs'} rounded bg-zinc-800 text-zinc-300 font-mono`}>
        {keys}
      </kbd>
      <span>{label}</span>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────

export function GraphView(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const setViewMode = useStore((s) => s.setViewMode)
  const setFocusedSessionId = useStore((s) => s.setFocusedSessionId)
  const selectedIndex = useStore((s) => s.selectedSessionIndex)
  const setSelectedIndex = useStore((s) => s.setSelectedSessionIndex)
  const viewMode = useStore((s) => s.viewMode)
  const activePanel = useStore((s) => s.activePanel)
  const containerRef = useRef<HTMLDivElement>(null)

  const { hubs, spokes, edges, viewport, nudge } = useSimulation(
    containerRef.current?.clientWidth ?? 800,
    containerRef.current?.clientHeight ?? 600
  )

  // Build project-aware navigation structure
  const projectNav = useMemo(() => {
    const groups: { projectPath: string; sessionIds: string[] }[] = []
    const projectOrder = new Map<string, number>()

    for (const s of sessions) {
      if (!projectOrder.has(s.projectPath)) {
        projectOrder.set(s.projectPath, groups.length)
        groups.push({ projectPath: s.projectPath, sessionIds: [] })
      }
      groups[projectOrder.get(s.projectPath)!].sessionIds.push(s.id)
    }

    return groups
  }, [sessions])

  // Find which project group and local index the current selection is in
  const selectedSession = sessions[selectedIndex]
  const currentGroupIdx = selectedSession
    ? projectNav.findIndex((g) => g.projectPath === selectedSession.projectPath)
    : 0
  const currentLocalIdx = selectedSession
    ? projectNav[currentGroupIdx]?.sessionIds.indexOf(selectedSession.id) ?? 0
    : 0

  const handleSessionClick = useCallback(
    (id: string) => {
      setFocusedSessionId(id)
      setViewMode('focused')
    },
    [setFocusedSessionId, setViewMode]
  )

  // Keyboard navigation: Left/Right within project, Up/Down between projects
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (viewMode !== 'graph') return
      if (activePanel) return
      if (sessions.length === 0 || projectNav.length === 0) return

      const group = projectNav[currentGroupIdx]
      if (!group) return

      let targetSessionId: string | null = null

      switch (e.key) {
        case 'ArrowRight': {
          e.preventDefault()
          const nextLocal = (currentLocalIdx + 1) % group.sessionIds.length
          targetSessionId = group.sessionIds[nextLocal]
          break
        }
        case 'ArrowLeft': {
          e.preventDefault()
          const prevLocal = (currentLocalIdx - 1 + group.sessionIds.length) % group.sessionIds.length
          targetSessionId = group.sessionIds[prevLocal]
          break
        }
        case 'ArrowDown': {
          e.preventDefault()
          const nextGroup = (currentGroupIdx + 1) % projectNav.length
          const nextGroupSessions = projectNav[nextGroup].sessionIds
          // Try to keep similar local index, clamp to group size
          const localIdx = Math.min(currentLocalIdx, nextGroupSessions.length - 1)
          targetSessionId = nextGroupSessions[localIdx]
          break
        }
        case 'ArrowUp': {
          e.preventDefault()
          const prevGroup = (currentGroupIdx - 1 + projectNav.length) % projectNav.length
          const prevGroupSessions = projectNav[prevGroup].sessionIds
          const localIdx = Math.min(currentLocalIdx, prevGroupSessions.length - 1)
          targetSessionId = prevGroupSessions[localIdx]
          break
        }
        case 'Enter':
          e.preventDefault()
          if (selectedSession) {
            handleSessionClick(selectedSession.id)
          }
          return
        default:
          return
      }

      if (targetSessionId) {
        const globalIdx = sessions.findIndex((s) => s.id === targetSessionId)
        if (globalIdx >= 0) setSelectedIndex(globalIdx)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [sessions, projectNav, currentGroupIdx, currentLocalIdx, selectedSession, setSelectedIndex, handleSessionClick, viewMode, activePanel])

  // Build spoke position lookup
  const spokeMap = new Map(spokes.map((s) => [s.id, s]))

  // Estimate hub pill half-widths (px-3 = 12px each side, ~7.5px per char at text-xs font-semibold)
  // Add HUB_EDGE_GAP so the gap is baked into rectEdgePoint rather than added after
  const hubHalfWidths = new Map(
    hubs.map((h) => [h.id, (h.projectName.length * 7.5 + 24) / 2 + HUB_EDGE_GAP])
  )

  // Convert screen-space mouse coordinates to simulation space (inverse viewport transform)
  const screenToSim = useCallback(
    (screenX: number, screenY: number) => {
      const el = containerRef.current
      const rect = el?.getBoundingClientRect()
      const relX = screenX - (rect?.left ?? 0)
      const relY = screenY - (rect?.top ?? 0)
      return {
        x: (relX - viewport.translateX) / viewport.scale,
        y: (relY - viewport.translateY) / viewport.scale
      }
    },
    [viewport]
  )

  const viewportStyle = {
    transform: `translate(${viewport.translateX}px, ${viewport.translateY}px) scale(${viewport.scale})`,
    transformOrigin: '0 0'
  }

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden">
      {/* Viewport-transformed content */}
      <div className="absolute inset-0" style={viewportStyle}>
        {/* Edges (SVG layer) */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ overflow: 'visible' }}>
          {edges.map((edge, i) => (
            <path
              key={i}
              d={curvedEdgePath(edge, hubHalfWidths.get(edge.hubId) ?? 40)}
              stroke={projectColorMid(edge.hubId)}
              strokeWidth={1.5 / viewport.scale}
              fill="none"
              opacity={0.6}
            />
          ))}
        </svg>

        {/* Hub nodes */}
        {hubs.map((hub) => {
          const isActiveProject = selectedSession?.projectPath === hub.id
          return (
            <div
              key={hub.id}
              className="absolute pointer-events-none select-none"
              style={{
                left: hub.x,
                top: hub.y,
                transform: 'translate(-50%, -50%)'
              }}
            >
              <div
                className="px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap border transition-shadow duration-300"
                style={{
                  backgroundColor: projectColorDim(hub.id),
                  borderColor: hub.color,
                  color: hub.color,
                  boxShadow: isActiveProject ? projectColorGlow(hub.id) : 'none'
                }}
              >
                {hub.projectName}
              </div>
            </div>
          )
        })}

        {/* Session nodes */}
        {sessions.map((session, index) => {
          const pos = spokeMap.get(session.id)
          if (!pos) return null
          return (
            <SessionNode
              key={session.id}
              session={session}
              x={pos.x}
              y={pos.y}
              isSelected={index === selectedIndex}
              onClick={() => handleSessionClick(session.id)}
              onHover={(mouseX, mouseY) => {
                const sim = screenToSim(mouseX, mouseY)
                nudge(session.id, sim.x, sim.y)
              }}
            />
          )
        })}
      </div>

      {/* Empty state (outside viewport transform) */}
      {sessions.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center text-zinc-500">
            <p className="text-lg font-medium mb-3">No sessions</p>
            <div className="space-y-1.5 text-sm">
              <Hotkey keys="⌘T" label="Spawn Claude session" />
              <Hotkey keys="⌘N" label="Spawn terminal" />
              <Hotkey keys="⌘E" label="Open file explorer" />
            </div>
          </div>
        </div>
      )}

      {/* Hotkey reference (outside viewport transform) */}
      {sessions.length > 0 && (
        <div className="absolute bottom-3 right-3 text-[10px] text-zinc-600 space-y-0.5">
          <Hotkey keys="⌘T" label="New session" small />
          <Hotkey keys="⌘E" label="Explorer" small />
          <Hotkey keys="←→" label="Cycle in project" small />
          <Hotkey keys="↑↓" label="Switch project" small />
          <Hotkey keys="Enter" label="Focus selected" small />
        </div>
      )}
    </div>
  )
}
