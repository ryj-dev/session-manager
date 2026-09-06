import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeSpokeOffsets,
  clusterBox,
  computeHubTargets,
  boxAt,
  boxFromCenter,
  boxesOverlap,
  boxSeparation,
  THUMB_WIDTH,
  THUMB_HEIGHT,
  type HubNode,
  type SpokeTarget,
} from './simulation'
import type { TreeNode } from './spawn-tree'

const P = '/repo/alpha'

function leaf(id: string): TreeNode {
  return { id, children: [] }
}
function branch(id: string, ...children: TreeNode[]): TreeNode {
  return { id, children }
}

/** Do two thumbnails centred at these offsets overlap? */
function overlaps(a: SpokeTarget, b: SpokeTarget): boolean {
  return (
    Math.abs(a.offsetX - b.offsetX) < THUMB_WIDTH &&
    Math.abs(a.offsetY - b.offsetY) < THUMB_HEIGHT
  )
}

function assertNoOverlaps(targets: SpokeTarget[]): void {
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      assert.ok(
        !overlaps(targets[i], targets[j]),
        `${targets[i].id} overlaps ${targets[j].id} ` +
          `(${targets[i].offsetX.toFixed(0)},${targets[i].offsetY.toFixed(0)}) vs ` +
          `(${targets[j].offsetX.toFixed(0)},${targets[j].offsetY.toFixed(0)})`
      )
    }
  }
}

/** The hub pill sits at the origin; nothing may sit on top of it. */
function assertClearsHub(targets: SpokeTarget[]): void {
  for (const t of targets) {
    const clearsX = Math.abs(t.offsetX) >= 120 + THUMB_WIDTH / 2
    const clearsY = Math.abs(t.offsetY) >= 16 + THUMB_HEIGHT / 2
    assert.ok(clearsX || clearsY, `${t.id} overlaps the hub pill`)
  }
}

const byId = (targets: SpokeTarget[]): Map<string, SpokeTarget> =>
  new Map(targets.map((t) => [t.id, t]))

describe('computeSpokeOffsets — flat projects', () => {
  test('an empty project lays out nothing', () => {
    assert.deepEqual(computeSpokeOffsets([], P), [])
  })

  test('childless roots keep the ring layout (depth 0, no parent)', () => {
    const targets = computeSpokeOffsets([leaf('a'), leaf('b'), leaf('c')], P)
    assert.equal(targets.length, 3)
    assert.ok(targets.every((t) => t.depth === 0 && t.parentId === undefined))
    assertNoOverlaps(targets)
    assertClearsHub(targets)
  })

  test('the ring layout is unchanged by the tree code path', () => {
    // Same ids, no children — must be byte-identical run to run and match the
    // deterministic per-project seeding.
    const a = computeSpokeOffsets([leaf('a'), leaf('b')], P)
    const b = computeSpokeOffsets([leaf('a'), leaf('b')], P)
    assert.deepEqual(a, b)
  })
})

describe('computeSpokeOffsets — trees', () => {
  test('a child is tagged with its parent and depth', () => {
    const targets = computeSpokeOffsets([branch('a', leaf('b'))], P)
    const m = byId(targets)
    assert.equal(m.get('a')!.parentId, undefined)
    assert.equal(m.get('a')!.depth, 0)
    assert.equal(m.get('b')!.parentId, 'a')
    assert.equal(m.get('b')!.depth, 1)
  })

  test('a child sits further from the hub than its parent, and near it', () => {
    const m = byId(computeSpokeOffsets([branch('a', leaf('b'))], P))
    const parent = m.get('a')!
    const child = m.get('b')!
    const distTo = (t: SpokeTarget): number => Math.hypot(t.offsetX, t.offsetY)
    assert.ok(distTo(child) > distTo(parent), 'child should be radially outside its parent')

    // Adjacent, not flung away: just past the distance two thumbnails need to
    // clear each other in any direction.
    const clearance = 2 * Math.hypot(THUMB_WIDTH / 2, THUMB_HEIGHT / 2)
    const gap = Math.hypot(child.offsetX - parent.offsetX, child.offsetY - parent.offsetY)
    assert.ok(gap <= clearance + 60, `child too far from parent (${gap.toFixed(0)}px)`)
  })

  test("a child's edge anchor faces its parent, not the hub", () => {
    const m = byId(computeSpokeOffsets([branch('a', leaf('b'))], P))
    const parent = m.get('a')!
    const child = m.get('b')!
    // The anchor is on the child's perimeter; stepping from the child centre
    // toward the anchor must move toward the parent, not toward the origin.
    const towardParent =
      (parent.offsetX - child.offsetX) * child.anchorOffsetX +
      (parent.offsetY - child.offsetY) * child.anchorOffsetY
    assert.ok(towardParent > 0, 'anchor should point at the parent')
  })

  test('a wide fan-out does not overlap itself', () => {
    const targets = computeSpokeOffsets(
      [branch('a', leaf('a1'), leaf('a2'), leaf('a3'), leaf('a4'), leaf('a5'))],
      P
    )
    assert.equal(targets.length, 6)
    assertNoOverlaps(targets)
    assertClearsHub(targets)
  })

  test('sibling subtrees do not collide', () => {
    const targets = computeSpokeOffsets(
      [
        branch('a', leaf('a1'), leaf('a2'), leaf('a3')),
        branch('b', leaf('b1'), leaf('b2')),
        branch('c', leaf('c1'), leaf('c2'), leaf('c3'), leaf('c4')),
        leaf('d'),
      ],
      P
    )
    assert.equal(targets.length, 13)
    assertNoOverlaps(targets)
    assertClearsHub(targets)
  })

  test('grandchildren do not collide with anything', () => {
    const targets = computeSpokeOffsets(
      [
        branch('a', branch('a1', leaf('a1x'), leaf('a1y')), branch('a2', leaf('a2x'))),
        branch('b', leaf('b1')),
      ],
      P
    )
    assert.equal(targets.length, 8)
    assertNoOverlaps(targets)
    assertClearsHub(targets)
  })

  test('a large mixed cluster stays overlap-free', () => {
    const roots: TreeNode[] = []
    for (let i = 0; i < 8; i++) {
      const kids = i % 3 === 0 ? [leaf(`r${i}c0`), leaf(`r${i}c1`)] : []
      roots.push(branch(`r${i}`, ...kids))
    }
    const targets = computeSpokeOffsets(roots, P)
    assertNoOverlaps(targets)
    assertClearsHub(targets)
  })

  test('the layout is deterministic for a given project and shape', () => {
    const shape = (): TreeNode[] => [branch('a', leaf('b'), leaf('c')), leaf('d')]
    assert.deepEqual(computeSpokeOffsets(shape(), P), computeSpokeOffsets(shape(), P))
  })

  test('randomised forests never overlap', () => {
    // Deterministic PRNG so a failure is reproducible from the seed alone.
    let seed = 12345
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }

    for (let iteration = 0; iteration < 200; iteration++) {
      let counter = 0
      const build = (depth: number): TreeNode => {
        const id = `n${counter++}`
        // Depth 2 matches spawn-tree's MAX_TREE_DEPTH; nothing deeper reaches
        // the layout.
        const kids = depth >= 2 ? 0 : Math.floor(rand() * 4)
        const children: TreeNode[] = []
        for (let i = 0; i < kids; i++) children.push(build(depth + 1))
        return { id, children }
      }
      const roots: TreeNode[] = []
      const rootCount = 1 + Math.floor(rand() * 7)
      for (let i = 0; i < rootCount; i++) roots.push(build(0))

      const targets = computeSpokeOffsets(roots, `/repo/p${iteration}`)
      assertNoOverlaps(targets)
      assertClearsHub(targets)
    }
  })

  test('a subtree widens the cluster footprint', () => {
    const area = (b: { minX: number; minY: number; maxX: number; maxY: number }): number =>
      (b.maxX - b.minX) * (b.maxY - b.minY)
    const flat = area(clusterBox(computeSpokeOffsets([leaf('a'), leaf('b')], P)))
    const tree = area(
      clusterBox(computeSpokeOffsets([branch('a', leaf('a1'), leaf('a2')), leaf('b')], P))
    )
    assert.ok(tree > flat, 'children must be included in the collision footprint')
  })
})

// ── Hub layout ─────────────────────────────────────────────────────────

describe('computeHubTargets', () => {
  const W = 1900
  const H = 1080

  /** Hubs for `ids`, each with the footprint of a one-session cluster. */
  function makeHubs(ids: string[]): HubNode[] {
    return ids.map((id) => ({
      id,
      projectName: id,
      color: '#fff',
      sessionCount: 1,
      box: clusterBox(computeSpokeOffsets([leaf(`${id}-s0`)], id)),
      x: 0, y: 0, vx: 0, vy: 0, targetX: 0, targetY: 0,
    }))
  }

  function layout(ids: string[], w = W, h = H): Map<string, { x: number; y: number }> {
    return computeHubTargets(makeHubs(ids), w, h)
  }

  /** Smallest gap between any two cluster footprints; < 0 means overlap. */
  function minSlack(ids: string[], targets: Map<string, { x: number; y: number }>): number {
    const hubs = makeHubs(ids)
    const rect = (h: HubNode) => {
      const p = targets.get(h.id)!
      const b = h.box!
      return { minX: p.x + b.minX, maxX: p.x + b.maxX, minY: p.y + b.minY, maxY: p.y + b.maxY }
    }
    let worst = Infinity
    for (let i = 0; i < hubs.length; i++) {
      for (let j = i + 1; j < hubs.length; j++) {
        const a = rect(hubs[i])
        const b = rect(hubs[j])
        // Separation along whichever axis actually separates them.
        const gapX = Math.max(a.minX - b.maxX, b.minX - a.maxX)
        const gapY = Math.max(a.minY - b.maxY, b.minY - a.maxY)
        worst = Math.min(worst, Math.max(gapX, gapY))
      }
    }
    return worst
  }

  /** Mean distance of the targets from their own centroid. */
  function spread(targets: Map<string, { x: number; y: number }>): number {
    const pts = [...targets.values()]
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length
    return pts.reduce((a, p) => a + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length
  }

  test('is deterministic', () => {
    const a = layout(['p1', 'p2', 'p3', 'p4', 'p5'])
    const b = layout(['p1', 'p2', 'p3', 'p4', 'p5'])
    for (const [id, p] of a) assert.deepEqual(b.get(id), p, `${id} moved between identical calls`)
  })

  test('clusters never overlap', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 8, 12]) {
      const ids = Array.from({ length: n }, (_, i) => `p${i}`)
      const slack = minSlack(ids, layout(ids))
      assert.ok(slack > -1, `${n} hubs overlap by ${(-slack).toFixed(1)}px`)
    }
  })

  test('a project coming and going leaves the layout exactly as it was', () => {
    // The reason this layout is a pure function. The old force simulation
    // annealed from wherever the hubs happened to be and re-anchored them
    // there, so every project that opened and closed left the arrangement a
    // little wider — permanently. Here there is no history to accumulate:
    // the same hub set is bit-for-bit the same layout.
    const before = layout(['p1', 'p2', 'p3', 'p4'])
    layout(['p1', 'p2', 'p3', 'p4', 'tmp']) // a project opens...
    const after = layout(['p1', 'p2', 'p3', 'p4']) // ...and closes again

    for (const [id, p] of before) assert.deepEqual(after.get(id), p, `${id} did not return to its slot`)
  })

  test('an established hub keeps its slot when a project is appended', () => {
    // Pack order is first-seen (see orderHubs), so a newcomer takes the next
    // free slot instead of displacing the projects already on the graph. The
    // frame is no longer re-centred, so these are absolute positions: the
    // existing hubs do not move at all, on screen or otherwise.
    const before = layout(['p1', 'p2', 'p3'])
    const after = layout(['p1', 'p2', 'p3', 'p4'])
    for (const id of ['p1', 'p2', 'p3']) {
      assert.deepEqual(after.get(id), before.get(id), `${id} moved when p4 appeared`)
    }
    assert.ok(after.has('p4'), 'the new project was not placed')
  })

  test('packs along the long axis of the viewport', () => {
    // Enough projects that the pack has to grow beyond the middle, which is
    // where the window's shape should start steering it.
    const ids = Array.from({ length: 10 }, (_, i) => `p${i}`)
    /** Bounding box of every cluster's footprint, not just the hub points. */
    const extent = (w: number, h: number): { w: number; h: number } => {
      const hubs = makeHubs(ids)
      const t = computeHubTargets(hubs, w, h)
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const hub of hubs) {
        const p = t.get(hub.id)!
        const b = hub.box!
        minX = Math.min(minX, p.x + b.minX); maxX = Math.max(maxX, p.x + b.maxX)
        minY = Math.min(minY, p.y + b.minY); maxY = Math.max(maxY, p.y + b.maxY)
      }
      return { w: maxX - minX, h: maxY - minY }
    }
    const wide = extent(2400, 1000)
    const tall = extent(1000, 2400)
    assert.ok(wide.w > wide.h, `wide window got a ${wide.w.toFixed(0)}x${wide.h.toFixed(0)} layout`)
    assert.ok(tall.h > tall.w, `tall window got a ${tall.w.toFixed(0)}x${tall.h.toFixed(0)} layout`)
  })

  test('a screenful of one-session projects fits in a screen-sized area', () => {
    // The footprint used to be a circle around the hub, which for a project
    // with a single session reserved about four times the room its pill and
    // thumbnail actually occupy — six projects then spilled off a 1900x1080
    // window. A real bounding box is what makes them fit.
    //
    // Measured as an extent, not against the window's edges: the pack works in
    // a frame centred on the origin and deliberately does not shift itself into
    // the viewport (see computeHubTargets), so it is the camera that decides
    // where on screen this lands.
    const ids = Array.from({ length: 6 }, (_, i) => `p${i}`)
    const hubs = makeHubs(ids)
    const t = computeHubTargets(hubs, W, H)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const hub of hubs) {
      const p = t.get(hub.id)!
      const b = hub.box!
      minX = Math.min(minX, p.x + b.minX); maxX = Math.max(maxX, p.x + b.maxX)
      minY = Math.min(minY, p.y + b.minY); maxY = Math.max(maxY, p.y + b.maxY)
    }
    assert.ok(maxX - minX <= W, `6 projects span ${(maxX - minX).toFixed(0)}px of a ${W}px window`)
    assert.ok(maxY - minY <= H, `6 projects span ${(maxY - minY).toFixed(0)}px of a ${H}px window`)
  })

  test('is centred on the origin and stays compact', () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5']
    const t = layout(ids)
    const pts = [...t.values()]
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length
    // Footprints differ, so the centroid of the *centres* need only be near
    // the origin — not exactly on it.
    assert.ok(Math.abs(cx) < W / 4, `layout is off-centre horizontally (${cx.toFixed(0)})`)
    assert.ok(Math.abs(cy) < H / 4, `layout is off-centre vertically (${cy.toFixed(0)})`)
    assert.ok(spread(t) > 100, 'hubs collapsed onto one another')
  })

  test('puts a lone project at the origin', () => {
    const p = layout(['solo']).get('solo')!
    assert.deepEqual(p, { x: 0, y: 0 })
  })

  /** Hubs for `ids`, with `n` sessions in whichever one is named. */
  function withSessions(ids: string[], id: string, n: number): HubNode[] {
    const hubs = makeHubs(ids)
    const hub = hubs.find((h) => h.id === id)!
    hub.sessionCount = n
    hub.box = clusterBox(
      computeSpokeOffsets(Array.from({ length: n }, (_, i) => leaf(`${id}-s${i}`)), id)
    )
    return hubs
  }

  test('a spawn that only fills out an existing ring moves nothing', () => {
    // The bug this whole design exists to prevent, in the shape the user hits
    // it. Footprints are pack input, so before slots were pinned a spawn in one
    // project changed which lattice positions were free for every project after
    // it — and a hub on the left could reappear on the right. Determinism was
    // never the missing piece; stability was.
    const ids = ['p1', 'p2', 'p3', 'p4']
    const before = computeHubTargets(makeHubs(ids), W, H)
    const after = computeHubTargets(withSessions(ids, 'p1', 2), W, H, before)
    for (const id of ids) {
      assert.deepEqual(after.get(id), before.get(id), `${id} moved on p1's second session`)
    }
  })

  test('repeated spawns push neighbours outward by a bounded amount, and never inward', () => {
    // Growth cannot always be free: a cluster that gains a ring really does need
    // more room, and its neighbour really does have to move. What must not
    // happen is the old failure mode — a re-pack from the centre that lands the
    // neighbour somewhere unrecognisable, or a per-spawn nudge that ratchets a
    // little further every time. So each hub is allowed to be pushed outward,
    // once, by about the room the growth actually needed.
    const ids = ['p1', 'p2', 'p3', 'p4']
    let slots = computeHubTargets(makeHubs(ids), W, H)
    const origin = new Map(slots)

    for (let n = 2; n <= 10; n++) {
      slots = computeHubTargets(withSessions(ids, 'p1', n), W, H, slots)
    }

    for (const id of ['p2', 'p3', 'p4']) {
      const a = origin.get(id)!
      const b = slots.get(id)!
      const drift = Math.hypot(b.x - a.x, b.y - a.y)
      assert.ok(drift < 700, `${id} drifted ${drift.toFixed(0)}px over nine spawns`)
      assert.ok(
        Math.hypot(b.x, b.y) >= Math.hypot(a.x, a.y) - 1,
        `${id} was pulled back toward the centre rather than pushed clear`
      )
    }
  })

  test('sessions closing again leaves every hub where it was', () => {
    // Shrinking a cluster frees space, and freeing space must not be a reason
    // for anything to move: a pinned slot is only ever given up under a real
    // collision, and there is no collision to resolve here.
    const ids = ['p1', 'p2', 'p3', 'p4']
    let slots = computeHubTargets(withSessions(ids, 'p1', 8), W, H)
    const busy = new Map(slots)
    slots = computeHubTargets(makeHubs(ids), W, H, slots)
    for (const id of ids) {
      assert.deepEqual(slots.get(id), busy.get(id), `${id} moved when p1's sessions closed`)
    }
  })

  test('an evicted hub moves as little as the collision demands', () => {
    // If a cluster does grow enough to genuinely overlap its neighbour, the
    // neighbour has to give way — but it re-packs outward from where it already
    // was, not from the middle of the graph. Anything else reproduces the
    // teleport for the one hub that could least afford it.
    const ids = ['p1', 'p2', 'p3']
    const before = computeHubTargets(makeHubs(ids), W, H)

    const grown = makeHubs(ids)
    grown[0].box = { minX: -1200, maxX: 1200, minY: -700, maxY: 700 }
    const after = computeHubTargets(grown, W, H, before)

    const moved = ids.filter((id) => {
      const a = before.get(id)!
      const b = after.get(id)!
      return Math.hypot(b.x - a.x, b.y - a.y) > 0.001
    })
    assert.ok(!moved.includes('p1'), 'the hub that grew should keep its slot')
    for (const id of moved) {
      const a = before.get(id)!
      const b = after.get(id)!
      // Its own slot is inside p1's new footprint, so it cannot stay; it should
      // still end up on the near side of it rather than across the graph.
      const dist = Math.hypot(b.x - a.x, b.y - a.y)
      const toCentre = Math.hypot(a.x, a.y)
      assert.ok(dist < 2400, `${id} was flung ${dist.toFixed(0)}px`)
      assert.ok(dist > 0, `${id} reported as moved but did not`)
      assert.ok(
        Math.hypot(b.x, b.y) > toCentre - 1,
        `${id} was pulled back toward the centre instead of pushed clear`
      )
    }
  })

  test('yields a pinned slot only to the hub that owns the collision', () => {
    // A footprint can grow far enough that two clusters genuinely overlap, and
    // then somebody has to move. Pack order decides who: the hub tested first
    // is the longer-established one, so it keeps its place and the later one is
    // re-packed. Whatever happens, nothing may be left overlapping.
    const ids = ['p1', 'p2', 'p3']
    const before = computeHubTargets(makeHubs(ids), W, H)

    const grown = makeHubs(ids)
    // A cluster wide enough to swallow its neighbours' slots outright.
    grown[0].box = { minX: -1200, maxX: 1200, minY: -700, maxY: 700 }
    const after = computeHubTargets(grown, W, H, before)

    assert.deepEqual(after.get('p1'), before.get('p1'), 'the established hub should not be the one to move')
    const rect = (h: HubNode): Box => {
      const p = after.get(h.id)!
      return {
        minX: p.x + h.box!.minX, maxX: p.x + h.box!.maxX,
        minY: p.y + h.box!.minY, maxY: p.y + h.box!.maxY,
      }
    }
    let worst = Infinity
    for (let i = 0; i < grown.length; i++) {
      for (let j = i + 1; j < grown.length; j++) {
        const a = rect(grown[i])
        const b = rect(grown[j])
        worst = Math.min(worst, Math.max(
          Math.max(a.minX - b.maxX, b.minX - a.maxX),
          Math.max(a.minY - b.maxY, b.minY - a.maxY)
        ))
      }
    }
    assert.ok(worst > -1, `clusters still overlap by ${(-worst).toFixed(1)}px after re-packing`)
  })

  test('ignores a pinned slot for a project that is no longer there', () => {
    const stale = new Map([['ghost', { x: 5000, y: 5000 }]])
    const t = computeHubTargets(makeHubs(['p1']), W, H, stale)
    assert.deepEqual(t.get('p1'), { x: 0, y: 0 })
    assert.equal(t.has('ghost'), false)
  })

  test('discards a corrupt pinned slot instead of placing a hub at NaN', () => {
    const bad = new Map([['p1', { x: NaN, y: 0 }]])
    const p = computeHubTargets(makeHubs(['p1']), W, H, bad).get('p1')!
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'hub placed at a non-finite position')
  })

  test('separates clusters by enough to read as distinct groups', () => {
    // Footprints are tight bounding boxes, so this gap is the only thing
    // keeping one project visually distinct from the next — a small value
    // packs them into an unreadable huddle.
    const ids = ['p1', 'p2', 'p3', 'p4']
    const hubs = makeHubs(ids)
    const t = computeHubTargets(hubs, W, H)
    const gap = minSlack(ids, t)
    assert.ok(gap > 150, `clusters are only ${gap.toFixed(0)}px apart`)
    // ...and still uses the window rather than huddling in the middle of it.
    let minX = Infinity, maxX = -Infinity
    for (const hub of hubs) {
      const p = t.get(hub.id)!
      minX = Math.min(minX, p.x + hub.box!.minX)
      maxX = Math.max(maxX, p.x + hub.box!.maxX)
    }
    assert.ok(maxX - minX > W * 0.6, `layout spans only ${(maxX - minX).toFixed(0)}px of a ${W}px window`)
  })

  test('lays out nothing for no hubs', () => {
    assert.equal(computeHubTargets([], W, H).size, 0)
  })
})

// ── Box helpers ────────────────────────────────────────────────────────

describe('box helpers', () => {
  const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY })

  test('boxFromCenter round-trips through its centre', () => {
    const b = boxFromCenter(100, 50, 20, 10)
    assert.deepEqual(b, box(80, 40, 120, 60))
    assert.equal((b.minX + b.maxX) / 2, 100)
    assert.equal((b.minY + b.maxY) / 2, 50)
  })

  test('boxesOverlap only counts real overlap, not touching', () => {
    assert.equal(boxesOverlap(box(0, 0, 10, 10), box(5, 5, 15, 15)), true)
    assert.equal(boxesOverlap(box(0, 0, 10, 10), box(10, 0, 20, 10)), false, 'edge-to-edge is clear')
    assert.equal(boxesOverlap(box(0, 0, 10, 10), box(20, 20, 30, 30)), false)
    // Overlapping in one axis only is not an overlap.
    assert.equal(boxesOverlap(box(0, 0, 10, 10), box(5, 20, 15, 30)), false)
  })

  test('boxSeparation returns null when the boxes already clear', () => {
    assert.equal(boxSeparation(box(0, 0, 10, 10), box(20, 0, 30, 10)), null)
  })

  test('boxSeparation pushes out the near side, along the shallower axis', () => {
    // Deep in y, shallow in x → slide sideways, and to the left, since that is
    // the closer edge.
    const mtv = boxSeparation(box(0, 0, 10, 100), box(8, 0, 30, 100))!
    assert.deepEqual(mtv, { x: -2, y: 0 })

    // Mirror image: b is to the left, so a is pushed right.
    assert.deepEqual(boxSeparation(box(8, 0, 30, 100), box(0, 0, 10, 100))!, { x: 2, y: 0 })

    // Shallow in y → move vertically instead.
    assert.deepEqual(boxSeparation(box(0, 0, 100, 10), box(0, 8, 100, 30))!, { x: 0, y: -2 })
  })

  test('applying boxSeparation actually separates the boxes', () => {
    const a = box(0, 0, 40, 30)
    const b = box(10, 5, 50, 35)
    const mtv = boxSeparation(a, b)!
    const moved = boxAt(a, mtv.x, mtv.y)
    assert.equal(boxesOverlap(moved, b), false, 'still overlapping after the push')
  })
})
