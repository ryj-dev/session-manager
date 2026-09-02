import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSpawnForest,
  recordLineage,
  flattenTree,
  MAX_TREE_DEPTH,
  type SpawnNodeInput,
} from './spawn-tree'

const P = '/repo/alpha'
const Q = '/repo/beta'

function node(
  id: string,
  opts: Partial<Omit<SpawnNodeInput, 'id'>> = {}
): SpawnNodeInput {
  return {
    id,
    projectPath: opts.projectPath ?? P,
    spawnParentId: opts.spawnParentId ?? null,
    reportBack: opts.reportBack ?? null,
  }
}

/** Root ids of a project, in order. */
function roots(forest: ReturnType<typeof buildSpawnForest>, project = P): string[] {
  return (forest.byProject.get(project) ?? []).map((n) => n.id)
}

describe('buildSpawnForest — linking rules', () => {
  test('a session with no spawn parent is a root on its hub', () => {
    const forest = buildSpawnForest([node('a'), node('b')])
    assert.deepEqual(roots(forest), ['a', 'b'])
    assert.equal(forest.parentOf.size, 0)
  })

  test('reportBack "true" and "done" hang the child off its spawner', () => {
    const forest = buildSpawnForest([
      node('a'),
      node('b', { spawnParentId: 'a', reportBack: 'true' }),
      node('c', { spawnParentId: 'a', reportBack: 'done' }),
    ])
    assert.deepEqual(roots(forest), ['a'])
    assert.equal(forest.parentOf.get('b'), 'a')
    assert.equal(forest.parentOf.get('c'), 'a')
    assert.deepEqual(flattenTree(forest.byProject.get(P)!), ['a', 'b', 'c'])
  })

  test('reportBack "optional" and "false" stay on the hub', () => {
    const forest = buildSpawnForest([
      node('a'),
      node('b', { spawnParentId: 'a', reportBack: 'optional' }),
      node('c', { spawnParentId: 'a', reportBack: 'false' }),
    ])
    assert.deepEqual(roots(forest), ['a', 'b', 'c'])
    assert.equal(forest.parentOf.size, 0)
  })

  test('a child in another project stays on its own hub', () => {
    const forest = buildSpawnForest([
      node('a'),
      node('b', { projectPath: Q, spawnParentId: 'a', reportBack: 'true' }),
    ])
    assert.deepEqual(roots(forest), ['a'])
    assert.deepEqual(roots(forest, Q), ['b'])
    assert.equal(forest.parentOf.size, 0)
  })

  test('a child whose spawner was never on the graph is a root', () => {
    const forest = buildSpawnForest([node('b', { spawnParentId: 'ghost', reportBack: 'true' })])
    assert.deepEqual(roots(forest), ['b'])
  })
})

describe('buildSpawnForest — live-ancestor walk', () => {
  test('a child re-attaches to a live grandparent when its parent closes', () => {
    const lineage = new Map<string, string>()
    const all = [
      node('a'),
      node('b', { spawnParentId: 'a', reportBack: 'true' }),
      node('c', { spawnParentId: 'b', reportBack: 'true' }),
    ]
    recordLineage(lineage, all)

    // b exits; c should climb to a rather than being stranded on the hub.
    const forest = buildSpawnForest([all[0], all[2]], lineage)
    assert.deepEqual(roots(forest), ['a'])
    assert.equal(forest.parentOf.get('c'), 'a')
  })

  test('a child falls back to the hub when the whole chain is gone', () => {
    const lineage = new Map<string, string>()
    const all = [
      node('a'),
      node('b', { spawnParentId: 'a', reportBack: 'true' }),
      node('c', { spawnParentId: 'b', reportBack: 'true' }),
    ]
    recordLineage(lineage, all)

    const forest = buildSpawnForest([all[2]], lineage)
    assert.deepEqual(roots(forest), ['c'])
    assert.equal(forest.parentOf.size, 0)
  })

  test('the walk stops at a dead ancestor whose live parent is in another project', () => {
    const lineage = new Map<string, string>()
    const all = [
      node('a', { projectPath: Q }),
      node('b', { spawnParentId: 'a', reportBack: 'true' }),
      node('c', { spawnParentId: 'b', reportBack: 'true' }),
    ]
    recordLineage(lineage, all)

    const forest = buildSpawnForest([all[0], all[2]], lineage)
    assert.deepEqual(roots(forest), ['c'])
    assert.equal(forest.parentOf.size, 0)
  })

  test('recordLineage ignores a session that names itself as parent', () => {
    const lineage = new Map<string, string>()
    recordLineage(lineage, [node('a', { spawnParentId: 'a', reportBack: 'true' })])
    assert.equal(lineage.size, 0)
  })
})

describe('buildSpawnForest — malformed graphs', () => {
  test('a self-parenting session becomes a root instead of vanishing', () => {
    const forest = buildSpawnForest([node('a', { spawnParentId: 'a', reportBack: 'true' })])
    assert.deepEqual(roots(forest), ['a'])
  })

  test('a two-node cycle leaves both sessions reachable', () => {
    const forest = buildSpawnForest([
      node('a', { spawnParentId: 'b', reportBack: 'true' }),
      node('b', { spawnParentId: 'a', reportBack: 'true' }),
    ])
    const flat = flattenTree(forest.byProject.get(P) ?? [])
    assert.deepEqual(flat.sort(), ['a', 'b'])
  })

  test('a lineage loop through a dead ancestor does not hang', () => {
    const lineage = new Map<string, string>([['dead1', 'dead2'], ['dead2', 'dead1']])
    const forest = buildSpawnForest([node('a', { spawnParentId: 'dead1', reportBack: 'true' })], lineage)
    assert.deepEqual(roots(forest), ['a'])
  })
})

describe('buildSpawnForest — depth cap', () => {
  test('descendants past the cap re-attach to their deepest allowed ancestor', () => {
    const chain = [
      node('a'),
      node('b', { spawnParentId: 'a', reportBack: 'true' }),
      node('c', { spawnParentId: 'b', reportBack: 'true' }),
      node('d', { spawnParentId: 'c', reportBack: 'true' }),
      node('e', { spawnParentId: 'd', reportBack: 'true' }),
    ]
    const forest = buildSpawnForest(chain)

    assert.deepEqual(roots(forest), ['a'])
    assert.equal(forest.parentOf.get('c'), 'b')
    // c sits at the cap, so both d and e flatten onto it.
    assert.equal(forest.parentOf.get('d'), 'c')
    assert.equal(forest.parentOf.get('e'), 'c')

    const cNode = forest.byProject.get(P)![0].children[0].children[0]
    assert.equal(cNode.id, 'c')
    assert.deepEqual(cNode.children.map((n) => n.id), ['d', 'e'])
    assert.deepEqual(cNode.children.flatMap((n) => n.children), [])
  })

  test('every session appears exactly once in the forest', () => {
    const chain = [
      node('a'),
      node('b', { spawnParentId: 'a', reportBack: 'true' }),
      node('c', { spawnParentId: 'b', reportBack: 'true' }),
      node('d', { spawnParentId: 'c', reportBack: 'true' }),
      node('e', { spawnParentId: 'd', reportBack: 'true' }),
      node('f', { reportBack: 'false' }),
    ]
    const forest = buildSpawnForest(chain)
    const flat = flattenTree(forest.byProject.get(P)!)
    assert.equal(flat.length, chain.length)
    assert.equal(new Set(flat).size, chain.length)
  })

  test('a tree exactly at the cap is left alone', () => {
    const forest = buildSpawnForest([
      node('a'),
      node('b', { spawnParentId: 'a', reportBack: 'true' }),
      node('c', { spawnParentId: 'b', reportBack: 'true' }),
    ])
    const depthOf = (id: string): number => {
      let depth = 0
      let cursor = forest.parentOf.get(id)
      while (cursor) { depth++; cursor = forest.parentOf.get(cursor) }
      return depth
    }
    assert.equal(depthOf('c'), MAX_TREE_DEPTH)
  })
})

describe('buildSpawnForest — determinism', () => {
  test('input order does not change the shape', () => {
    const build = (order: SpawnNodeInput[]): string[] =>
      flattenTree(buildSpawnForest(order).byProject.get(P)!)

    const a = node('a')
    const b = node('b', { spawnParentId: 'a', reportBack: 'true' })
    const c = node('c', { spawnParentId: 'a', reportBack: 'true' })
    assert.deepEqual(build([a, b, c]), build([c, b, a]))
  })
})
