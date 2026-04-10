import { useRef, useEffect, useState } from 'react'
import type { Simulation } from 'd3-force'
import {
  createHubSimulation,
  computeSpokeOffsets,
  stepSprings,
  projectColor,
  type HubNode,
  type SpringNode
} from '../lib/simulation'
import { useStore } from '../store'

// ── Public types ───────────────────────────────────────────────────────

export interface HubPosition {
  id: string // projectPath
  projectName: string
  x: number
  y: number
  color: string
}

export interface SpokePosition {
  id: string // session id
  hubId: string
  x: number
  y: number
}

export interface EdgeData {
  hubX: number
  hubY: number
  spokeX: number
  spokeY: number
  spokeAnchorX: number // fixed attachment point on spoke perimeter
  spokeAnchorY: number
  hubId: string
}

export interface ViewportTransform {
  scale: number
  translateX: number
  translateY: number
}

interface SimulationResult {
  hubs: HubPosition[]
  spokes: SpokePosition[]
  edges: EdgeData[]
  viewport: ViewportTransform
  nudge: (sessionId: string, mouseX: number, mouseY: number) => void
}

// Extended spring node that knows its hub and spoke offset
interface SpokeSpring extends SpringNode {
  hubId: string
  offsetX: number
  offsetY: number
  anchorOffsetX: number // fixed edge attachment relative to spoke center
  anchorOffsetY: number
}

// ── Persistent position cache (survives component unmount/remount) ─────

const hubPositionCache = new Map<string, { x: number; y: number }>()
const spokeSpringCache = new Map<string, SpokeSpring>()

// ── Hook ───────────────────────────────────────────────────────────────

export function useSimulation(width: number, height: number): SimulationResult {
  const sessions = useStore((s) => s.sessions)
  const hubSimRef = useRef<Simulation<HubNode, never> | null>(null)
  const hubNodesRef = useRef<HubNode[]>([])
  const hubMapRef = useRef<Map<string, HubNode>>(new Map())
  const spokeSpringsRef = useRef<Map<string, SpokeSpring>>(new Map())
  const rafRef = useRef<number>(0)
  const prevSessionCountRef = useRef(0)
  const animatingRef = useRef(false)

  // State setters accessed via refs so the tick function never goes stale
  const setHubsRef = useRef<React.Dispatch<React.SetStateAction<HubPosition[]>>>(() => {})
  const setSpokesRef = useRef<React.Dispatch<React.SetStateAction<SpokePosition[]>>>(() => {})
  const setEdgesRef = useRef<React.Dispatch<React.SetStateAction<EdgeData[]>>>(() => {})
  const setViewportRef = useRef<React.Dispatch<React.SetStateAction<ViewportTransform>>>(() => {})

  const [hubs, setHubs] = useState<HubPosition[]>([])
  const [spokes, setSpokes] = useState<SpokePosition[]>([])
  const [edges, setEdges] = useState<EdgeData[]>([])
  const [viewport, setViewport] = useState<ViewportTransform>({ scale: 1, translateX: 0, translateY: 0 })

  setHubsRef.current = setHubs
  setSpokesRef.current = setSpokes
  setEdgesRef.current = setEdges
  setViewportRef.current = setViewport

  // ── Tick function (reads only from refs, never stale) ──────────────

  const tickRef = useRef<() => void>(() => {})
  tickRef.current = (): void => {
    const sim = hubSimRef.current
    const hubNodes = hubNodesRef.current
    const hubMap = hubMapRef.current
    const springs = spokeSpringsRef.current

    if (!sim) {
      animatingRef.current = false
      return
    }

    // Tick hub simulation
    sim.tick()

    // Update spoke targets from current hub positions
    for (const spring of springs.values()) {
      const hub = hubMap.get(spring.hubId)
      if (hub) {
        spring.targetX = (hub.x ?? 0) + spring.offsetX
        spring.targetY = (hub.y ?? 0) + spring.offsetY
      }
    }

    // Step spoke springs
    const springArray = [...springs.values()]
    const spokesSettled = stepSprings(springArray)

    // Build output
    const hubPositions: HubPosition[] = hubNodes.map((h) => ({
      id: h.id,
      projectName: h.projectName,
      x: h.x ?? 0,
      y: h.y ?? 0,
      color: h.color
    }))

    const spokePositions: SpokePosition[] = springArray.map((s) => ({
      id: s.id,
      hubId: s.hubId,
      x: s.x,
      y: s.y
    }))

    const edgeData: EdgeData[] = []
    for (const spring of springArray) {
      const hub = hubMap.get(spring.hubId)
      if (hub) {
        edgeData.push({
          hubX: hub.x ?? 0,
          hubY: hub.y ?? 0,
          spokeX: spring.x,
          spokeY: spring.y,
          spokeAnchorX: spring.x + spring.anchorOffsetX,
          spokeAnchorY: spring.y + spring.anchorOffsetY,
          hubId: spring.hubId
        })
      }
    }

    // Save positions to cache (survives unmount)
    for (const h of hubPositions) {
      hubPositionCache.set(h.id, { x: h.x, y: h.y })
    }
    for (const s of springArray) {
      spokeSpringCache.set(s.id, { ...s })
    }

    // Auto-fit viewport: compute bounding box of all nodes (spokes are larger)
    const HALF_W = 192 / 2 // THUMB_WIDTH / 2
    const HALF_H = 120 / 2 // THUMB_HEIGHT / 2
    const PADDING = 80

    if (spokePositions.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const sp of spokePositions) {
        minX = Math.min(minX, sp.x - HALF_W)
        minY = Math.min(minY, sp.y - HALF_H)
        maxX = Math.max(maxX, sp.x + HALF_W)
        maxY = Math.max(maxY, sp.y + HALF_H)
      }
      for (const hp of hubPositions) {
        minX = Math.min(minX, hp.x - 50)
        minY = Math.min(minY, hp.y - 20)
        maxX = Math.max(maxX, hp.x + 50)
        maxY = Math.max(maxY, hp.y + 20)
      }

      const contentW = maxX - minX + PADDING * 2
      const contentH = maxY - minY + PADDING * 2
      const scaleX = width / contentW
      const scaleY = height / contentH
      const scale = Math.min(scaleX, scaleY, 1) // never zoom in past 1x

      const contentCenterX = (minX + maxX) / 2
      const contentCenterY = (minY + maxY) / 2
      const translateX = width / 2 - contentCenterX * scale
      const translateY = height / 2 - contentCenterY * scale

      setViewportRef.current({ scale, translateX, translateY })
    }

    setHubsRef.current(hubPositions)
    setSpokesRef.current(spokePositions)
    setEdgesRef.current(edgeData)

    // Continue only if still animating
    const hubActive = sim.alpha() > 0.002
    if (!spokesSettled || hubActive) {
      rafRef.current = requestAnimationFrame(() => tickRef.current())
    } else {
      animatingRef.current = false
    }
  }

  // ── Start animation (no-op if already running) ─────────────────────

  function startAnimation(): void {
    if (animatingRef.current) return
    animatingRef.current = true
    rafRef.current = requestAnimationFrame(() => tickRef.current())
  }

  // ── Initialize hub simulation ──────────────────────────────────────

  useEffect(() => {
    if (width === 0 || height === 0) return

    const sim = createHubSimulation(width, height)
    hubSimRef.current = sim
    sim.stop()

    return () => {
      sim.stop()
      animatingRef.current = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [width, height])

  // ── Sync sessions → hub nodes + spoke springs ─────────────────────

  useEffect(() => {
    const sim = hubSimRef.current
    if (!sim || width === 0 || height === 0) return

    // Group sessions by project
    const groups = new Map<string, { projectName: string; sessionIds: string[] }>()
    for (const s of sessions) {
      const existing = groups.get(s.projectPath)
      if (existing) {
        existing.sessionIds.push(s.id)
      } else {
        groups.set(s.projectPath, { projectName: s.projectName, sessionIds: [s.id] })
      }
    }

    // Sync hub nodes
    const existingHubMap = hubMapRef.current
    const newHubNodes: HubNode[] = []
    const newHubMap = new Map<string, HubNode>()

    for (const [projectPath, group] of groups) {
      const existing = existingHubMap.get(projectPath)
      if (existing) {
        existing.projectName = group.projectName
        existing.sessionCount = group.sessionIds.length
        newHubNodes.push(existing)
        newHubMap.set(projectPath, existing)
      } else {
        // Restore from cache if available, otherwise random position
        const cached = hubPositionCache.get(projectPath)
        const node: HubNode = {
          id: projectPath,
          projectName: group.projectName,
          color: projectColor(projectPath),
          sessionCount: group.sessionIds.length,
          x: cached?.x ?? width / 2 + (Math.random() - 0.5) * 100,
          y: cached?.y ?? height / 2 + (Math.random() - 0.5) * 100
        }
        newHubNodes.push(node)
        newHubMap.set(projectPath, node)
      }
    }

    hubNodesRef.current = newHubNodes
    hubMapRef.current = newHubMap
    sim.nodes(newHubNodes)

    // Sync spoke springs
    const existingSprings = spokeSpringsRef.current
    const newSprings = new Map<string, SpokeSpring>()

    for (const [projectPath, group] of groups) {
      const offsets = computeSpokeOffsets(group.sessionIds, projectPath)
      const hub = newHubMap.get(projectPath)!
      const hubX = hub.x ?? width / 2
      const hubY = hub.y ?? height / 2

      for (const offset of offsets) {
        const existing = existingSprings.get(offset.id)
        if (existing) {
          existing.hubId = projectPath
          existing.offsetX = offset.offsetX
          existing.offsetY = offset.offsetY
          existing.anchorOffsetX = offset.anchorOffsetX
          existing.anchorOffsetY = offset.anchorOffsetY
          existing.targetX = hubX + offset.offsetX
          existing.targetY = hubY + offset.offsetY
          newSprings.set(offset.id, existing)
        } else {
          // Restore from cache if available, otherwise spawn at hub center
          const cached = spokeSpringCache.get(offset.id)
          // Small random nudge velocity for restored spokes — makes re-entry feel alive
          const nudgeV = cached ? 1.5 : 0
          newSprings.set(offset.id, {
            id: offset.id,
            hubId: projectPath,
            offsetX: offset.offsetX,
            offsetY: offset.offsetY,
            anchorOffsetX: offset.anchorOffsetX,
            anchorOffsetY: offset.anchorOffsetY,
            x: cached?.x ?? hubX,
            y: cached?.y ?? hubY,
            vx: (Math.random() - 0.5) * nudgeV,
            vy: (Math.random() - 0.5) * nudgeV,
            targetX: hubX + offset.offsetX,
            targetY: hubY + offset.offsetY
          })
        }
      }
    }

    spokeSpringsRef.current = newSprings

    // Reheat hub sim
    const countChanged = sessions.length !== prevSessionCountRef.current
    const hubCountChanged = newHubNodes.length !== existingHubMap.size
    const hadCachedPositions = newHubNodes.some((h) => hubPositionCache.has(h.id))
    prevSessionCountRef.current = sessions.length

    if (countChanged || hubCountChanged) {
      // Gentle nudge if restoring from cache, full reheat if new layout
      sim.alpha(hadCachedPositions ? 0.05 : 0.3)
    }

    startAnimation()
  }, [sessions, width, height])

  // ── Nudge a spoke (gentle push away from mouse point) ──────────────

  function nudge(sessionId: string, mouseX: number, mouseY: number): void {
    const spring = spokeSpringsRef.current.get(sessionId)
    if (!spring) return

    // Push away from mouse entry point
    const dx = spring.x - mouseX
    const dy = spring.y - mouseY
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    const pushStrength = 3
    spring.vx += (dx / dist) * pushStrength
    spring.vy += (dy / dist) * pushStrength

    startAnimation()
  }

  // ── Cleanup on unmount ─────────────────────────────────────────────

  useEffect(() => {
    return () => {
      animatingRef.current = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [])

  return { hubs, spokes, edges, viewport, nudge }
}
