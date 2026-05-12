import {
  forceSimulation,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum
} from 'd3-force'

// ── Types ──────────────────────────────────────────────────────────────

export interface HubNode extends SimulationNodeDatum {
  id: string // projectPath used as id
  projectName: string
  color: string
  sessionCount: number
}

export interface SpokeTarget {
  id: string // session id
  hubId: string
  offsetX: number // deterministic offset from hub
  offsetY: number
  anchorOffsetX: number // fixed edge attachment point relative to spoke center
  anchorOffsetY: number
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
    const radius = BASE_RADIUS + ring * RING_GAP
    placed += spokeCapacity(radius)
    ring++
  }
  // Outermost ring radius + half a thumbnail for the node extent
  const outerRing = BASE_RADIUS + (ring - 1) * RING_GAP
  return outerRing + Math.max(THUMB_WIDTH, THUMB_HEIGHT) / 2
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
        .radius((d) => clusterRadius(d.sessionCount) + 20)
        .strength(1)
    )
    .force('centerX', forceX(width / 2).strength(0.08))
    .force('centerY', forceY(height / 2).strength(0.08))
    .alphaDecay(0.04)
    .velocityDecay(0.5)
    .alphaMin(0.001)
}

// ── Spoke layout (deterministic ring positions) ────────────────────────

function spokeCapacity(radius: number): number {
  // How many thumbnails fit on a ring at this radius with minimum spacing.
  // Use the larger dimension (width) as the arc-length footprint per node —
  // this prevents overlap when adjacent thumbnails are at similar angles.
  const circumference = 2 * Math.PI * radius
  return Math.max(1, Math.floor(circumference / (THUMB_WIDTH + MIN_SPOKE_SPACING)))
}

export function computeSpokeOffsets(
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
    const radius = BASE_RADIUS + ring * RING_GAP
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
      const jitteredRadius = radius + radiusJitter
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
        anchorOffsetY: anchor.y
      })
      placed++
    }
    ring++
  }

  return targets
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
