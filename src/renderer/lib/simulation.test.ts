import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeSpokeOffsets,
  clusterExtent,
  THUMB_WIDTH,
  THUMB_HEIGHT,
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
    const flat = clusterExtent(computeSpokeOffsets([leaf('a'), leaf('b')], P))
    const tree = clusterExtent(
      computeSpokeOffsets([branch('a', leaf('a1'), leaf('a2')), leaf('b')], P)
    )
    assert.ok(tree > flat, 'children must be included in the collision footprint')
  })
})
