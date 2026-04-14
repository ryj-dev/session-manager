import { useRef, useEffect, useCallback, useMemo, useState } from 'react'
import { useStore } from '../store'
import { formatHotkey } from '../lib/hotkeys'
import { useSimulation, type EdgeData, type ViewportTransform } from '../hooks/useSimulation'
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
  const hotkeys = useStore((s) => s.hotkeys)
  const containerRef = useRef<HTMLDivElement>(null)

  const { hubs, spokes, edges, contentBounds, nudge } = useSimulation(
    containerRef.current?.clientWidth ?? 800,
    containerRef.current?.clientHeight ?? 600
  )

  // ── Viewport: auto-fit from content bounds, overridable by wheel zoom ──

  const [viewport, setViewport] = useState<ViewportTransform>({ scale: 1, translateX: 0, translateY: 0 })
  const userZoomedRef = useRef(false)
  const sessionCountRef = useRef(0)

  // Auto-fit when content bounds change and user hasn't zoomed (or session count changed)
  useEffect(() => {
    if (!contentBounds) return
    const el = containerRef.current
    if (!el) return
    const w = el.clientWidth
    const h = el.clientHeight
    if (w === 0 || h === 0) return

    // Reset user zoom when session count changes
    if (sessions.length !== sessionCountRef.current) {
      userZoomedRef.current = false
      sessionCountRef.current = sessions.length
    }

    if (userZoomedRef.current) return

    const PADDING = 80
    const contentW = contentBounds.maxX - contentBounds.minX + PADDING * 2
    const contentH = contentBounds.maxY - contentBounds.minY + PADDING * 2
    const scaleX = w / contentW
    const scaleY = h / contentH
    const scale = Math.min(scaleX, scaleY, 1)

    const contentCenterX = (contentBounds.minX + contentBounds.maxX) / 2
    const contentCenterY = (contentBounds.minY + contentBounds.maxY) / 2
    const translateX = w / 2 - contentCenterX * scale
    const translateY = h / 2 - contentCenterY * scale

    setViewport({ scale, translateX, translateY })
  }, [contentBounds, sessions.length])

  // ── Momentum wheel zoom toward cursor (same approach as tc-sql-atlas) ──

  const viewportRef = useRef(viewport)
  viewportRef.current = viewport

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const MIN_SCALE = 0.05
    const MAX_SCALE = 3
    const FRICTION = 0.92
    const SENSITIVITY = 0.0003

    let velocity = 0
    let animating = false
    let cursorX = 0
    let cursorY = 0
    let liveViewport = viewportRef.current

    function tick(): void {
      if (Math.abs(velocity) < 0.0001) {
        velocity = 0
        animating = false
        return
      }

      const oldScale = liveViewport.scale
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * (1 + velocity)))

      // World-space point under cursor before zoom
      const worldX = (cursorX - liveViewport.translateX) / oldScale
      const worldY = (cursorY - liveViewport.translateY) / oldScale

      // Adjust translate so the same world point stays under the cursor
      const newTranslateX = cursorX - worldX * newScale
      const newTranslateY = cursorY - worldY * newScale

      liveViewport = { scale: newScale, translateX: newTranslateX, translateY: newTranslateY }
      viewportRef.current = liveViewport
      setViewport(liveViewport)

      velocity *= FRICTION
      requestAnimationFrame(tick)
    }

    function onWheel(e: WheelEvent): void {
      e.preventDefault()
      e.stopPropagation()

      userZoomedRef.current = true

      // Cursor position relative to container
      const rect = el!.getBoundingClientRect()
      cursorX = e.clientX - rect.left
      cursorY = e.clientY - rect.top

      velocity += e.deltaY * SENSITIVITY

      if (!animating) {
        animating = true
        liveViewport = viewportRef.current
        requestAnimationFrame(tick)
      }
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

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
      // Sync selectedSessionIndex so spawning from inside the session uses the
      // correct project (resolveProjectPath falls back to selectedIndex).
      const idx = sessions.findIndex((s) => s.id === id)
      if (idx !== -1) setSelectedIndex(idx)
      setFocusedSessionId(id)
      setViewMode('focused')
    },
    [sessions, setSelectedIndex, setFocusedSessionId, setViewMode]
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
      {/* Titlebar drag region — clears traffic lights and enables window dragging */}
      <div className="absolute top-0 left-0 right-0 h-10 titlebar-drag z-10" />

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
              <Hotkey keys={formatHotkey(hotkeys.spawnSession)} label="Spawn Claude session" />
              <Hotkey keys={formatHotkey(hotkeys.spawnTerminal)} label="Spawn terminal" />
              <Hotkey keys={formatHotkey(hotkeys.toggleExplorer)} label="Open file explorer" />
            </div>
          </div>
        </div>
      )}

      {/* Hotkey reference (outside viewport transform) */}
      {sessions.length > 0 && (
        <div className="absolute bottom-3 right-3 text-[10px] text-zinc-600 space-y-0.5">
          <Hotkey keys={formatHotkey(hotkeys.spawnSession)} label="New session" small />
          <Hotkey keys={formatHotkey(hotkeys.toggleExplorer)} label="Explorer" small />
          <Hotkey keys="←→" label="Cycle in project" small />
          <Hotkey keys="↑↓" label="Switch project" small />
          <Hotkey keys="Enter" label="Focus selected" small />
        </div>
      )}
    </div>
  )
}
