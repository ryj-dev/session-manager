/**
 * Spawn-tree topology for the graph view.
 *
 * A session normally hangs off its project hub. When a session spawns a child
 * it is *waiting on* — `reportBack: "true"` (report findings) or `"done"`
 * (ping when finished) — the child hangs off the parent instead, so the graph
 * shows the dependency. Fire-and-forget children (`"optional"`, `"false"`, and
 * anything the user opened themselves) stay on the hub: nobody is blocked on
 * them, and a handoff is a replacement rather than a subordinate.
 *
 * Three rules keep the tree honest:
 *
 *  - **Live-ancestor walk.** Parentage is resolved at render time, not fixed at
 *    spawn time. When a parent closes, its children re-attach to the nearest
 *    still-live ancestor, falling back to the hub — they are never stranded and
 *    nothing has to be rewritten on close.
 *  - **Same project only.** A child spawned into a different project belongs to
 *    its own hub. Cross-cluster edges would drag a node away from the hub whose
 *    collision footprint is supposed to contain it.
 *  - **Depth cap.** Thumbnails are large; past {@link MAX_TREE_DEPTH} levels a
 *    tree costs more space than it explains, so deeper descendants re-attach to
 *    their deepest permitted ancestor.
 */

/**
 * Report-back contract passed to spawn-session / spawn-agent. Declared here
 * rather than in the store so the topology stays a dependency-free module.
 */
export type ReportBackMode = 'true' | 'done' | 'optional' | 'false'

/** Root sits at depth 0, so a cap of 2 shows children and grandchildren. */
export const MAX_TREE_DEPTH = 2

/** The subset of a session the topology cares about. */
export interface SpawnNodeInput {
  id: string
  projectPath: string
  /** Spawner's session id, when this session was spawned by another. */
  spawnParentId: string | null
  reportBack: ReportBackMode | null
}

export interface TreeNode {
  id: string
  children: TreeNode[]
}

export interface SpawnForest {
  /** Project path → root nodes (each with nested children). */
  byProject: Map<string, TreeNode[]>
  /** Child session id → the session id it visually hangs off. */
  parentOf: Map<string, string>
}

/** Report-back modes that mean "the parent is waiting on this child". */
function isAwaited(mode: ReportBackMode | null): boolean {
  return mode === 'true' || mode === 'done'
}

/**
 * Record every spawn link we have ever seen, so a child can still find a live
 * *grand*parent after its immediate parent exits. Live sessions carry their own
 * `spawnParentId`, but a session that has closed is gone from the store — the
 * chain would break at the first dead link without this.
 *
 * Bounded by the number of spawns in one app run, and each entry is two short
 * strings, so it is left to grow rather than pruned on a timer.
 */
export function recordLineage(lineage: Map<string, string>, nodes: SpawnNodeInput[]): void {
  for (const n of nodes) {
    if (n.spawnParentId && n.spawnParentId !== n.id) lineage.set(n.id, n.spawnParentId)
  }
}

/**
 * Resolve every session's effective graph parent and assemble the per-project
 * forest. `nodes` must be the sessions that actually get their own graph node
 * (composite members excluded) — anything absent counts as dead for the walk.
 */
export function buildSpawnForest(
  nodes: SpawnNodeInput[],
  lineage: Map<string, string> = new Map()
): SpawnForest {
  const index = new Map(nodes.map((n) => [n.id, n]))
  const parentOf = new Map<string, string>()

  for (const node of nodes) {
    if (!isAwaited(node.reportBack)) continue
    const parent = findLiveAncestor(node, index, lineage)
    if (parent) parentOf.set(node.id, parent)
  }

  breakCycles(parentOf)

  // Assemble the forest. Every session gets a TreeNode; linked ones are then
  // moved under their parent, leaving the roots on their hub.
  const treeNodes = new Map<string, TreeNode>(nodes.map((n) => [n.id, { id: n.id, children: [] }]))
  for (const [childId, parentId] of parentOf) {
    treeNodes.get(parentId)!.children.push(treeNodes.get(childId)!)
  }

  const byProject = new Map<string, TreeNode[]>()
  for (const node of nodes) {
    if (parentOf.has(node.id)) continue
    const roots = byProject.get(node.projectPath)
    if (roots) roots.push(treeNodes.get(node.id)!)
    else byProject.set(node.projectPath, [treeNodes.get(node.id)!])
  }

  enforceDepthCap(byProject, parentOf, treeNodes)
  sortForest(byProject)
  return { byProject, parentOf }
}

/**
 * Walk up the spawn chain to the closest ancestor that is still on the graph in
 * the same project. Returns null when the chain runs out (→ hub), when it
 * reaches a cross-project ancestor, or when it loops.
 */
function findLiveAncestor(
  node: SpawnNodeInput,
  index: Map<string, SpawnNodeInput>,
  lineage: Map<string, string>
): string | null {
  const seen = new Set<string>([node.id])
  let cursor = node.spawnParentId

  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const ancestor = index.get(cursor)
    if (ancestor) {
      // A live ancestor in another project ends the walk: the child belongs to
      // its own hub rather than reaching across clusters or past the ancestor.
      return ancestor.projectPath === node.projectPath ? cursor : null
    }
    cursor = lineage.get(cursor) ?? null
  }
  return null
}

/**
 * Drop links that would form a cycle. `findLiveAncestor` already refuses to
 * follow a loop upward, but two sessions can still name each other as parent
 * (A spawns B, then B respawns A after A's original node is gone), which would
 * leave both out of every root list and silently vanish from the graph.
 */
function breakCycles(parentOf: Map<string, string>): void {
  for (const start of Array.from(parentOf.keys())) {
    const seen = new Set<string>([start])
    let cursor = parentOf.get(start)
    while (cursor) {
      if (seen.has(cursor)) {
        parentOf.delete(start)
        break
      }
      seen.add(cursor)
      cursor = parentOf.get(cursor)
    }
  }
}

/** Re-attach anything deeper than MAX_TREE_DEPTH to its deepest allowed ancestor. */
function enforceDepthCap(
  byProject: Map<string, TreeNode[]>,
  parentOf: Map<string, string>,
  treeNodes: Map<string, TreeNode>
): void {
  for (const roots of byProject.values()) {
    for (const root of roots) {
      const queue: Array<{ node: TreeNode; depth: number }> = [{ node: root, depth: 0 }]
      while (queue.length > 0) {
        const { node, depth } = queue.shift()!
        if (depth < MAX_TREE_DEPTH) {
          for (const child of node.children) queue.push({ node: child, depth: depth + 1 })
          continue
        }
        // At the cap: hoist the whole subtree below this node onto it, so the
        // over-deep descendants stay in the family instead of jumping to the hub.
        const descendants: TreeNode[] = []
        collectDescendants(node, descendants)
        for (const d of descendants) {
          d.children = []
          parentOf.set(d.id, node.id)
        }
        node.children = descendants
        for (const d of descendants) treeNodes.set(d.id, d)
      }
    }
  }
}

function collectDescendants(node: TreeNode, out: TreeNode[]): void {
  for (const child of node.children) {
    out.push(child)
    collectDescendants(child, out)
  }
}

/** Deterministic ordering so a node's slot doesn't shift when the input order does. */
function sortForest(byProject: Map<string, TreeNode[]>): void {
  const sortNode = (node: TreeNode): void => {
    node.children.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    node.children.forEach(sortNode)
  }
  for (const roots of byProject.values()) {
    roots.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    roots.forEach(sortNode)
  }
}

/** Flatten a forest to ids in depth-first order (roots first within each subtree). */
export function flattenTree(nodes: TreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.id)
    flattenTree(node.children, out)
  }
  return out
}
