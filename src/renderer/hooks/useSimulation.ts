import { useRef, useEffect, useState, useMemo } from 'react'
import type { Simulation } from 'd3-force'
import { forceX, forceY } from 'd3-force'
import {
  createHubSimulation,
  computeSpokeOffsets,
  stepSprings,
  projectColor,
  rectEdgePoint,
  stableHash,
  BASE_RADIUS,
  RING_GAP,
  THUMB_WIDTH,
  THUMB_HEIGHT,
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
  /** True when the spoke endpoint is a composite (split-group) node, not a session. */
  isComposite?: boolean
}

export interface CompositePosition {
  /** Split group id. */
  id: string
  /** Project paths the group spans (one edge to each). */
  hubIds: string[]
  /** Member session ids in slot order. */
  memberIds: string[]
  x: number
  y: number
}

export interface ViewportTransform {
  scale: number
  translateX: number
  translateY: number
}

export interface ContentBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface SimulationResult {
  hubs: HubPosition[]
  spokes: SpokePosition[]
  composites: CompositePosition[]
  edges: EdgeData[]
  contentBounds: ContentBounds | null
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

// Composite spring node — multi-hub, target = centroid of hub positions.
interface CompositeSpring extends SpringNode {
  groupId: string
  hubIds: string[]
  memberIds: string[]
  /** For single-hub composites, fixed offset from the hub center (satellite slot). */
  singleHubOffsetX: number
  singleHubOffsetY: number
}

// Composite visual size (kept here so edge anchor math matches CompositeNode).
export const COMPOSITE_WIDTH = 250
export const COMPOSITE_HEIGHT = 156

/** Deterministic angle around the hub for a single-hub composite. */
function singleHubOffsetFor(groupId: string): { x: number; y: number } {
  const h = stableHash(groupId)
  // Place outside the existing spoke ring so it doesn't conflict with single sessions.
  // Slight per-group jitter on the radius keeps multiple groups in the same project visually distinct.
  const angle = (h % 360) * (Math.PI / 180)
  const radius = BASE_RADIUS + RING_GAP * 0.85
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

// ── Persistent position cache ──────────────────────────────────────────
// Hub positions are persisted to localStorage so they survive renderer
// reloads (which happen on GPU crashes — notably during screen lock).
// Without this, the d3 simulation re-solves from scratch after wake and
// the whole graph reshuffles.

const HUB_CACHE_KEY = 'graph.hubPositions.v1'

function loadHubCache(): Map<string, { x: number; y: number }> {
  try {
    const raw = localStorage.getItem(HUB_CACHE_KEY)
    if (!raw) return new Map()
    const obj = JSON.parse(raw) as Record<string, { x: number; y: number }>
    return new Map(Object.entries(obj))
  } catch {
    return new Map()
  }
}

function saveHubCache(cache: Map<string, { x: number; y: number }>): void {
  try {
    const obj: Record<string, { x: number; y: number }> = {}
    for (const [k, v] of cache) obj[k] = v
    localStorage.setItem(HUB_CACHE_KEY, JSON.stringify(obj))
  } catch {
    /* quota or unavailable — ignore */
  }
}

const hubPositionCache = loadHubCache()
const spokeSpringCache = new Map<string, SpokeSpring>()

// ── Hook ───────────────────────────────────────────────────────────────

export function useSimulation(width: number, height: number): SimulationResult {
  const sessions = useStore((s) => s.sessions)
  const splitGroups = useStore((s) => s.splitGroups)
  const hubSimRef = useRef<Simulation<HubNode, never> | null>(null)
  const hubNodesRef = useRef<HubNode[]>([])
  const hubMapRef = useRef<Map<string, HubNode>>(new Map())
  const spokeSpringsRef = useRef<Map<string, SpokeSpring>>(new Map())
  const compositeSpringsRef = useRef<Map<string, CompositeSpring>>(new Map())
  // Last-known position per composite, refreshed each tick. Consumed by the
  // sync effect when a composite dissolves so its members can spring back from
  // the composite's final location instead of snapping to their cached spoke.
  const compositePositionHistoryRef = useRef<Map<string, { x: number; y: number; memberIds: string[] }>>(new Map())
  const rafRef = useRef<number>(0)
  const prevSessionCountRef = useRef(0)
  const animatingRef = useRef(false)

  // State setters accessed via refs so the tick function never goes stale
  const setHubsRef = useRef<React.Dispatch<React.SetStateAction<HubPosition[]>>>(() => {})
  const setSpokesRef = useRef<React.Dispatch<React.SetStateAction<SpokePosition[]>>>(() => {})
  const setCompositesRef = useRef<React.Dispatch<React.SetStateAction<CompositePosition[]>>>(() => {})
  const setEdgesRef = useRef<React.Dispatch<React.SetStateAction<EdgeData[]>>>(() => {})
  const [hubs, setHubs] = useState<HubPosition[]>([])
  const [spokes, setSpokes] = useState<SpokePosition[]>([])
  const [composites, setComposites] = useState<CompositePosition[]>([])
  const [edges, setEdges] = useState<EdgeData[]>([])
  const [contentBounds, setContentBounds] = useState<ContentBounds | null>(null)

  setHubsRef.current = setHubs
  setSpokesRef.current = setSpokes
  setCompositesRef.current = setComposites
  setEdgesRef.current = setEdges
  const setContentBoundsRef = useRef<React.Dispatch<React.SetStateAction<ContentBounds | null>>>(() => {})
  setContentBoundsRef.current = setContentBounds

  // Build the active-composites view: groups with at least 2 live members,
  // each annotated with its spanning hubs.
  const activeComposites = useMemo(() => {
    const liveSessions = new Map(sessions.map((s) => [s.id, s]))
    return splitGroups
      .map((g) => {
        const liveMembers = g.orderedSessionIds.filter((id) => liveSessions.has(id))
        const hubIds = Array.from(new Set(
          liveMembers.map((id) => liveSessions.get(id)!.projectPath)
        ))
        return { id: g.id, memberIds: liveMembers, hubIds }
      })
      .filter((c) => c.memberIds.length >= 2)
  }, [splitGroups, sessions])

  // Member-id set: sessions hidden as individual graph nodes because they
  // belong to a composite.
  const memberIdSet = useMemo(() => {
    const s = new Set<string>()
    for (const c of activeComposites) for (const id of c.memberIds) s.add(id)
    return s
  }, [activeComposites])

  // ── Tick function (reads only from refs, never stale) ──────────────

  const tickRef = useRef<() => void>(() => {})
  tickRef.current = (): void => {
    const sim = hubSimRef.current
    const hubNodes = hubNodesRef.current
    const hubMap = hubMapRef.current
    const springs = spokeSpringsRef.current
    const composites = compositeSpringsRef.current

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

    // Update composite targets:
    //   - single-hub composite: hub center + a fixed satellite offset (sits outside the spoke ring)
    //   - multi-hub composite: centroid of hub positions (floats between them)
    for (const c of composites.values()) {
      if (c.hubIds.length === 1) {
        const hub = hubMap.get(c.hubIds[0])
        if (hub) {
          c.targetX = (hub.x ?? 0) + c.singleHubOffsetX
          c.targetY = (hub.y ?? 0) + c.singleHubOffsetY
        }
      } else {
        let cx = 0, cy = 0, count = 0
        for (const hubId of c.hubIds) {
          const hub = hubMap.get(hubId)
          if (hub) { cx += hub.x ?? 0; cy += hub.y ?? 0; count++ }
        }
        if (count > 0) {
          c.targetX = cx / count
          c.targetY = cy / count
        }
      }
    }

    // Step both spring sets
    const springArray = [...springs.values()]
    const compositeArray = [...composites.values()]
    const spokesSettled = stepSprings(springArray)
    const compositesSettled = stepSprings(compositeArray)

    // Soft repulsion: composites push spokes out of their bounding box (with padding).
    // This keeps the layout from overlapping when a composite forms over existing
    // spoke positions; the spokes drift around it and re-settle nearby.
    const C_HALF_W_PAD = COMPOSITE_WIDTH / 2 + 18
    const C_HALF_H_PAD = COMPOSITE_HEIGHT / 2 + 18
    const S_HALF_W = THUMB_WIDTH / 2 + 8
    const S_HALF_H = THUMB_HEIGHT / 2 + 8
    for (const c of compositeArray) {
      for (const s of springArray) {
        const dx = s.x - c.x
        const dy = s.y - c.y
        const overlapX = (C_HALF_W_PAD + S_HALF_W) - Math.abs(dx)
        const overlapY = (C_HALF_H_PAD + S_HALF_H) - Math.abs(dy)
        if (overlapX > 0 && overlapY > 0) {
          // Push along the axis of least overlap (cheap MTV-style separation)
          if (overlapX < overlapY) {
            const sign = dx < 0 ? -1 : 1
            s.vx += sign * Math.min(overlapX * 0.08, 1.6)
          } else {
            const sign = dy < 0 ? -1 : 1
            s.vy += sign * Math.min(overlapY * 0.08, 1.6)
          }
        }
      }
    }

    // Record composite positions for elastic-restore on dissolve.
    for (const c of compositeArray) {
      compositePositionHistoryRef.current.set(c.groupId, {
        x: c.x, y: c.y, memberIds: c.memberIds.slice(),
      })
    }

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

    const compositePositions: CompositePosition[] = compositeArray.map((c) => ({
      id: c.groupId,
      hubIds: c.hubIds,
      memberIds: c.memberIds,
      x: c.x,
      y: c.y,
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
    // One edge per (composite, hub) — perimeter anchor faces the source hub.
    for (const c of compositeArray) {
      for (const hubId of c.hubIds) {
        const hub = hubMap.get(hubId)
        if (!hub) continue
        const anchor = rectEdgePoint(
          c.x, c.y,
          hub.x ?? 0, hub.y ?? 0,
          COMPOSITE_WIDTH / 2, COMPOSITE_HEIGHT / 2
        )
        edgeData.push({
          hubX: hub.x ?? 0,
          hubY: hub.y ?? 0,
          spokeX: c.x,
          spokeY: c.y,
          spokeAnchorX: anchor.x,
          spokeAnchorY: anchor.y,
          hubId,
          isComposite: true,
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

    // Emit content bounds so caller can compute viewport
    const HALF_W = 192 / 2 // THUMB_WIDTH / 2
    const HALF_H = 120 / 2 // THUMB_HEIGHT / 2
    const C_HALF_W = COMPOSITE_WIDTH / 2
    const C_HALF_H = COMPOSITE_HEIGHT / 2

    if (spokePositions.length > 0 || compositePositions.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const sp of spokePositions) {
        minX = Math.min(minX, sp.x - HALF_W)
        minY = Math.min(minY, sp.y - HALF_H)
        maxX = Math.max(maxX, sp.x + HALF_W)
        maxY = Math.max(maxY, sp.y + HALF_H)
      }
      for (const cp of compositePositions) {
        minX = Math.min(minX, cp.x - C_HALF_W)
        minY = Math.min(minY, cp.y - C_HALF_H)
        maxX = Math.max(maxX, cp.x + C_HALF_W)
        maxY = Math.max(maxY, cp.y + C_HALF_H)
      }
      for (const hp of hubPositions) {
        minX = Math.min(minX, hp.x - 50)
        minY = Math.min(minY, hp.y - 20)
        maxX = Math.max(maxX, hp.x + 50)
        maxY = Math.max(maxY, hp.y + 20)
      }

      setContentBoundsRef.current({ minX, minY, maxX, maxY })
    }

    setHubsRef.current(hubPositions)
    setSpokesRef.current(spokePositions)
    setCompositesRef.current(compositePositions)
    setEdgesRef.current(edgeData)

    // Continue only if still animating
    const hubActive = sim.alpha() > 0.002
    if (!spokesSettled || !compositesSettled || hubActive) {
      rafRef.current = requestAnimationFrame(() => tickRef.current())
    } else {
      // Pin hubs at their settled positions so future low-alpha ticks
      // (triggered by unrelated sessions-array mutations) can't nudge them.
      // Unpinned again only when a hub is added or removed.
      for (const hub of hubNodes) {
        hub.fx = hub.x ?? null
        hub.fy = hub.y ?? null
      }
      // Persist the settled positions so they survive renderer reloads
      // (e.g. GPU crashes during screen lock). Drop cached entries for
      // projects that no longer have a hub — otherwise the cache grows
      // forever as the user works in new projects.
      const liveIds = new Set(hubNodes.map((h) => h.id))
      for (const key of hubPositionCache.keys()) {
        if (!liveIds.has(key)) hubPositionCache.delete(key)
      }
      saveHubCache(hubPositionCache)
      animatingRef.current = false
    }
  }

  // ── Start animation (no-op if already running) ─────────────────────

  function startAnimation(): void {
    if (animatingRef.current) return
    animatingRef.current = true
    rafRef.current = requestAnimationFrame(() => tickRef.current())
  }

  // ── Initialize hub simulation (once) ───────────────────────────────

  useEffect(() => {
    if (width === 0 || height === 0) return
    if (hubSimRef.current) return

    const sim = createHubSimulation(width, height)
    hubSimRef.current = sim
    sim.stop()

    return () => {
      sim.stop()
      hubSimRef.current = null
      animatingRef.current = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [width, height])

  // ── Update centering forces when size changes, without rebuilding the
  // simulation (which would re-jiggle hub positions).
  useEffect(() => {
    const sim = hubSimRef.current
    if (!sim || width === 0 || height === 0) return
    sim.force('centerX', forceX(width / 2).strength(0.08))
    sim.force('centerY', forceY(height / 2).strength(0.08))
  }, [width, height])

  // ── Sync sessions → hub nodes + spoke springs ─────────────────────

  useEffect(() => {
    const sim = hubSimRef.current
    if (!sim || width === 0 || height === 0) return

    // Group sessions by project. Sort session ids deterministically so their
    // spoke slot assignment doesn't shift if the sessions array order changes
    // (e.g. from status updates after a display wake).
    const groups = new Map<string, { projectName: string; sessionIds: string[] }>()
    for (const s of sessions) {
      const existing = groups.get(s.projectPath)
      if (existing) {
        existing.sessionIds.push(s.id)
      } else {
        groups.set(s.projectPath, { projectName: s.projectName, sessionIds: [s.id] })
      }
    }
    for (const group of groups.values()) {
      group.sessionIds.sort()
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
        // Restore from cache if available, otherwise random position.
        // Cached hubs are pinned immediately so initial centering forces
        // can't drift them from their previous settled position.
        const cached = hubPositionCache.get(projectPath)
        const node: HubNode = {
          id: projectPath,
          projectName: group.projectName,
          color: projectColor(projectPath),
          sessionCount: group.sessionIds.length,
          x: cached?.x ?? width / 2 + (Math.random() - 0.5) * 100,
          y: cached?.y ?? height / 2 + (Math.random() - 0.5) * 100
        }
        if (cached) {
          node.fx = cached.x
          node.fy = cached.y
        }
        newHubNodes.push(node)
        newHubMap.set(projectPath, node)
      }
    }

    hubNodesRef.current = newHubNodes
    hubMapRef.current = newHubMap
    sim.nodes(newHubNodes)

    // Detect dissolved composites (in history but not in active list). Their
    // members get an elastic-restore start position from the composite's last
    // known location instead of snapping to their cached spoke slot.
    const liveCompositeIds = new Set(activeComposites.map((c) => c.id))
    const dissolvedMemberStarts = new Map<string, { x: number; y: number }>()
    for (const [groupId, prev] of compositePositionHistoryRef.current) {
      if (!liveCompositeIds.has(groupId)) {
        for (const memberId of prev.memberIds) {
          dissolvedMemberStarts.set(memberId, { x: prev.x, y: prev.y })
        }
        compositePositionHistoryRef.current.delete(groupId)
      }
    }

    // Sync spoke springs — skip member sessions (those are inside composites)
    const existingSprings = spokeSpringsRef.current
    const newSprings = new Map<string, SpokeSpring>()

    for (const [projectPath, group] of groups) {
      const visibleIds = group.sessionIds.filter((id) => !memberIdSet.has(id))
      if (visibleIds.length === 0) continue
      const offsets = computeSpokeOffsets(visibleIds, projectPath)
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
          // Three sources for initial position, in priority order:
          //   1. Just-dissolved composite — start at its last position with
          //      a velocity impulse toward the spoke target (elastic feel).
          //   2. Spring cache — restore previous on-graph position.
          //   3. Hub center — first time we've seen this session.
          const dissolved = dissolvedMemberStarts.get(offset.id)
          const cached = spokeSpringCache.get(offset.id)
          const targetX = hubX + offset.offsetX
          const targetY = hubY + offset.offsetY

          let startX: number, startY: number, vx: number, vy: number
          if (dissolved) {
            startX = dissolved.x
            startY = dissolved.y
            // 18% of displacement as initial velocity — produces a soft
            // overshoot before the existing damping settles the node.
            vx = (targetX - startX) * 0.18
            vy = (targetY - startY) * 0.18
          } else if (cached) {
            startX = cached.x
            startY = cached.y
            // Tiny random nudge for re-entry liveness
            vx = (Math.random() - 0.5) * 1.5
            vy = (Math.random() - 0.5) * 1.5
          } else {
            startX = hubX
            startY = hubY
            vx = 0
            vy = 0
          }

          newSprings.set(offset.id, {
            id: offset.id,
            hubId: projectPath,
            offsetX: offset.offsetX,
            offsetY: offset.offsetY,
            anchorOffsetX: offset.anchorOffsetX,
            anchorOffsetY: offset.anchorOffsetY,
            x: startX,
            y: startY,
            vx,
            vy,
            targetX,
            targetY,
          })
        }
      }
    }

    spokeSpringsRef.current = newSprings

    // Sync composite springs (one per active group)
    const existingComposites = compositeSpringsRef.current
    const newComposites = new Map<string, CompositeSpring>()
    for (const c of activeComposites) {
      const offset = singleHubOffsetFor(c.id)
      const existing = existingComposites.get(c.id)
      if (existing) {
        existing.hubIds = c.hubIds
        existing.memberIds = c.memberIds
        existing.singleHubOffsetX = offset.x
        existing.singleHubOffsetY = offset.y
        newComposites.set(c.id, existing)
      } else {
        // Initial position: targets vary by hub-count
        //   - single-hub: hub center + satellite offset
        //   - multi-hub: centroid of hubs
        let cx = width / 2, cy = height / 2
        if (c.hubIds.length === 1) {
          const hub = newHubMap.get(c.hubIds[0])
          if (hub) {
            cx = (hub.x ?? width / 2) + offset.x
            cy = (hub.y ?? height / 2) + offset.y
          }
        } else {
          let sumX = 0, sumY = 0, count = 0
          for (const hubId of c.hubIds) {
            const hub = newHubMap.get(hubId)
            if (hub) { sumX += hub.x ?? 0; sumY += hub.y ?? 0; count++ }
          }
          if (count > 0) { cx = sumX / count; cy = sumY / count }
        }
        newComposites.set(c.id, {
          id: c.id,
          groupId: c.id,
          hubIds: c.hubIds,
          memberIds: c.memberIds,
          singleHubOffsetX: offset.x,
          singleHubOffsetY: offset.y,
          x: cx, y: cy, vx: 0, vy: 0,
          targetX: cx, targetY: cy,
        })
      }
    }
    compositeSpringsRef.current = newComposites

    // Reheat hub sim
    const countChanged = sessions.length !== prevSessionCountRef.current
    const hubCountChanged = newHubNodes.length !== existingHubMap.size
    const hadCachedPositions = newHubNodes.some((h) => hubPositionCache.has(h.id))
    prevSessionCountRef.current = sessions.length

    if (hubCountChanged) {
      // Layout genuinely needs to change — unpin so hubs can re-solve,
      // then reheat.
      for (const h of newHubNodes) {
        h.fx = null
        h.fy = null
      }
      sim.alpha(hadCachedPositions ? 0.05 : 0.3)
    } else if (countChanged) {
      // Same projects, different spoke counts — nudge, don't uproot.
      sim.alpha(0.05)
    }

    // If composites changed (formed/dissolved), kick the spring system into life
    // even if d3-force hasn't reheated. The repulsion + elastic-restore needs at
    // least one frame to kick in.
    if (activeComposites.length !== existingComposites.size || dissolvedMemberStarts.size > 0) {
      // Bump every spring's velocity slightly so animation continues until settled.
      for (const s of newSprings.values()) {
        s.vx += (Math.random() - 0.5) * 0.4
        s.vy += (Math.random() - 0.5) * 0.4
      }
    }

    startAnimation()
  }, [sessions, width, height, activeComposites, memberIdSet])

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

  return { hubs, spokes, composites, edges, contentBounds, nudge }
}
