import {
  forceSimulation,
  forceManyBody,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum
} from 'd3-force'
import type { TreeNode } from './spawn-tree'

// ── Types ──────────────────────────────────────────────────────────────

export interface HubNode extends SimulationNodeDatum {
  id: string // projectPath used as id
  projectName: string
  color: string
  sessionCount: number
  /**
   * Soft anchor: the position this hub settled at last time. Anchored hubs are
   * pulled back toward it (instead of being hard-pinned via fx/fy) so the
   * collision force can still shove them just far enough to clear an overlap.
   * Cleared to let a hub participate in a fresh layout / compaction pass.
   */
  anchorX?: number
  anchorY?: number
  /**
   * Actual footprint radius from the spokes currently laid out around this
   * hub (see clusterExtent). Falls back to clusterRadius(sessionCount), the
   * worst-case estimate, when unset.
   */
  radius?: number
}

export interface SpokeTarget {
  id: string // session id
  hubId: string
  offsetX: number // deterministic offset from hub
  offsetY: number
  anchorOffsetX: number // fixed edge attachment point relative to spoke center
  anchorOffsetY: number
  /** Session this node hangs off, when it is a spawn child rather than a
   *  hub spoke. Its edge runs to that session instead of to the hub. */
  parentId?: string
  /** 0 for hub spokes, 1 for their children, and so on. */
  depth: number
}

export interface SpringNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  targetX: number
  targetY: number
}

export interface GraphEdge {
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  hubId: string
}

// ── Color hashing ──────────────────────────────────────────────────────

function hashString(str: string): number {
  // MurmurHash3-inspired: accumulate then finalize with avalanche mixing
  // so similar strings (shared prefixes) produce well-distributed outputs
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // Avalanche: ensure every input bit affects every output bit
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0 // unsigned
}

// Golden angle (137.508°) spreading — maximally separates hues even for
// consecutive hash values, then remap into "good" hue zones.
// Excluded: ~30-55 (muddy yellow/brown) and ~70-85 (dull olive).
const GOOD_HUE_RANGES = [
  [0, 30],    // red → orange
  [55, 70],   // gold → yellow-green
  [85, 360],  // green → cyan → blue → purple → magenta → red
] as const

const GOOD_HUE_TOTAL = GOOD_HUE_RANGES.reduce((sum, [a, b]) => sum + (b - a), 0) // ~290°

function hashToHue(hash: number): number {
  // Golden angle spreading for maximum separation
  const spread = (hash * 137.508) % GOOD_HUE_TOTAL
  let t = spread
  for (const [start, end] of GOOD_HUE_RANGES) {
    const span = end - start
    if (t < span) return start + t
    t -= span
  }
  return 0
}

/** Normalize to the last path segment so a project path and its bare name hash identically. */
function projectKey(input: string): string {
  const parts = input.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : input
}

export function projectColor(projectPath: string): string {
  const hash = hashString(projectKey(projectPath))
  const hue = hashToHue(hash)
  const sat = 50 + (hash >>> 8) % 20
  const lit = 55 + (hash >>> 16) % 10
  return `hsl(${hue}, ${sat}%, ${lit}%)`
}

export function projectColorDim(projectPath: string): string {
  const hash = hashString(projectKey(projectPath))
  const hue = hashToHue(hash)
  return `hsl(${hue}, 35%, 18%)`
}

export function projectColorMid(projectPath: string): string {
  const hash = hashString(projectKey(projectPath))
  const hue = hashToHue(hash)
  return `hsl(${hue}, 40%, 35%)`
}

export function projectColorGlow(projectPath: string): string {
  const hash = hashString(projectKey(projectPath))
  const hue = hashToHue(hash)
  return `0 0 14px 2px hsla(${hue}, 60%, 50%, 0.45)`
}

// ── Seeded random (deterministic per-project) ──────────────────────────

function seededRandom(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 16807 + 0) % 2147483647
    return (s - 1) / 2147483646
  }
}

// ── Layout constants ───────────────────────────────────────────────────

export const THUMB_WIDTH = 192
export const THUMB_HEIGHT = 120
const MIN_SPOKE_SPACING = 30 // min gap between thumbnail edges
export const BASE_RADIUS = 200
export const RING_GAP = 180
/** Tighter first ring for one- or two-session projects so a lone thumbnail
 *  doesn't reserve a 600px-wide collision circle around its hub. */
const SMALL_CLUSTER_RADIUS = 150
const SMALL_CLUSTER_MAX = 2

/** Radius of ring `ring` (0-based) for a project with `sessionCount` sessions. */
function ringRadius(ring: number, sessionCount: number): number {
  if (ring === 0 && sessionCount <= SMALL_CLUSTER_MAX) return SMALL_CLUSTER_RADIUS
  return BASE_RADIUS + ring * RING_GAP
}

// The hub pill and the thumbnail are both wide, flat rectangles, so a fixed
// centre-to-centre radius leaves almost no visible edge when the spoke runs
// sideways (pill half-width + thumb half-width ≈ the whole radius) while
// wasting space when it runs up or down. Enforce the gap between the two
// rectangles' perimeters along the spoke direction instead.
const HUB_PILL_HALF_W = 120 // generous: long project names render ~240px wide
const HUB_PILL_HALF_H = 16
const MIN_EDGE_GAP = 56 // visible edge length between pill and thumbnail

/** Smallest hub→thumbnail centre distance at `angle` that keeps MIN_EDGE_GAP of visible edge. */
function minSpokeDistance(angle: number): number {
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  const pill = rectEdgePoint(0, 0, dx, dy, HUB_PILL_HALF_W, HUB_PILL_HALF_H)
  const thumb = rectEdgePoint(0, 0, dx, dy, THUMB_WIDTH / 2, THUMB_HEIGHT / 2)
  return Math.hypot(pill.x, pill.y) + Math.hypot(thumb.x, thumb.y) + MIN_EDGE_GAP
}

/** Upper bound of minSpokeDistance over all angles (the sideways case). */
const MAX_MIN_SPOKE_DISTANCE = HUB_PILL_HALF_W + THUMB_WIDTH / 2 + MIN_EDGE_GAP

/**
 * Stable, well-distributed hash → 32-bit unsigned integer.
 * Re-export so consumers can derive deterministic per-group values.
 */
export function stableHash(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

// ── Hub simulation (repulsion + collision to keep clusters apart) ──────

/** Compute the outermost ring radius for a given number of sessions */
export function clusterRadius(sessionCount: number): number {
  if (sessionCount === 0) return 0
  let placed = 0
  let ring = 0
  while (placed < sessionCount) {
    placed += spokeCapacity(ringRadius(ring, sessionCount))
    ring++
  }
  // Outermost ring radius (or the sideways edge-gap floor, whichever is
  // larger) + half a thumbnail for the node extent
  const outerRing = Math.max(ringRadius(ring - 1, sessionCount), MAX_MIN_SPOKE_DISTANCE)
  return outerRing + Math.max(THUMB_WIDTH, THUMB_HEIGHT) / 2
}

/**
 * Footprint radius of a laid-out cluster: the farthest spoke centre plus half a
 * thumbnail. Tighter than clusterRadius() because it uses the real angles —
 * a lone thumbnail hanging below its hub needs far less room than one beside it.
 */
export function clusterExtent(targets: SpokeTarget[]): number {
  let max = 0
  for (const t of targets) {
    max = Math.max(max, Math.hypot(t.offsetX, t.offsetY))
  }
  return max + Math.max(THUMB_WIDTH, THUMB_HEIGHT) / 2
}

// Anchor pull for settled hubs. Strong enough to hold a hub where the user
// last saw it against the residual many-body repulsion, weak enough that the
// collision force (which ignores alpha) wins when two clusters overlap.
const ANCHOR_STRENGTH = 0.3
// Centering pull for hubs that have no anchor yet (new / relayout / compaction).
const CENTER_STRENGTH = 0.08

interface LayoutForce {
  (alpha: number): void
  initialize?: (nodes: HubNode[]) => void
  setCenter: (width: number, height: number) => void
}

/**
 * Combined anchor + centering force.
 *
 * - Anchored hubs are pulled toward their anchor and feel NO centering pull.
 *   (Centering an anchored hub would ratchet it toward the middle a little on
 *   every reheat, since each settle re-anchors at the drifted position.)
 * - Unanchored hubs are pulled toward the viewport center. The pull is
 *   aspect-aware: weaker along the long axis of the viewport, so the
 *   equilibrium stretches to fill a wide window instead of forming a blob
 *   (which, with a handful of hubs, tends to line up vertically).
 */
function forceLayout(width: number, height: number): LayoutForce {
  let nodes: HubNode[] = []
  let cx = width / 2
  let cy = height / 2
  let sx = CENTER_STRENGTH
  let sy = CENTER_STRENGTH

  const force = ((alpha: number): void => {
    for (const n of nodes) {
      const x = n.x ?? 0
      const y = n.y ?? 0
      if (n.anchorX != null && n.anchorY != null) {
        n.vx = (n.vx ?? 0) + (n.anchorX - x) * ANCHOR_STRENGTH * alpha
        n.vy = (n.vy ?? 0) + (n.anchorY - y) * ANCHOR_STRENGTH * alpha
      } else {
        n.vx = (n.vx ?? 0) + (cx - x) * sx * alpha
        n.vy = (n.vy ?? 0) + (cy - y) * sy * alpha
      }
    }
  }) as LayoutForce

  force.initialize = (ns: HubNode[]): void => {
    nodes = ns
  }
  force.setCenter = (w: number, h: number): void => {
    cx = w / 2
    cy = h / 2
    // Long axis gets the weaker pull, short axis the stronger, both scaled by
    // the aspect ratio. The contrast has to be large: with a few hubs the
    // layout is a collision packing, and only a clear energy difference
    // between "row along the long axis" and "diamond" breaks the symmetry.
    const aspect = w > 0 && h > 0 ? w / h : 1
    const clamp = (v: number): number => Math.max(CENTER_STRENGTH * 0.3, Math.min(CENTER_STRENGTH * 3, v))
    sx = clamp(CENTER_STRENGTH / aspect)
    sy = clamp(CENTER_STRENGTH * aspect)
  }
  force.setCenter(width, height)
  return force
}

export function createHubSimulation(
  width: number,
  height: number
): Simulation<HubNode, never> {
  return forceSimulation<HubNode>()
    .force('charge', forceManyBody<HubNode>().strength(-2000).distanceMax(2000))
    .force(
      'collide',
      forceCollide<HubNode>()
        .radius((d) => (d.radius ?? clusterRadius(d.sessionCount)) + 20)
        .strength(1)
        .iterations(2)
    )
    .force('layout', forceLayout(width, height))
    .alphaDecay(0.04)
    .velocityDecay(0.5)
    .alphaMin(0.001)
}

/** Re-target the centering pull after a viewport resize, without rebuilding the sim. */
export function setSimulationCenter(
  sim: Simulation<HubNode, never>,
  width: number,
  height: number
): void {
  const f = sim.force('layout') as LayoutForce | undefined
  f?.setCenter(width, height)
}

/** Anchor every hub at its current position (call once the sim has settled). */
export function anchorHubs(nodes: HubNode[]): void {
  for (const n of nodes) {
    n.anchorX = n.x
    n.anchorY = n.y
  }
}

/** Release every hub so it takes part in the next layout pass. */
export function releaseHubs(nodes: HubNode[]): void {
  for (const n of nodes) {
    n.anchorX = undefined
    n.anchorY = undefined
  }
}

// ── Spoke layout (deterministic ring positions) ────────────────────────

function spokeCapacity(radius: number): number {
  // How many thumbnails fit on a ring at this radius with minimum spacing.
  // Use the larger dimension (width) as the arc-length footprint per node —
  // this prevents overlap when adjacent thumbnails are at similar angles.
  const circumference = 2 * Math.PI * radius
  return Math.max(1, Math.floor(circumference / (THUMB_WIDTH + MIN_SPOKE_SPACING)))
}

/**
 * Lay out a project's sessions around its hub.
 *
 * `roots` is the project's spawn forest (see lib/spawn-tree): sessions that sit
 * on the hub, each carrying the awaited children that hang off it. With no
 * children anywhere — the common case — this is the original ring packing,
 * unchanged. With children, it switches to a radial tree: each root owns an
 * angular sector sized to fit its whole subtree, and descendants are placed
 * further out inside that sector, so no subtree can overlap its neighbours and
 * no parent→child edge crosses back over the hub.
 */
export function computeSpokeOffsets(
  roots: TreeNode[],
  projectPath: string
): SpokeTarget[] {
  if (roots.length === 0) return []
  return roots.some((r) => r.children.length > 0)
    ? computeTreeOffsets(roots, projectPath)
    : computeRingOffsets(roots.map((r) => r.id), projectPath)
}

function computeRingOffsets(
  sessionIds: string[],
  projectPath: string
): SpokeTarget[] {
  const count = sessionIds.length
  if (count === 0) return []

  const seed = hashString(projectPath)
  const rng = seededRandom(seed)
  const baseAngle = rng() * Math.PI * 2 // random starting angle per project

  const targets: SpokeTarget[] = []
  let placed = 0
  let ring = 0

  while (placed < count) {
    const radius = ringRadius(ring, count)
    const capacity = spokeCapacity(radius)
    const onThisRing = Math.min(capacity, count - placed)

    for (let i = 0; i < onThisRing; i++) {
      const angle = baseAngle + (2 * Math.PI * i) / onThisRing
      // For outer rings, offset the angle slightly to route between inner ring nodes
      const ringOffset = ring > 0 ? (Math.PI / onThisRing) * 0.5 : 0

      // Per-spoke jitter (deterministic via seeded rng) — slight angle and radius variation
      const angleJitter = (rng() - 0.5) * 0.15 // ±~4 degrees
      const radiusJitter = (rng() - 0.5) * 30   // ±15px

      const finalAngle = angle + ringOffset + angleJitter
      const jitteredRadius = Math.max(
        radius + radiusJitter,
        minSpokeDistance(finalAngle),
        hubClearanceDistance(finalAngle)
      )
      const oX = Math.cos(finalAngle) * jitteredRadius
      const oY = Math.sin(finalAngle) * jitteredRadius

      // Precompute fixed anchor: point on terminal rect facing the hub (toward origin)
      const anchor = rectEdgePoint(0, 0, -oX, -oY, THUMB_WIDTH / 2, THUMB_HEIGHT / 2)

      targets.push({
        id: sessionIds[placed],
        hubId: projectPath,
        offsetX: oX,
        offsetY: oY,
        anchorOffsetX: anchor.x,
        anchorOffsetY: anchor.y,
        depth: 0,
      })
      placed++
    }
    ring++
  }

  return targets
}

// ── Radial tree layout (spawn children hang off their parent) ──────────

/** Visible gap between a parent thumbnail and its child, along the spoke. */
const MIN_CHILD_EDGE_GAP = 44
/** Don't let a crowded tree push its ring out past this (px). */
const MAX_TREE_RING_RADIUS = 4000
/** Iterations allowed to grow the root ring until every subtree fits. */
const RING_FIT_ITERATIONS = 8

/**
 * Radial step from a parent thumbnail to its children.
 *
 * Deliberately direction-independent. A tempting optimisation is to measure the
 * gap along the subtree's own angle — two stacked thumbnails need far less room
 * than two side by side — but a child is also offset *angularly* from its
 * parent, so the line between them is not the radial one. Sizing the step for
 * the radial direction lets a near-vertical subtree place a child close enough
 * to overlap its parent diagonally.
 *
 * Two rectangles clear each other whenever their centres are at least
 * hypot(width, height) apart in any direction, and a child's radial step is a
 * lower bound on its distance from its parent, so one worst-case constant is
 * both correct and cheap.
 */
const CHILD_RING_GAP =
  2 * Math.hypot(THUMB_WIDTH / 2, THUMB_HEIGHT / 2) + MIN_CHILD_EDGE_GAP

/**
 * Centre-to-centre distance at which two thumbnails clear each other whatever
 * direction they lie in, plus breathing room. Same role as CHILD_RING_GAP, for
 * neighbours on a ring rather than a parent and its child.
 */
const SIBLING_CLEARANCE = Math.hypot(THUMB_WIDTH, THUMB_HEIGHT) + MIN_SPOKE_SPACING

/**
 * The angle a node must keep to itself at `radius` so its neighbour's centre is
 * SIBLING_CLEARANCE away. Neighbours are separated by the *chord* between them,
 * not the arc, and the two diverge sharply on a small ring — a fan-out placed
 * by arc length sits closer together than it thinks and overlaps.
 */
function selfNeed(radius: number): number {
  return 2 * Math.asin(Math.min(SIBLING_CLEARANCE / (2 * Math.max(radius, 1)), 1))
}

/**
 * How much of the hub circle a subtree needs, in radians, when its own node
 * sits at `radius`. A leaf needs room for itself; a parent needs whichever is
 * wider — itself, or all of its children side by side one level further out.
 */
function angularNeed(node: TreeNode, radius: number, gap: number): number {
  const self = selfNeed(radius)
  if (node.children.length === 0) return Math.min(self, Math.PI * 2)
  const childRadius = radius + gap
  let children = 0
  for (const child of node.children) children += angularNeed(child, childRadius, gap)
  return Math.min(Math.max(self, children), Math.PI * 2)
}

/**
 * Smallest hub→thumbnail distance at `angle` where the two bounding boxes come
 * apart. `minSpokeDistance` measures the gap along the spoke, which is not the
 * same thing: on a shallow diagonal the ray leaves both rectangles early and
 * the boxes still overlap. Roots take whichever floor is larger.
 */
function hubClearanceDistance(angle: number): number {
  const dx = Math.abs(Math.cos(angle))
  const dy = Math.abs(Math.sin(angle))
  const alongX = dx > 1e-6 ? (HUB_PILL_HALF_W + THUMB_WIDTH / 2) / dx : Infinity
  const alongY = dy > 1e-6 ? (HUB_PILL_HALF_H + THUMB_HEIGHT / 2) / dy : Infinity
  return Math.min(alongX, alongY)
}

function computeTreeOffsets(roots: TreeNode[], projectPath: string): SpokeTarget[] {
  // Same per-project rotation as the ring layout, so a project doesn't spin
  // when its first child appears.
  const rng = seededRandom(hashString(projectPath))
  const baseAngle = rng() * Math.PI * 2

  // Grow the root ring until every subtree fits around it. Needs shrink as the
  // radius grows (same arc, bigger circle), so a couple of passes converge.
  let radius = Math.max(ringRadius(0, roots.length), MAX_MIN_SPOKE_DISTANCE)
  for (let i = 0; i < RING_FIT_ITERATIONS; i++) {
    const total = totalNeed(roots, radius, CHILD_RING_GAP)
    if (total <= Math.PI * 2 || radius >= MAX_TREE_RING_RADIUS) break
    radius = Math.min(radius * (total / (Math.PI * 2)) * 1.02, MAX_TREE_RING_RADIUS)
  }

  // Hand each root a sector proportional to what it needs. Scaling by
  // 2π/total both compresses an over-full ring and spreads a sparse one, so a
  // two-session project still sits on opposite sides of its hub.
  const total = totalNeed(roots, radius, CHILD_RING_GAP)
  const scale = total > 0 ? (Math.PI * 2) / total : 0

  const targets: SpokeTarget[] = []
  let cursor = baseAngle
  for (const root of roots) {
    const width = angularNeed(root, radius, CHILD_RING_GAP) * scale
    placeSubtree(root, cursor, width, radius, projectPath, null, 0, 0, 0, targets)
    cursor += width
  }
  return targets
}

function totalNeed(roots: TreeNode[], radius: number, gap: number): number {
  let total = 0
  for (const root of roots) total += angularNeed(root, radius, gap)
  return total
}

/**
 * Place `node` at the middle of its sector and recurse into its children,
 * subdividing the sector between them. Children are packed around the parent's
 * own angle rather than spread to the sector edges, so a subtree reads as one
 * group and its edges stay short.
 */
function placeSubtree(
  node: TreeNode,
  sectorStart: number,
  sectorWidth: number,
  radius: number,
  projectPath: string,
  parentId: string | null,
  parentX: number,
  parentY: number,
  depth: number,
  targets: SpokeTarget[]
): void {
  const angle = sectorStart + sectorWidth / 2
  // Roots must still clear the hub pill; children are already placed a full
  // thumbnail gap beyond their parent. Pushing a root outward only widens the
  // arc its sector covers, so it can never crowd a neighbour.
  const r = parentId === null
    ? Math.max(radius, minSpokeDistance(angle), hubClearanceDistance(angle))
    : radius
  const offsetX = Math.cos(angle) * r
  const offsetY = Math.sin(angle) * r

  // The edge leaves this node's perimeter facing whatever it hangs off: the
  // hub at the origin for a root, the parent thumbnail otherwise.
  const anchor = rectEdgePoint(
    0, 0,
    parentX - offsetX, parentY - offsetY,
    THUMB_WIDTH / 2, THUMB_HEIGHT / 2
  )

  targets.push({
    id: node.id,
    hubId: projectPath,
    offsetX,
    offsetY,
    anchorOffsetX: anchor.x,
    anchorOffsetY: anchor.y,
    parentId: parentId ?? undefined,
    depth,
  })

  if (node.children.length === 0) return

  const childRadius = r + CHILD_RING_GAP
  const childTotal = totalNeed(node.children, childRadius, CHILD_RING_GAP)
  let cursor = angle - childTotal / 2
  for (const child of node.children) {
    const width = angularNeed(child, childRadius, CHILD_RING_GAP)
    placeSubtree(child, cursor, width, childRadius, projectPath, node.id, offsetX, offsetY, depth + 1, targets)
    cursor += width
  }
}

// ── Spring physics ─────────────────────────────────────────────────────

// ── Ray-rectangle intersection (edge attachment points) ────────────────

/**
 * Given a ray from `from` toward `to`, find where it exits a rectangle
 * centered at `from` with the given half-width and half-height.
 * Returns the intersection point on the rectangle perimeter.
 * If `from` and `to` are the same point, returns `from`.
 */
export function rectEdgePoint(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  halfW: number,
  halfH: number
): { x: number; y: number } {
  const dx = toX - fromX
  const dy = toY - fromY

  if (dx === 0 && dy === 0) return { x: fromX, y: fromY }

  // Scale factors to hit each edge
  // We want the smallest positive t where |dx*t| = halfW or |dy*t| = halfH
  const tx = dx !== 0 ? halfW / Math.abs(dx) : Infinity
  const ty = dy !== 0 ? halfH / Math.abs(dy) : Infinity
  const t = Math.min(tx, ty)

  return {
    x: fromX + dx * t,
    y: fromY + dy * t
  }
}

// ── Spring physics (distance-adaptive for snappy layout + gentle nudge return) ──

// Large displacement (layout): high stiffness, fast settle (~400ms)
// Small displacement (nudge): very low stiffness, slow gentle drift back (~1.5s)
const STIFFNESS_MAX = 0.12 // for large moves (layout animation)
const STIFFNESS_MIN = 0.008 // for tiny moves (nudge return)
const STIFFNESS_RAMP = 80 // distance (px) at which stiffness reaches max
const SPRING_DAMPING = 0.82 // high damping — no bouncing, just smooth settle

export function stepSprings(nodes: SpringNode[]): boolean {
  let settled = true

  for (const node of nodes) {
    const dx = node.targetX - node.x
    const dy = node.targetY - node.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    // Ramp stiffness from min → max based on displacement distance
    const t = Math.min(dist / STIFFNESS_RAMP, 1)
    const stiffness = STIFFNESS_MIN + (STIFFNESS_MAX - STIFFNESS_MIN) * t * t // quadratic ramp

    // Spring force toward target
    const ax = dx * stiffness
    const ay = dy * stiffness

    node.vx = (node.vx + ax) * SPRING_DAMPING
    node.vy = (node.vy + ay) * SPRING_DAMPING

    node.x += node.vx
    node.y += node.vy

    // Check if still moving
    if (Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3 || Math.abs(node.vx) > 0.05 || Math.abs(node.vy) > 0.05) {
      settled = false
    }
  }

  return settled
}
