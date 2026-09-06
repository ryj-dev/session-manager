import { useRef, useEffect, useState, useMemo } from 'react'
import {
  computeHubTargets,
  clusterBox,
  boxAt,
  boxFromCenter,
  boxSeparation,
  HUB_PILL_HALF_W,
  HUB_PILL_HALF_H,
  computeSpokeOffsets,
  stepSprings,
  projectColor,
  rectEdgePoint,
  stableHash,
  BASE_RADIUS,
  RING_GAP,
  THUMB_WIDTH,
  THUMB_HEIGHT,
  type Box,
  type HubNode,
  type HubSlot,
  type SpokeTarget,
  type SpringNode
} from '../lib/simulation'
import { buildSpawnForest, recordLineage, type TreeNode } from '../lib/spawn-tree'
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
  /**
   * Session this edge runs *from*, when it is a spawn link rather than a hub
   * spoke. `hubX`/`hubY` then carry the point on that parent's perimeter facing
   * the child, already computed — the renderer draws from there as-is.
   */
  parentId?: string
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

// ── Hub layout ─────────────────────────────────────────────────────────
//
// computeHubTargets packs the clusters and the hubs spring to those targets
// with the same integrator the thumbnails use. There is no annealing, no
// anchoring and no reheating, so the layout has no history to accumulate into.
//
// Two pieces of state make the arrangement STABLE, which is a stronger promise
// than reproducible and the one the view actually needs — the user navigates by
// remembering that a session is over there:
//
//   * hubOrder — first-seen order of projects. Decides pack order, and so who
//     keeps their place when two clusters collide (the longer-established one).
//   * hubSlots — the position each hub was last given. Passed back in as the
//     pinned set, so an existing hub reuses its own coordinates and only ever
//     moves when its cluster has grown into a neighbour it must yield to.
//
// Persisting coordinates was tried before and removed, because back then they
// were the ANNEALER's output: reloading them re-anchored the simulation to
// wherever it had last drifted to, and the drift compounded every reheat. A
// pack slot carries no such feedback — nothing reads it but the collision test
// that decides whether to keep it — so there is no loop to accumulate.
//
// Re-layout (Settings) drops both, so the arrangement is rebuilt from the
// current project list in its canonical, densest form.

const HUB_ORDER_KEY = 'graph.hubOrder.v1'
const HUB_SLOTS_KEY = 'graph.hubSlots.v1'
const RELAYOUT_EVENT = 'graph:relayout'

/** First-seen order of project paths. Index = pack order in computeHubTargets. */
function loadHubOrder(): string[] {
  try {
    const raw = localStorage.getItem(HUB_ORDER_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveHubOrder(order: string[]): void {
  try {
    localStorage.setItem(HUB_ORDER_KEY, JSON.stringify(order))
  } catch {
    /* quota or unavailable — ignore */
  }
}

let hubOrder = loadHubOrder()

/** Last position given to each project's hub, in the packing frame. */
function loadHubSlots(): Map<string, HubSlot> {
  const out = new Map<string, HubSlot>()
  try {
    const raw = localStorage.getItem(HUB_SLOTS_KEY)
    if (!raw) return out
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return out
    for (const [id, slot] of Object.entries(parsed as Record<string, unknown>)) {
      if (!slot || typeof slot !== 'object') continue
      const { x, y } = slot as { x?: unknown; y?: unknown }
      if (typeof x !== 'number' || typeof y !== 'number') continue
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      out.set(id, { x, y })
    }
  } catch {
    /* malformed or unavailable — pack from scratch */
  }
  return out
}

function saveHubSlots(slots: ReadonlyMap<string, HubSlot>): void {
  try {
    localStorage.setItem(HUB_SLOTS_KEY, JSON.stringify(Object.fromEntries(slots)))
  } catch {
    /* quota or unavailable — ignore */
  }
}

let hubSlots = loadHubSlots()

/**
 * Remember where the pack put each hub, so the next recompute can hand the same
 * positions back as pins. Only the projects currently on the graph are kept: a
 * slot held by a project that has gone away would keep reserving space in the
 * collision test forever, and the point of releasing it is that the hubs behind
 * it can slide inward to fill the gap.
 */
function rememberHubSlots(slots: ReadonlyMap<string, HubSlot>): void {
  const next = new Map(slots)
  let changed = next.size !== hubSlots.size
  if (!changed) {
    for (const [id, slot] of next) {
      const prev = hubSlots.get(id)
      if (!prev || prev.x !== slot.x || prev.y !== slot.y) { changed = true; break }
    }
  }
  if (!changed) return
  hubSlots = next
  saveHubSlots(hubSlots)
}

// Positions used to be persisted (hub x/y, spoke x/y) back when the layout was
// annealed and could not be reproduced. Both are derived now, so the old keys
// are dead weight in the user's storage — and the hub one holds the drifted
// coordinates the old simulation left behind. Clear them once.
try {
  localStorage.removeItem('graph.hubPositions.v1')
  localStorage.removeItem('graph.spokePositions.v1')
} catch {
  /* unavailable — nothing to clean up */
}

/**
 * Pack order for the current hub set: known projects in first-seen order, then
 * any newcomers appended. Prunes projects that are no longer around, so a slot
 * freed by a closed project is reused instead of leaving a permanent hole.
 */
function orderHubs<T extends { id: string }>(hubs: T[]): T[] {
  const byId = new Map(hubs.map((h) => [h.id, h]))
  const known = hubOrder.filter((id) => byId.has(id))
  const fresh = hubs.filter((h) => !hubOrder.includes(h.id)).map((h) => h.id).sort()
  const next = [...known, ...fresh]
  if (next.length !== hubOrder.length || next.some((id, i) => hubOrder[i] !== id)) {
    hubOrder = next
    saveHubOrder(hubOrder)
  }
  return next.map((id) => byId.get(id)!)
}

/**
 * Rebuild the layout in its canonical form, forgetting which project arrived
 * when. Safe to call from anywhere in the renderer — if the graph isn't
 * mounted, the next mount picks up the cleared order anyway.
 */
export function requestGraphRelayout(): void {
  hubOrder = []
  saveHubOrder(hubOrder)
  hubSlots = new Map()
  saveHubSlots(hubSlots)
  window.dispatchEvent(new Event(RELAYOUT_EVENT))
}

// Extended spring node that knows its hub and spoke offset
interface SpokeSpring extends SpringNode {
  hubId: string
  /** Set when this session hangs off another session rather than the hub. */
  parentId?: string
  offsetX: number
  offsetY: number
  anchorOffsetX: number // fixed edge attachment relative to spoke center
  anchorOffsetY: number
}

/** Padding beyond the parent thumbnail's perimeter where a spawn edge starts. */
const PARENT_EDGE_GAP = 5

/**
 * Edge from a session to whatever it hangs off. Spawn children run from a point
 * on their parent thumbnail's perimeter; everything else runs from its hub,
 * whose pill attachment the renderer works out (it owns the pill's width).
 * Returns null when neither endpoint is laid out yet.
 */
function spokeEdge(
  spring: SpokeSpring,
  hubMap: Map<string, HubNode>,
  springById: Map<string, SpokeSpring>
): EdgeData | null {
  const spokeAnchorX = spring.x + spring.anchorOffsetX
  const spokeAnchorY = spring.y + spring.anchorOffsetY

  if (spring.parentId) {
    const parent = springById.get(spring.parentId)
    if (parent) {
      const from = rectEdgePoint(
        parent.x, parent.y,
        spring.x, spring.y,
        THUMB_WIDTH / 2 + PARENT_EDGE_GAP,
        THUMB_HEIGHT / 2 + PARENT_EDGE_GAP
      )
      return {
        hubX: from.x,
        hubY: from.y,
        spokeX: spring.x,
        spokeY: spring.y,
        spokeAnchorX,
        spokeAnchorY,
        hubId: spring.hubId,
        parentId: spring.parentId,
      }
    }
    // Parent gone this frame — fall back to the hub rather than dropping the edge.
  }

  const hub = hubMap.get(spring.hubId)
  if (!hub) return null
  return {
    hubX: hub.x ?? 0,
    hubY: hub.y ?? 0,
    spokeX: spring.x,
    spokeY: spring.y,
    spokeAnchorX,
    spokeAnchorY,
    hubId: spring.hubId,
  }
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

// ── Composite target resolution ────────────────────────────────────────

const RESOLVE_PAD = 18
const RESOLVE_ITERATIONS = 8

/**
 * Move composite targets so they don't overlap spoke slots, hub pills, or one
 * another. Spokes and hubs are fixed obstacles (their positions are the stable
 * frame the user navigates by); composites take the whole correction, split
 * evenly between two composites. Iterative separation along the least-overlap
 * axis — a few passes are enough for the handful of composites a graph ever has.
 */
function resolveCompositeTargets(
  composites: CompositeSpring[],
  spokes: SpokeSpring[],
  hubs: HubNode[]
): void {
  const cHW = COMPOSITE_WIDTH / 2 + RESOLVE_PAD
  const cHH = COMPOSITE_HEIGHT / 2 + RESOLVE_PAD
  const obstacles: Box[] = []
  for (const s of spokes) {
    obstacles.push(boxFromCenter(s.targetX, s.targetY, THUMB_WIDTH / 2, THUMB_HEIGHT / 2))
  }
  for (const h of hubs) {
    obstacles.push(boxFromCenter(h.x, h.y, HUB_PILL_HALF_W, HUB_PILL_HALF_H))
  }

  for (let iter = 0; iter < RESOLVE_ITERATIONS; iter++) {
    let moved = false
    for (let i = 0; i < composites.length; i++) {
      const c = composites[i]
      let rc = boxFromCenter(c.targetX, c.targetY, cHW, cHH)
      for (const o of obstacles) {
        const mtv = boxSeparation(rc, o)
        if (mtv) { rc = boxAt(rc, mtv.x, mtv.y); moved = true }
      }
      for (let j = i + 1; j < composites.length; j++) {
        const d = composites[j]
        const rd = boxFromCenter(d.targetX, d.targetY, cHW, cHH)
        const mtv = boxSeparation(rc, rd)
        if (mtv) {
          rc = boxAt(rc, mtv.x / 2, mtv.y / 2)
          d.targetX -= mtv.x / 2
          d.targetY -= mtv.y / 2
          moved = true
        }
      }
      c.targetX = (rc.minX + rc.maxX) / 2
      c.targetY = (rc.minY + rc.maxY) / 2
    }
    if (!moved) break
  }
}

// ── Spoke position cache ───────────────────────────────────────────────
// Where each thumbnail currently is, so a remount picks up from where the user
// last saw it instead of every node re-springing out of its hub. In memory
// only: positions are derived (hub target + deterministic spoke offset), so
// there is nothing worth writing to disk — after a renderer reload the first
// sync seeds every spoke straight at its target, which is where the cache
// would have put it anyway.

const spokeSpringCache = new Map<string, SpokeSpring>()

/**
 * True until the first sessions sync of this renderer has run. A brand new
 * session springs out of its hub, which is the right animation for something
 * that just appeared — but on a cold start *every* session is new, and a
 * screenful of thumbnails flying outward is not an entrance, it's a mess
 * (renderer reloads happen on their own, notably on GPU crashes during screen
 * lock). On that first sync only, spokes start where they belong.
 */
let awaitingFirstSync = true

/**
 * Every spawn link seen this run (child id → spawner id), including sessions
 * that have since closed. Lets a child climb to a live *grand*parent when its
 * own parent exits, instead of dropping to the hub. In-memory only: spawn
 * linkage isn't persisted, so an app restart flattens existing trees.
 */
const spawnLineage = new Map<string, string>()



// ── Hook ───────────────────────────────────────────────────────────────

export function useSimulation(width: number, height: number): SimulationResult {
  // Attached (overlay) terminals are UI-only children of their parent Claude session —
  // they have a live PTY but no graph presence. Filter via useMemo: a selector
  // that calls .filter() returns a new array each render and triggers an infinite
  // Zustand re-render loop (Object.is on the array never matches).
  const allSessions = useStore((s) => s.sessions)
  const sessions = useMemo(() => allSessions.filter((x) => !x.isAttached && !x.isPipeline && !x.isScheduled && !x.isGithub), [allSessions])
  const splitGroups = useStore((s) => s.splitGroups)
  const hubNodesRef = useRef<HubNode[]>([])
  const hubMapRef = useRef<Map<string, HubNode>>(new Map())
  const spokeSpringsRef = useRef<Map<string, SpokeSpring>>(new Map())
  const compositeSpringsRef = useRef<Map<string, CompositeSpring>>(new Map())
  // Last-known position per composite, refreshed each tick. Consumed by the
  // sync effect when a composite dissolves so its members can spring back from
  // the composite's final location instead of snapping to their cached spoke.
  const compositePositionHistoryRef = useRef<Map<string, { x: number; y: number; memberIds: string[] }>>(new Map())
  const rafRef = useRef<number>(0)
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
    const hubNodes = hubNodesRef.current
    const hubMap = hubMapRef.current
    const springs = spokeSpringsRef.current
    const composites = compositeSpringsRef.current

    // Hubs spring toward the targets computed by the sessions effect.
    const hubsSettled = stepSprings(hubNodes)

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

    const springArray = [...springs.values()]
    const compositeArray = [...composites.values()]

    // Composites live outside the d3 hub collision: a multi-hub composite
    // wants the centroid of its hubs (which can be anywhere, including on top
    // of another cluster) and a single-hub one wants a hashed satellite slot.
    // Resolve their TARGETS against spoke slots, hub pills and each other
    // before the springs run — a velocity nudge can't hold more than ~40px
    // against the spring, so overlap has to be fixed where the node is going,
    // not where it is. Recomputed every tick from the same inputs, so the
    // resolved targets are stable and the springs settle normally.
    if (compositeArray.length > 0) {
      resolveCompositeTargets(compositeArray, springArray, hubNodes)
    }

    // Step both spring sets
    const spokesSettled = stepSprings(springArray)
    const compositesSettled = stepSprings(compositeArray)

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
    const springById = new Map(springArray.map((s) => [s.id, s]))
    for (const spring of springArray) {
      const edge = spokeEdge(spring, hubMap, springById)
      if (edge) edgeData.push(edge)
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
    if (!spokesSettled || !compositesSettled || !hubsSettled) {
      rafRef.current = requestAnimationFrame(() => tickRef.current())
    } else {
      const liveSpokeIds = new Set(springArray.map((s) => s.id))
      for (const key of spokeSpringCache.keys()) {
        if (!liveSpokeIds.has(key)) spokeSpringCache.delete(key)
      }
      animatingRef.current = false
    }
  }

  // ── Start animation (no-op if already running) ─────────────────────

  function startAnimation(): void {
    if (animatingRef.current) return
    animatingRef.current = true
    rafRef.current = requestAnimationFrame(() => tickRef.current())
  }

  // ── Relayout (Settings button) ─────────────────────────────────────
  //
  // requestGraphRelayout has already cleared the saved order; all this has to
  // do is recompute targets from it. Bumping a counter re-runs the sessions
  // effect, which is the single place hub targets are assigned.

  const [relayoutNonce, setRelayoutNonce] = useState(0)

  useEffect(() => {
    const onRelayout = (): void => setRelayoutNonce((n) => n + 1)
    window.addEventListener(RELAYOUT_EVENT, onRelayout)
    return () => window.removeEventListener(RELAYOUT_EVENT, onRelayout)
  }, [])

  useEffect(() => () => {
    animatingRef.current = false
    cancelAnimationFrame(rafRef.current)
  }, [])

  // ── Sync sessions → hub nodes + spoke springs ─────────────────────

  useEffect(() => {
    if (width === 0 || height === 0) return

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
        // Position is assigned below, once every footprint is known. A brand
        // new hub starts life at its target rather than flying in from
        // nowhere — only hubs that already have a position animate.
        const node: HubNode = {
          id: projectPath,
          projectName: group.projectName,
          color: projectColor(projectPath),
          sessionCount: group.sessionIds.length,
          x: NaN,
          y: NaN,
          vx: 0,
          vy: 0,
          targetX: 0,
          targetY: 0,
        }
        newHubNodes.push(node)
        newHubMap.set(projectPath, node)
      }
    }

    hubNodesRef.current = newHubNodes
    hubMapRef.current = newHubMap

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

    // Sync spoke springs — skip member sessions (those are inside composites).
    // Sessions their spawner is waiting on hang off that spawner instead of the
    // hub; buildSpawnForest resolves that (including re-attaching orphans to a
    // live ancestor) from the sessions that actually get a graph node.
    const existingSprings = spokeSpringsRef.current
    const newSprings = new Map<string, SpokeSpring>()

    const spawnInput = sessions.map((x) => ({
      id: x.id,
      projectPath: x.projectPath,
      spawnParentId: x.spawnParentId,
      reportBack: x.reportBack,
    }))
    // Lineage records every session, composite members included — a hidden
    // member is still a real link in a chain its children need to climb.
    recordLineage(spawnLineage, spawnInput)
    const forest = buildSpawnForest(spawnInput.filter((x) => !memberIdSet.has(x.id)), spawnLineage)

    // Pass 1: lay out each cluster's spokes and record its footprint. The hub
    // positions depend on these footprints, and the spoke targets depend on the
    // hub positions, so the two have to be worked out in that order.
    const offsetsByProject = new Map<string, SpokeTarget[]>()
    for (const [projectPath, group] of groups) {
      const visibleIds = group.sessionIds.filter((id) => !memberIdSet.has(id))
      if (visibleIds.length === 0) continue
      const roots: TreeNode[] = forest.byProject.get(projectPath) ?? []
      let offsets = computeSpokeOffsets(roots, projectPath)
      // Safety net: a session missing from the forest would have no spring and
      // would silently disappear from the graph. The topology is meant to make
      // that impossible, so fall back to the flat ring rather than dropping it.
      if (offsets.length !== visibleIds.length) {
        console.warn('[graph] spawn forest dropped sessions — falling back to the ring layout')
        offsets = computeSpokeOffsets(visibleIds.map((id) => ({ id, children: [] })), projectPath)
      }
      offsetsByProject.set(projectPath, offsets)

      const hub = newHubMap.get(projectPath)!
      const box = clusterBox(offsets)
      // A single-hub composite sits outside the spoke ring, so it widens the
      // footprint when present. Its slot is at a hashed angle, so reserve room
      // for it in every direction rather than guessing which one.
      const hasComposite = activeComposites.some(
        (c) => c.hubIds.length === 1 && c.hubIds[0] === projectPath
      )
      if (hasComposite) {
        const reach = BASE_RADIUS + RING_GAP * 0.85 + COMPOSITE_WIDTH / 2
        box.minX = Math.min(box.minX, -reach)
        box.maxX = Math.max(box.maxX, reach)
        box.minY = Math.min(box.minY, -reach)
        box.maxY = Math.max(box.maxY, reach)
      }
      hub.box = box
    }

    // Pass 2: place the hubs. Established projects are pinned to the slot they
    // already hold; only newcomers, and the rare hub whose cluster has grown
    // into a neighbour, are packed afresh.
    const hubTargets = computeHubTargets(orderHubs(newHubNodes), width, height, hubSlots)
    rememberHubSlots(hubTargets)
    for (const hub of newHubNodes) {
      const t = hubTargets.get(hub.id)
      if (!t) continue
      hub.targetX = t.x
      hub.targetY = t.y
      // A hub with no position yet (new project) starts at its target; one that
      // already has a position springs there, which is what animates the slide
      // inward when a neighbouring project closes.
      if (!Number.isFinite(hub.x) || !Number.isFinite(hub.y)) {
        hub.x = t.x
        hub.y = t.y
        hub.vx = 0
        hub.vy = 0
      }
    }

    // Pass 3: attach the spoke springs to their hubs.
    for (const [projectPath, offsets] of offsetsByProject) {
      const hub = newHubMap.get(projectPath)!
      const hubX = hub.x
      const hubY = hub.y

      for (const offset of offsets) {
        const existing = existingSprings.get(offset.id)
        if (existing) {
          existing.hubId = projectPath
          existing.parentId = offset.parentId
          existing.offsetX = offset.offsetX
          existing.offsetY = offset.offsetY
          existing.anchorOffsetX = offset.anchorOffsetX
          existing.anchorOffsetY = offset.anchorOffsetY
          existing.targetX = hubX + offset.offsetX
          existing.targetY = hubY + offset.offsetY
          newSprings.set(offset.id, existing)
        } else {
          // Four sources for initial position, in priority order:
          //   1. Just-dissolved composite — start at its last position with
          //      a velocity impulse toward the spoke target (elastic feel).
          //   2. Spring cache — restore previous on-graph position.
          //   3. First sync of this renderer — start settled at the target.
          //   4. Hub center — a session that has genuinely just appeared.
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
            // Exactly where it was, at rest. This used to get a small random
            // velocity for "re-entry liveness", which made sense when the hub
            // simulation reheated on every mount and everything was moving
            // anyway. Now the layout is identical across mounts, so the nudge
            // is the *only* motion: every thumbnail jittering for a second on
            // every return to the graph, for no reason.
            startX = cached.x
            startY = cached.y
            vx = 0
            vy = 0
          } else if (awaitingFirstSync) {
            startX = targetX
            startY = targetY
            vx = 0
            vy = 0
          } else {
            startX = hubX
            startY = hubY
            vx = 0
            vy = 0
          }

          newSprings.set(offset.id, {
            id: offset.id,
            hubId: projectPath,
            parentId: offset.parentId,
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
    awaitingFirstSync = false

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
        // Fallbacks are the ORIGIN, not the viewport centre: hub coordinates
        // live in the pack's own frame, which is centred on 0,0 and left for
        // the camera to place (see computeHubTargets).
        let cx = 0, cy = 0
        if (c.hubIds.length === 1) {
          const hub = newHubMap.get(c.hubIds[0])
          if (hub) {
            cx = (hub.x ?? 0) + offset.x
            cy = (hub.y ?? 0) + offset.y
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

    // If composites changed (formed/dissolved), kick the springs into life. The
    // repulsion + elastic-restore needs at least one frame to take effect.
    if (activeComposites.length !== existingComposites.size || dissolvedMemberStarts.size > 0) {
      // Bump every spring's velocity slightly so animation continues until settled.
      for (const s of newSprings.values()) {
        s.vx += (Math.random() - 0.5) * 0.4
        s.vy += (Math.random() - 0.5) * 0.4
      }
    }

    // Emit a synchronous snapshot of positions before the next paint.
    // Without this, React's render after `sessions` changes uses the previous
    // tick's `spokes`/`edges`/`composites` state — which still includes nodes
    // that were just removed. That one-frame gap leaves a ghost of the closed
    // session (and its stale spoke slot can collide with the next-selected
    // session's new slot, producing overlapping renders). The next tick will
    // overwrite these values anyway; we're just front-running it.
    {
      const hubNodes = hubNodesRef.current
      const springArray = [...newSprings.values()]
      const compositeArray = [...newComposites.values()]
      const hubMap = newHubMap

      const hubPositions: HubPosition[] = hubNodes.map((h) => ({
        id: h.id,
        projectName: h.projectName,
        x: h.x ?? 0,
        y: h.y ?? 0,
        color: h.color,
      }))
      const spokePositions: SpokePosition[] = springArray.map((s) => ({
        id: s.id,
        hubId: s.hubId,
        x: s.x,
        y: s.y,
      }))
      const compositePositions: CompositePosition[] = compositeArray.map((c) => ({
        id: c.groupId,
        hubIds: c.hubIds,
        memberIds: c.memberIds,
        x: c.x,
        y: c.y,
      }))
      const edgeData: EdgeData[] = []
      const springById = new Map(springArray.map((s) => [s.id, s]))
      for (const spring of springArray) {
        const edge = spokeEdge(spring, hubMap, springById)
        if (edge) edgeData.push(edge)
      }
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
      setHubsRef.current(hubPositions)
      setSpokesRef.current(spokePositions)
      setCompositesRef.current(compositePositions)
      setEdgesRef.current(edgeData)
    }

    startAnimation()
    // relayoutNonce is a deliberate trigger: Settings → Re-layout clears the
    // saved hub order, and bumping it re-runs this effect so the pack is
    // recomputed. Hubs then spring from where they are to their new slots.
  }, [sessions, width, height, activeComposites, memberIdSet, relayoutNonce])

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
