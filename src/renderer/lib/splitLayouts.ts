/**
 * Split-view layout — N-ary container model (i3-style).
 *
 * A `Layout` is either a leaf (one session) or a container with K ≥ 2 children
 * laid along one axis (`row` = horizontal, `col` = vertical). Each container
 * carries a `weights` array (same length as `children`) whose entries sum to 1
 * and represent each child's fractional size along the container's axis.
 *
 * Invariants:
 *   - Every leaf has a unique session id; the leaves of a group's layout match
 *     its member set exactly.
 *   - Every container has ≥ 2 children and weights summing to 1.
 *   - A container's direct child is never a same-`dir` container — we always
 *     flatten chains (a row inside a row collapses into the parent row).
 *   - Each weight is clamped to `MIN_WEIGHT` ≤ w ≤ 1 - MIN_WEIGHT*(K-1).
 */

export type Layout = LayoutLeaf | LayoutContainer

export interface LayoutLeaf {
  kind: 'leaf'
  id: string
}

export interface LayoutContainer {
  kind: 'container'
  /** `row` = children laid horizontally; `col` = stacked vertically. */
  dir: 'row' | 'col'
  /** K ≥ 2 children. */
  children: Layout[]
  /** Same length as `children`, sums to ~1. */
  weights: number[]
}

/** A child-index path from the root. */
export type LayoutPath = number[]

export const MIN_WEIGHT = 0.08
export const MAX_SPLIT_N = 9

// ---------------------------------------------------------------------------
// Legacy migration — `shapeId` (grid) and BSP-tree are both still on disk
// from earlier iterations of the layout model.
// ---------------------------------------------------------------------------

export type SlotRect = { col: number; row: number; colSpan: number; rowSpan: number }
export type Shape = { id: string; cols: number; rows: number; slots: SlotRect[] }

const cell = (col: number, row: number, colSpan = 1, rowSpan = 1): SlotRect => ({
  col, row, colSpan, rowSpan,
})

const LEGACY_SHAPES: Record<number, Shape[]> = {
  2: [
    { id: '2-cols', cols: 2, rows: 2, slots: [cell(0, 0, 1, 2), cell(1, 0, 1, 2)] },
    { id: '2-rows', cols: 2, rows: 2, slots: [cell(0, 0, 2, 1), cell(0, 1, 2, 1)] },
  ],
  3: [
    { id: '2top-1wide-bottom', cols: 2, rows: 2,
      slots: [cell(0, 0), cell(1, 0), cell(0, 1, 2, 1)] },
    { id: '1wide-top-2bottom', cols: 2, rows: 2,
      slots: [cell(0, 0, 2, 1), cell(0, 1), cell(1, 1)] },
    { id: 'big-l-2-r', cols: 2, rows: 2,
      slots: [cell(0, 0, 1, 2), cell(1, 0), cell(1, 1)] },
    { id: '2-l-big-r', cols: 2, rows: 2,
      slots: [cell(0, 0), cell(0, 1), cell(1, 0, 1, 2)] },
  ],
  4: [
    { id: '2x2', cols: 2, rows: 2,
      slots: [cell(0, 0), cell(1, 0), cell(0, 1), cell(1, 1)] },
    { id: '1wide-top-3-below', cols: 3, rows: 3,
      slots: [cell(0, 0, 3, 1), cell(0, 1, 1, 2), cell(1, 1, 1, 2), cell(2, 1, 1, 2)] },
    { id: '3-above-1wide-bottom', cols: 3, rows: 3,
      slots: [cell(0, 0, 1, 2), cell(1, 0, 1, 2), cell(2, 0, 1, 2), cell(0, 2, 3, 1)] },
    { id: 'big-l-3-stacked-r', cols: 3, rows: 3,
      slots: [cell(0, 0, 2, 3), cell(2, 0), cell(2, 1), cell(2, 2)] },
    { id: '3-stacked-l-big-r', cols: 3, rows: 3,
      slots: [cell(0, 0), cell(0, 1), cell(0, 2), cell(1, 0, 2, 3)] },
  ],
  5: [
    { id: 'big-tl-tall-r-row-b', cols: 3, rows: 3,
      slots: [cell(0, 0, 2, 2), cell(2, 0, 1, 2), cell(0, 2), cell(1, 2), cell(2, 2)] },
    { id: 'tall-l-big-tr-row-b', cols: 3, rows: 3,
      slots: [cell(1, 0, 2, 2), cell(0, 0, 1, 2), cell(0, 2), cell(1, 2), cell(2, 2)] },
    { id: 'row-t-big-bl-tall-r', cols: 3, rows: 3,
      slots: [cell(0, 0), cell(1, 0), cell(2, 0), cell(0, 1, 2, 2), cell(2, 1, 1, 2)] },
  ],
  6: [
    { id: '3-top-3-tall', cols: 3, rows: 3,
      slots: [cell(0, 0), cell(1, 0), cell(2, 0),
        cell(0, 1, 1, 2), cell(1, 1, 1, 2), cell(2, 1, 1, 2)] },
  ],
  7: [
    { id: '6-grid-1wide-bottom', cols: 3, rows: 3,
      slots: [cell(0, 0), cell(1, 0), cell(2, 0),
        cell(0, 1), cell(1, 1), cell(2, 1),
        cell(0, 2, 3, 1)] },
  ],
  8: [
    { id: '6-grid-1wide-1-bottom', cols: 3, rows: 3,
      slots: [cell(0, 0), cell(1, 0), cell(2, 0),
        cell(0, 1), cell(1, 1), cell(2, 1),
        cell(0, 2, 2, 1), cell(2, 2)] },
  ],
  9: [
    { id: '3x3', cols: 3, rows: 3,
      slots: [cell(0, 0), cell(1, 0), cell(2, 0),
        cell(0, 1), cell(1, 1), cell(2, 1),
        cell(0, 2), cell(1, 2), cell(2, 2)] },
  ],
}

function legacyShapeById(id: string): Shape | null {
  for (const shapes of Object.values(LEGACY_SHAPES)) {
    const found = shapes.find((s) => s.id === id)
    if (found) return found
  }
  return null
}

// ---------------------------------------------------------------------------
// Public construction API
// ---------------------------------------------------------------------------

export function defaultLayoutFor(sessionIds: string[]): Layout | null {
  if (sessionIds.length === 0) return null
  if (sessionIds.length === 1) return { kind: 'leaf', id: sessionIds[0] }
  const n = Math.min(sessionIds.length, MAX_SPLIT_N)
  const shapes = LEGACY_SHAPES[n]
  if (shapes && shapes.length > 0) {
    const fromShape = layoutFromShape(shapes[0], sessionIds)
    if (fromShape) return fromShape
  }
  return evenContainer('row', sessionIds.map((id) => leaf(id)))
}

function leaf(id: string): LayoutLeaf {
  return { kind: 'leaf', id }
}

function container(dir: 'row' | 'col', children: Layout[], weights: number[]): Layout {
  if (children.length === 1) return children[0]
  return flatten({ kind: 'container', dir, children, weights: normalizeWeights(weights) })
}

function evenContainer(dir: 'row' | 'col', children: Layout[]): Layout {
  const w = 1 / children.length
  return container(dir, children, children.map(() => w))
}

/** Convert a legacy grid `Shape` to an N-ary layout. */
export function layoutFromShape(shape: Shape, sessionIds: string[]): Layout | null {
  if (shape.slots.length === 0) return null
  const annotated = shape.slots
    .slice(0, sessionIds.length)
    .map((s, i) => ({ ...s, id: sessionIds[i] }))
  return gridToLayout(shape.cols, shape.rows, annotated)
}

/** Convert a persisted `shapeId` to a layout. */
export function layoutFromShapeId(shapeId: string | null, sessionIds: string[]): Layout | null {
  if (!shapeId) return defaultLayoutFor(sessionIds)
  const shape = legacyShapeById(shapeId)
  if (!shape) return defaultLayoutFor(sessionIds)
  return layoutFromShape(shape, sessionIds)
}

/**
 * Convert an old BSP-tree (`kind: 'split'` with `a`/`b`/`ratio`) to the new
 * container model. Flattens chains of same-direction splits into one container.
 */
export function layoutFromBsp(node: unknown): Layout | null {
  if (!node || typeof node !== 'object') return null
  const n = node as { kind?: string }
  if (n.kind === 'leaf') {
    const leafNode = node as { kind: 'leaf'; id: string }
    return { kind: 'leaf', id: leafNode.id }
  }
  if (n.kind === 'split') {
    const split = node as { kind: 'split'; dir: 'row' | 'col'; ratio: number; a: unknown; b: unknown }
    const a = layoutFromBsp(split.a)
    const b = layoutFromBsp(split.b)
    if (!a || !b) return a ?? b
    return container(split.dir, [a, b], [split.ratio, 1 - split.ratio])
  }
  // Already a container? Trust it.
  if (n.kind === 'container') {
    const c = node as LayoutContainer
    const children = c.children.map((ch) => layoutFromBsp(ch)).filter((x): x is Layout => !!x)
    if (children.length === 0) return null
    if (children.length === 1) return children[0]
    return container(c.dir, children, c.weights ?? children.map(() => 1 / children.length))
  }
  return null
}

interface AnnotatedSlot extends SlotRect { id: string }

function gridToLayout(cols: number, rows: number, slots: AnnotatedSlot[]): Layout {
  if (slots.length === 1) return leaf(slots[0].id)

  // Multi-cut: find every clean column cut; split into K vertical bands.
  const colCuts = findCleanCuts(cols, slots, 'col')
  if (colCuts.length > 0) {
    const bands = sliceByCol(cols, rows, slots, colCuts)
    return container('row', bands.map((b) => gridToLayout(b.cols, b.rows, b.slots)),
      bands.map((b) => b.cols / cols))
  }
  const rowCuts = findCleanCuts(rows, slots, 'row')
  if (rowCuts.length > 0) {
    const bands = sliceByRow(cols, rows, slots, rowCuts)
    return container('col', bands.map((b) => gridToLayout(b.cols, b.rows, b.slots)),
      bands.map((b) => b.rows / rows))
  }
  // Degenerate fallback.
  return evenContainer('row', slots.map((s) => leaf(s.id)))
}

function findCleanCuts(extent: number, slots: AnnotatedSlot[], axis: 'col' | 'row'): number[] {
  const cuts: number[] = []
  for (let c = 1; c < extent; c++) {
    const ok = slots.every((s) => {
      const start = axis === 'col' ? s.col : s.row
      const span = axis === 'col' ? s.colSpan : s.rowSpan
      return start + span <= c || start >= c
    })
    if (ok) cuts.push(c)
  }
  return cuts
}

function sliceByCol(cols: number, rows: number, slots: AnnotatedSlot[], cuts: number[]) {
  const boundaries = [0, ...cuts, cols]
  const bands: { cols: number; rows: number; slots: AnnotatedSlot[] }[] = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    const lo = boundaries[i]
    const hi = boundaries[i + 1]
    const band = slots
      .filter((s) => s.col + s.colSpan <= hi && s.col >= lo)
      .map((s) => ({ ...s, col: s.col - lo }))
    bands.push({ cols: hi - lo, rows, slots: band })
  }
  return bands
}

function sliceByRow(cols: number, rows: number, slots: AnnotatedSlot[], cuts: number[]) {
  const boundaries = [0, ...cuts, rows]
  const bands: { cols: number; rows: number; slots: AnnotatedSlot[] }[] = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    const lo = boundaries[i]
    const hi = boundaries[i + 1]
    const band = slots
      .filter((s) => s.row + s.rowSpan <= hi && s.row >= lo)
      .map((s) => ({ ...s, row: s.row - lo }))
    bands.push({ cols, rows: hi - lo, slots: band })
  }
  return bands
}

// ---------------------------------------------------------------------------
// Layout introspection
// ---------------------------------------------------------------------------

export interface LayoutRect { x: number; y: number; w: number; h: number }

export interface LayoutLeafView extends LayoutRect {
  id: string
  path: LayoutPath
}

/**
 * Divider between children `dividerIdx` and `dividerIdx + 1` of the container
 * at `containerPath`. Geometry expressed as fractions of the full canvas.
 */
export interface LayoutDivider {
  containerPath: LayoutPath
  dividerIdx: number
  dir: 'row' | 'col'
  /** Canvas-fraction position along the container's axis. */
  axis: number
  /** Perpendicular extent of the divider strip. */
  start: number
  end: number
  containerRect: LayoutRect
  /** Stable identity for hover/highlight; `path.join('.')+`:`+dividerIdx`. */
  key: string
}

export function getLeaves(
  layout: Layout,
  path: LayoutPath = [],
  rect: LayoutRect = { x: 0, y: 0, w: 1, h: 1 },
): LayoutLeafView[] {
  if (layout.kind === 'leaf') {
    return [{ id: layout.id, path, ...rect }]
  }
  const childRects = childRectsOf(rect, layout)
  return layout.children.flatMap((child, i) =>
    getLeaves(child, [...path, i], childRects[i])
  )
}

export function getDividers(
  layout: Layout,
  path: LayoutPath = [],
  rect: LayoutRect = { x: 0, y: 0, w: 1, h: 1 },
): LayoutDivider[] {
  if (layout.kind === 'leaf') return []
  const out: LayoutDivider[] = []
  const cum: number[] = [0]
  for (const w of layout.weights) cum.push(cum[cum.length - 1] + w)
  for (let i = 0; i < layout.children.length - 1; i++) {
    if (layout.dir === 'row') {
      out.push({
        containerPath: path,
        dividerIdx: i,
        dir: 'row',
        axis: rect.x + rect.w * cum[i + 1],
        start: rect.y,
        end: rect.y + rect.h,
        containerRect: rect,
        key: `${path.join('.')}:${i}`,
      })
    } else {
      out.push({
        containerPath: path,
        dividerIdx: i,
        dir: 'col',
        axis: rect.y + rect.h * cum[i + 1],
        start: rect.x,
        end: rect.x + rect.w,
        containerRect: rect,
        key: `${path.join('.')}:${i}`,
      })
    }
  }
  const childRects = childRectsOf(rect, layout)
  layout.children.forEach((child, i) => {
    out.push(...getDividers(child, [...path, i], childRects[i]))
  })
  return out
}

function childRectsOf(rect: LayoutRect, c: LayoutContainer): LayoutRect[] {
  const out: LayoutRect[] = []
  let cursor = c.dir === 'row' ? rect.x : rect.y
  const total = c.dir === 'row' ? rect.w : rect.h
  for (const w of c.weights) {
    const size = total * w
    if (c.dir === 'row') {
      out.push({ x: cursor, y: rect.y, w: size, h: rect.h })
    } else {
      out.push({ x: rect.x, y: cursor, w: rect.w, h: size })
    }
    cursor += size
  }
  return out
}

export function getLeafIds(layout: Layout): string[] {
  if (layout.kind === 'leaf') return [layout.id]
  return layout.children.flatMap(getLeafIds)
}

export function leafCount(layout: Layout): number {
  if (layout.kind === 'leaf') return 1
  return layout.children.reduce((n, c) => n + leafCount(c), 0)
}

// ---------------------------------------------------------------------------
// Layout mutation
// ---------------------------------------------------------------------------

function normalizeWeights(weights: number[]): number[] {
  const k = weights.length
  if (k === 0) return weights
  const minTotal = MIN_WEIGHT * k
  if (minTotal >= 1) {
    // Pathological — uniform distribution.
    return weights.map(() => 1 / k)
  }
  // Clamp individual weights to >= MIN_WEIGHT, then renormalise.
  const clamped = weights.map((w) => Math.max(MIN_WEIGHT, w))
  const sum = clamped.reduce((a, b) => a + b, 0)
  return clamped.map((w) => w / sum)
}

/** Collapse same-direction containers into the parent. */
function flatten(node: Layout): Layout {
  if (node.kind === 'leaf') return node
  const flattenedChildren: Layout[] = []
  const flattenedWeights: number[] = []
  node.children.forEach((child, i) => {
    const w = node.weights[i]
    const childFlat = flatten(child)
    if (childFlat.kind === 'container' && childFlat.dir === node.dir) {
      childFlat.children.forEach((c, j) => {
        flattenedChildren.push(c)
        flattenedWeights.push(w * childFlat.weights[j])
      })
    } else {
      flattenedChildren.push(childFlat)
      flattenedWeights.push(w)
    }
  })
  if (flattenedChildren.length === 1) return flattenedChildren[0]
  return { kind: 'container', dir: node.dir, children: flattenedChildren, weights: normalizeWeights(flattenedWeights) }
}

export function updateAtPath(
  layout: Layout,
  path: LayoutPath,
  updater: (n: Layout) => Layout,
): Layout {
  if (path.length === 0) return updater(layout)
  if (layout.kind !== 'container') return layout
  const [head, ...rest] = path
  if (head < 0 || head >= layout.children.length) return layout
  const newChild = updateAtPath(layout.children[head], rest, updater)
  if (newChild === layout.children[head]) return layout
  const children = layout.children.slice()
  children[head] = newChild
  return { ...layout, children }
}

export function swapLeaves(layout: Layout, idA: string, idB: string): Layout {
  if (idA === idB) return layout
  if (layout.kind === 'leaf') {
    if (layout.id === idA) return { ...layout, id: idB }
    if (layout.id === idB) return { ...layout, id: idA }
    return layout
  }
  let changed = false
  const next = layout.children.map((c) => {
    const swapped = swapLeaves(c, idA, idB)
    if (swapped !== c) changed = true
    return swapped
  })
  return changed ? { ...layout, children: next } : layout
}

/**
 * Move a divider to a new canvas-fraction position along its axis.
 * Only the two children adjacent to the divider change weight; siblings on
 * either side are untouched. Clamps to keep all weights ≥ MIN_WEIGHT.
 */
export function setDividerPosition(
  layout: Layout,
  containerPath: LayoutPath,
  dividerIdx: number,
  newAxisFraction: number,
  containerRect: LayoutRect,
): Layout {
  return updateAtPath(layout, containerPath, (node) => {
    if (node.kind !== 'container') return node
    if (dividerIdx < 0 || dividerIdx >= node.children.length - 1) return node
    // Convert canvas-global fraction → container-local fraction.
    const localOrigin = node.dir === 'row' ? containerRect.x : containerRect.y
    const localExtent = node.dir === 'row' ? containerRect.w : containerRect.h
    if (localExtent <= 0) return node
    const localFrac = (newAxisFraction - localOrigin) / localExtent
    // Cumulative position of divider in container-local coords.
    let cum = 0
    for (let i = 0; i <= dividerIdx; i++) cum += node.weights[i]
    const oldDividerPos = cum
    const pair = node.weights[dividerIdx] + node.weights[dividerIdx + 1]
    const leftCum = oldDividerPos - node.weights[dividerIdx] // sum before pair
    let w0 = localFrac - leftCum
    w0 = Math.max(MIN_WEIGHT, Math.min(pair - MIN_WEIGHT, w0))
    const w1 = pair - w0
    if (w0 === node.weights[dividerIdx] && w1 === node.weights[dividerIdx + 1]) return node
    const weights = node.weights.slice()
    weights[dividerIdx] = w0
    weights[dividerIdx + 1] = w1
    return { ...node, weights }
  })
}

/**
 * Like `setDividerPosition` but applied to a set of (path, idx) entries — used
 * by Shift+drag to move every snap-aligned divider together. Each move is
 * applied in path-sort order so independent containers don't interfere.
 */
export function setDividersPosition(
  layout: Layout,
  targets: { containerPath: LayoutPath; dividerIdx: number }[],
  newAxisFraction: number,
): Layout {
  // Recompute container rects fresh each time so cascading edits stay correct.
  let cur = layout
  for (const t of targets) {
    const divider = getDividers(cur).find(
      (d) =>
        d.dividerIdx === t.dividerIdx &&
        d.containerPath.length === t.containerPath.length &&
        d.containerPath.every((p, i) => p === t.containerPath[i])
    )
    if (!divider) continue
    cur = setDividerPosition(cur, t.containerPath, t.dividerIdx, newAxisFraction, divider.containerRect)
  }
  return cur
}

/**
 * Remove the leaf with id `id`. If the parent container ends up with one
 * child, that child replaces it. Returns null if nothing survives.
 */
export function removeLeaf(layout: Layout, id: string): Layout | null {
  if (layout.kind === 'leaf') return layout.id === id ? null : layout
  const kept: { node: Layout; weight: number }[] = []
  for (let i = 0; i < layout.children.length; i++) {
    const child = removeLeaf(layout.children[i], id)
    if (child) kept.push({ node: child, weight: layout.weights[i] })
  }
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0].node
  return flatten({
    kind: 'container',
    dir: layout.dir,
    children: kept.map((k) => k.node),
    weights: normalizeWeights(kept.map((k) => k.weight)),
  })
}

/**
 * Insert a new leaf by appending it as a child of the container that owns
 * the largest leaf. If the largest leaf's parent container's axis matches
 * its longer side we tack on as a sibling (uniform redistribution of the
 * adjacent slot); otherwise we wrap it in a new perpendicular container.
 */
export function insertLeaf(layout: Layout, newId: string): Layout {
  const leaves = getLeaves(layout)
  if (leaves.length === 0) return { kind: 'leaf', id: newId }
  let largest = leaves[0]
  for (const l of leaves) {
    if (l.w * l.h > largest.w * largest.h) largest = l
  }
  // Walk to the parent container of the largest leaf.
  const parentPath = largest.path.slice(0, -1)
  const idxInParent = largest.path[largest.path.length - 1] ?? 0
  // Pick split direction by the leaf's aspect: append along its longer axis
  // so the new pane takes the side rather than chopping it in half awkwardly.
  const preferDir: 'row' | 'col' = largest.w >= largest.h ? 'row' : 'col'

  if (parentPath.length === 0 && layout.kind === 'leaf') {
    // Root is a single leaf — wrap into a 2-child container.
    return {
      kind: 'container',
      dir: preferDir,
      children: [layout, { kind: 'leaf', id: newId }],
      weights: [0.5, 0.5],
    }
  }

  return updateAtPath(layout, parentPath, (parent) => {
    if (parent.kind !== 'container') return parent
    if (parent.dir === preferDir) {
      // Append next to the largest leaf as a sibling, shrinking it by half.
      const oldWeight = parent.weights[idxInParent]
      const newChildren = parent.children.slice()
      const newWeights = parent.weights.slice()
      newChildren.splice(idxInParent + 1, 0, { kind: 'leaf', id: newId })
      newWeights.splice(idxInParent + 1, 0, oldWeight / 2)
      newWeights[idxInParent] = oldWeight / 2
      return { ...parent, children: newChildren, weights: normalizeWeights(newWeights) }
    }
    // Different axis — replace the leaf with a perpendicular 2-child container.
    const replaced: LayoutContainer = {
      kind: 'container',
      dir: preferDir,
      children: [parent.children[idxInParent], { kind: 'leaf', id: newId }],
      weights: [0.5, 0.5],
    }
    const newChildren = parent.children.slice()
    newChildren[idxInParent] = replaced
    return { ...parent, children: newChildren }
  })
}

/** Find the path to the leaf with a given session id, or `null`. */
export function findLeafPath(
  layout: Layout,
  id: string,
  path: LayoutPath = [],
): LayoutPath | null {
  if (layout.kind === 'leaf') return layout.id === id ? path : null
  for (let i = 0; i < layout.children.length; i++) {
    const found = findLeafPath(layout.children[i], id, [...path, i])
    if (found) return found
  }
  return null
}

/**
 * Relocate `draggedId` next to `targetId`. `where` chooses the side:
 *
 *   • 'left' / 'right'  → new horizontal sibling of target (row container)
 *   • 'top'  / 'bottom' → new vertical sibling of target (col container)
 *
 * This is what lets users restructure the tree — swap is in-place, this changes
 * which container holds the moved leaf and may flip a container's direction.
 *
 * Implementation: remove the dragged leaf (which may collapse its old parent),
 * then re-insert next to the target. If target's parent already runs in the
 * desired direction, insert as a sibling; otherwise wrap the target in a new
 * perpendicular 2-child container.
 */
export function moveLeaf(
  layout: Layout,
  draggedId: string,
  targetId: string,
  where: 'left' | 'right' | 'top' | 'bottom',
): Layout {
  if (draggedId === targetId) return layout

  const removed = removeLeaf(layout, draggedId)
  if (!removed) return layout

  const targetPath = findLeafPath(removed, targetId)
  if (!targetPath) return layout

  const wantDir: 'row' | 'col' = where === 'left' || where === 'right' ? 'row' : 'col'
  const insertBefore = where === 'left' || where === 'top'
  const draggedLeaf: LayoutLeaf = { kind: 'leaf', id: draggedId }

  // Special case: target is the root (which is itself a leaf — N was 1 after
  // removal, so removed === leaf). Wrap into a fresh 2-child container.
  if (targetPath.length === 0) {
    const children: Layout[] = insertBefore ? [draggedLeaf, removed] : [removed, draggedLeaf]
    return { kind: 'container', dir: wantDir, children, weights: [0.5, 0.5] }
  }

  const parentPath = targetPath.slice(0, -1)
  const idxInParent = targetPath[targetPath.length - 1]

  const next = updateAtPath(removed, parentPath, (parent) => {
    if (parent.kind !== 'container') return parent
    if (parent.dir === wantDir) {
      // Sibling insert. Split the target's weight in half so the moved leaf
      // gets a sensible starting size and the rest of the row is undisturbed.
      const oldWeight = parent.weights[idxInParent]
      const newChildren = parent.children.slice()
      const newWeights = parent.weights.slice()
      const insertIdx = insertBefore ? idxInParent : idxInParent + 1
      newChildren.splice(insertIdx, 0, draggedLeaf)
      newWeights.splice(insertIdx, 0, oldWeight / 2)
      // Target's new index shifts by one if we inserted before it.
      const targetNewIdx = insertBefore ? idxInParent + 1 : idxInParent
      newWeights[targetNewIdx] = oldWeight / 2
      return { ...parent, children: newChildren, weights: newWeights }
    }
    // Perpendicular: wrap the target in a new 2-child container of `wantDir`.
    const wrapChildren: Layout[] = insertBefore
      ? [draggedLeaf, parent.children[idxInParent]]
      : [parent.children[idxInParent], draggedLeaf]
    const wrap: LayoutContainer = {
      kind: 'container',
      dir: wantDir,
      children: wrapChildren,
      weights: [0.5, 0.5],
    }
    const newChildren = parent.children.slice()
    newChildren[idxInParent] = wrap
    return { ...parent, children: newChildren }
  })
  return flatten(next)
}

/** Drop leaves that no longer exist; collapse single-child containers. */
export function reconcileLayout(layout: Layout, validIds: Set<string>): Layout | null {
  if (layout.kind === 'leaf') return validIds.has(layout.id) ? layout : null
  const kept: { node: Layout; weight: number }[] = []
  for (let i = 0; i < layout.children.length; i++) {
    const child = reconcileLayout(layout.children[i], validIds)
    if (child) kept.push({ node: child, weight: layout.weights[i] })
  }
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0].node
  return flatten({
    kind: 'container',
    dir: layout.dir,
    children: kept.map((k) => k.node),
    weights: normalizeWeights(kept.map((k) => k.weight)),
  })
}
