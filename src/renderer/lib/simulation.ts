import type { TreeNode } from './spawn-tree'

// ── Types ──────────────────────────────────────────────────────────────

/**
 * A project hub. Its position is animated toward `targetX`/`targetY` by the
 * same spring integrator the session thumbnails use (see stepSprings); the
 * targets themselves come from computeHubTargets.
 */
export interface HubNode extends SpringNode {
  id: string // projectPath used as id
  projectName: string
  color: string
  sessionCount: number
  /**
   * The space this cluster's pill + thumbnails occupy, relative to the hub
   * (see clusterBox). Falls back to a worst-case square when unset.
   */
  box?: Box
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
export const HUB_PILL_HALF_W = 120 // generous: long project names render ~240px wide
export const HUB_PILL_HALF_H = 16
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

// ── Cluster footprint ──────────────────────────────────────────────────

/**
 * The space a laid-out cluster actually occupies, relative to its hub.
 *
 * A box rather than a radius, because a cluster is rarely round: a project with
 * one session is a pill with a single thumbnail off to one side, and enclosing
 * that in a circle reserves roughly four times the room it needs. With real
 * bounds, a screenful of one-session projects packs into a screenful instead of
 * spilling off the edges.
 */
export interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

// ── Box helpers ────────────────────────────────────────────────────────
// One rectangle representation for the whole layout. Min/max rather than
// centre + half-extents because the interesting rectangles here are lopsided:
// a cluster's footprint sits off to one side of the hub it belongs to.

/** A box translated by (x, y). */
export function boxAt(b: Box, x: number, y: number): Box {
  return { minX: b.minX + x, maxX: b.maxX + x, minY: b.minY + y, maxY: b.maxY + y }
}

/** A box of the given half-extents, centred on (x, y). */
export function boxFromCenter(x: number, y: number, halfW: number, halfH: number): Box {
  return { minX: x - halfW, maxX: x + halfW, minY: y - halfH, maxY: y + halfH }
}

/** Grow a box on all sides — used to keep clearance between clusters. */
export function padBox(b: Box, pad: number): Box {
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY
}

/**
 * Smallest translation that separates `a` from `b`, or null if they already
 * clear each other. Along the axis of least overlap, so a box slides out the
 * near side rather than being flung across its neighbour.
 */
export function boxSeparation(a: Box, b: Box): { x: number; y: number } | null {
  if (!boxesOverlap(a, b)) return null
  const overlapLeft = a.maxX - b.minX // push a in -x
  const overlapRight = b.maxX - a.minX // push a in +x
  const overlapUp = a.maxY - b.minY // push a in -y
  const overlapDown = b.maxY - a.minY // push a in +y
  const dx = overlapLeft < overlapRight ? -overlapLeft : overlapRight
  const dy = overlapUp < overlapDown ? -overlapUp : overlapDown
  return Math.abs(dx) < Math.abs(dy) ? { x: dx, y: 0 } : { x: 0, y: dy }
}

/** Footprint of `targets` (hub-relative), including the hub pill itself. */
export function clusterBox(targets: readonly SpokeTarget[]): Box {
  // The pill is always there, even for a project whose sessions are all hidden
  // inside a split group.
  let minX = -HUB_PILL_HALF_W
  let maxX = HUB_PILL_HALF_W
  let minY = -HUB_PILL_HALF_H
  let maxY = HUB_PILL_HALF_H
  for (const t of targets) {
    minX = Math.min(minX, t.offsetX - THUMB_WIDTH / 2)
    maxX = Math.max(maxX, t.offsetX + THUMB_WIDTH / 2)
    minY = Math.min(minY, t.offsetY - THUMB_HEIGHT / 2)
    maxY = Math.max(maxY, t.offsetY + THUMB_HEIGHT / 2)
  }
  return { minX, minY, maxX, maxY }
}

/** Worst-case footprint for a hub whose spokes haven't been laid out yet. */
function fallbackBox(sessionCount: number): Box {
  const r = MAX_MIN_SPOKE_DISTANCE + Math.max(THUMB_WIDTH, THUMB_HEIGHT) / 2
  const n = Math.max(sessionCount, 1)
  const scale = n <= 2 ? 1 : Math.sqrt(n / 2)
  return { minX: -r * scale, minY: -r * scale, maxX: r * scale, maxY: r * scale }
}

// Gap kept between two cluster footprints. This is the whole of what separates
// one project from the next now that footprints are tight bounding boxes rather
// than circles, so it has to carry real visual weight — the old circular
// footprint reserved ~370px around a hub and got its separation for free as a
// side effect of being wasteful. Sized so a handful of projects still fills a
// 1900x1080 window rather than huddling in the middle of it.
const HUB_CLEARANCE = 200

/**
 * The gap an ALREADY-PLACED hub is allowed to fall to before it is made to move.
 *
 * HUB_CLEARANCE is what the pack aims for, and a fresh pack leaves every hub
 * sitting flush against it — so if the same figure also decided when a hub had
 * to give way, the very first session added to a neighbouring project would
 * breach it and shove an established hub aside. Every spawn would nudge
 * somebody, which is the behaviour this design is trying to remove.
 *
 * So the two are separated: the pack still reserves a generous, readable gap
 * for a hub it is placing, and a hub already in place keeps its position while
 * its neighbour's cluster grows into that slack — yielding only when the gap
 * gets genuinely too tight to read as two groups.
 */
const HUB_KEEP_CLEARANCE = 64

// Candidate lattice for the pack: rings this far apart, this many angles each.
// Deliberately CONSTANT rather than derived from the hubs being packed — a
// lattice that depended on the set would shift under every hub already placed
// the moment a project opened, and "an established project keeps its slot"
// would quietly stop being true.
const PACK_STEP = 24
const PACK_ANGLES = 64

/**
 * A hub's placement in the packing frame. Not screen coordinates: the frame is
 * centred on the origin and never re-centred, so a slot means the same place
 * for as long as the project exists (see computeHubTargets).
 */
export interface HubSlot {
  x: number
  y: number
}

/**
 * Where each hub sits.
 *
 * This replaced a d3-force annealing simulation (charge + collide + centering,
 * with soft anchors, reheats and a compaction pass). For 2-10 nodes that was
 * both overkill and actively fragile: because each settle re-anchored a hub
 * wherever it happened to stop, any residual force became a permanent
 * per-reheat increment, and the layout walked itself apart during ordinary use.
 *
 * Determinism alone did not fix that, because a deterministic layout is not a
 * STABLE one. The pack's inputs include every cluster's footprint, and a
 * footprint grows the moment its project gains a session — so a pure function
 * of those inputs faithfully returns a different arrangement after every spawn,
 * and a hub two slots down the order could find its old spot taken and land on
 * the far side of the graph. That defeats the point of the view: the user
 * navigates by remembering that a session is *over there*.
 *
 * So placement is sticky rather than merely reproducible:
 *
 *   1. Hubs with a remembered slot keep it, in `hubs` order, as long as the
 *      cluster still clears every hub kept before it. An established project
 *      is only ever displaced by a genuine collision — and when two collide,
 *      the one earlier in the order (the longer-established one) is the one
 *      that stays.
 *   2. Everything else — new projects, and the rare evicted hub — takes the
 *      free position closest to the frame's centre, measured in
 *      viewport-normalised space so a wide window packs wide and a tall one
 *      packs tall instead of always forming a circular blob.
 *
 * The result is expressed in a frame centred on the origin and is NOT shifted
 * to the middle of the viewport. Centring here would undo all of the above:
 * the shift derives from the union of every footprint, so one project growing a
 * ring would slide every other hub sideways. Centring is the camera's job, and
 * it only has to happen once.
 */
export function computeHubTargets(
  hubs: readonly HubNode[],
  width: number,
  height: number,
  pinned?: ReadonlyMap<string, HubSlot>
): Map<string, HubSlot> {
  const out = new Map<string, HubSlot>()
  if (hubs.length === 0) return out

  // Half the clearance on each cluster, so any two end up a full gap apart.
  const raw = hubs.map((h) => h.box ?? fallbackBox(h.sessionCount))
  const boxes = raw.map((b) => padBox(b, HUB_CLEARANCE / 2))
  const keepBoxes = raw.map((b) => padBox(b, HUB_KEEP_CLEARANCE / 2))

  // Candidate rings are ELLIPSES with the viewport's aspect, not circles, so
  // "the nearest free spot" means nearest in screen terms: a wide window fills
  // sideways before it grows tall, and a tall one the other way round. Doing
  // this by weighting a circular ring instead only breaks ties within the ring,
  // which is far too weak to shape the result.
  const halfW = Math.max(width, 1) / 2
  const halfH = Math.max(height, 1) / 2
  const aspectX = halfW / Math.min(halfW, halfH)
  const aspectY = halfH / Math.min(halfW, halfH)

  // Only bounds the search — every hub is placed long before this.
  const longest = Math.max(...boxes.map((b) => Math.max(b.maxX - b.minX, b.maxY - b.minY)))
  const maxRing = Math.ceil(((hubs.length + 1) * longest) / PACK_STEP) + 2 // search bound only

  // Two views of the same occupied space, kept in step: `placed` carries the
  // full-clearance boxes a hub being packed has to respect, `placedKeep` the
  // tighter ones that decide whether a hub already in position may stay put.
  const placed: Box[] = []
  const placedKeep: Box[] = []

  const occupy = (i: number, x: number, y: number): void => {
    placed.push(boxAt(boxes[i], x, y))
    placedKeep.push(boxAt(keepBoxes[i], x, y))
  }

  // Pass 1: honour remembered slots. Order matters twice over — it decides who
  // is tested against whom, and so which of two overlapping hubs is the one
  // that keeps its place.
  const needsPacking: number[] = []
  hubs.forEach((hub, i) => {
    const slot = pinned?.get(hub.id)
    if (!slot || !Number.isFinite(slot.x) || !Number.isFinite(slot.y)) {
      needsPacking.push(i)
      return
    }
    const candidate = boxAt(keepBoxes[i], slot.x, slot.y)
    if (placedKeep.some((q) => boxesOverlap(candidate, q))) {
      needsPacking.push(i)
      return
    }
    occupy(i, slot.x, slot.y)
    out.set(hub.id, { x: slot.x, y: slot.y })
  })

  // Pass 2: place whoever is left on the nearest free lattice position.
  //
  // "Nearest" is measured from a different origin depending on why the hub is
  // here. A project the user has never seen has no place to be attached to, so
  // it belongs as close to the middle of the arrangement as it can get. An
  // EVICTED hub does have one — the user knows where it was — so it searches
  // outward from its old slot and takes the closest position that clears its
  // grown neighbour. Sending it back to the centre instead would satisfy the
  // collision just as well while producing exactly the teleport this design
  // exists to avoid.
  for (const i of needsPacking) {
    const box = boxes[i]
    const from = pinned?.get(hubs[i].id)
    const originX = from && Number.isFinite(from.x) ? from.x : 0
    const originY = from && Number.isFinite(from.y) ? from.y : 0
    // Centre of area, not the hub: a cluster with one thumbnail off to one side
    // is not centred on its pill.
    const boxCx = (box.minX + box.maxX) / 2
    const boxCy = (box.minY + box.maxY) / 2

    let best: HubSlot | null = null
    let bestCost = Infinity

    for (let ring = 0; ring <= maxRing; ring++) {
      const dist = ring * PACK_STEP
      // Ring 0 is the single candidate at the search origin.
      const steps = ring === 0 ? 1 : PACK_ANGLES
      for (let a = 0; a < steps; a++) {
        // Walk the ellipse in a fixed order, starting at 0 rad, for determinism.
        const angle = (a / steps) * Math.PI * 2
        const x = originX + Math.cos(angle) * dist * aspectX
        const y = originY + Math.sin(angle) * dist * aspectY
        const candidate = boxAt(box, x, y)
        if (placed.some((q) => boxesOverlap(candidate, q))) continue
        const cost = Math.hypot(
          (x + boxCx - originX) / aspectX,
          (y + boxCy - originY) / aspectY
        )
        if (cost < bestCost) { bestCost = cost; best = { x, y } }
      }
      // Once a ring has yielded a position, no larger ring can beat it: cost
      // grows with distance, so every candidate further out is worse.
      if (best) break
    }

    // Unreachable for any sane hub count, but never drop a hub off the graph.
    const spot = best ?? { x: originX, y: originY + (placed.length + 1) * longest }
    occupy(i, spot.x, spot.y)
    out.set(hubs[i].id, spot)
  }

  return out
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
