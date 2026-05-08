/**
 * Split-view layout shape enumeration.
 *
 * Each shape tiles a small integer grid (2×2 for N ≤ 4, 3×3 for N ≥ 5).
 * Slots are integer-cell rectangles; sum of slot areas equals the grid area.
 * Phase 3 ships only the per-N default shape; Phase 4 will expand each entry
 * with alternative tilings to power drag-to-reshape.
 */

export type SlotRect = {
  /** 0-indexed grid column start. */
  col: number
  /** 0-indexed grid row start. */
  row: number
  /** Number of columns this slot spans (>= 1). */
  colSpan: number
  /** Number of rows this slot spans (>= 1). */
  rowSpan: number
}

export type Shape = {
  id: string
  /** Total grid columns (2 or 3). */
  cols: number
  /** Total grid rows (2 or 3). */
  rows: number
  /** length === N; index = slot order (0-based). */
  slots: SlotRect[]
}

const cell = (col: number, row: number, colSpan = 1, rowSpan = 1): SlotRect => ({
  col, row, colSpan, rowSpan,
})

export const SHAPES_BY_N: Record<number, Shape[]> = {
  2: [
    { id: '2-cols', cols: 2, rows: 2, slots: [cell(0, 0, 1, 2), cell(1, 0, 1, 2)] },
    { id: '2-rows', cols: 2, rows: 2, slots: [cell(0, 0, 2, 1), cell(0, 1, 2, 1)] },
  ],
  3: [
    {
      id: '2top-1wide-bottom',
      cols: 2, rows: 2,
      slots: [cell(0, 0), cell(1, 0), cell(0, 1, 2, 1)],
    },
    {
      id: '1wide-top-2bottom',
      cols: 2, rows: 2,
      slots: [cell(0, 0, 2, 1), cell(0, 1), cell(1, 1)],
    },
    {
      id: 'big-l-2-r',
      cols: 2, rows: 2,
      slots: [cell(0, 0, 1, 2), cell(1, 0), cell(1, 1)],
    },
    {
      id: '2-l-big-r',
      cols: 2, rows: 2,
      slots: [cell(0, 0), cell(0, 1), cell(1, 0, 1, 2)],
    },
  ],
  4: [
    {
      id: '2x2',
      cols: 2, rows: 2,
      slots: [cell(0, 0), cell(1, 0), cell(0, 1), cell(1, 1)],
    },
    {
      // 1 wide on top, 3 columns below (3x3 substrate)
      id: '1wide-top-3-below',
      cols: 3, rows: 3,
      slots: [
        cell(0, 0, 3, 1),
        cell(0, 1, 1, 2), cell(1, 1, 1, 2), cell(2, 1, 1, 2),
      ],
    },
    {
      id: '3-above-1wide-bottom',
      cols: 3, rows: 3,
      slots: [
        cell(0, 0, 1, 2), cell(1, 0, 1, 2), cell(2, 0, 1, 2),
        cell(0, 2, 3, 1),
      ],
    },
    {
      // big tall-left + 3 stacked right column
      id: 'big-l-3-stacked-r',
      cols: 3, rows: 3,
      slots: [
        cell(0, 0, 2, 3),
        cell(2, 0), cell(2, 1), cell(2, 2),
      ],
    },
    {
      id: '3-stacked-l-big-r',
      cols: 3, rows: 3,
      slots: [
        cell(0, 0), cell(0, 1), cell(0, 2),
        cell(1, 0, 2, 3),
      ],
    },
  ],
  5: [
    {
      id: 'big-tl-tall-r-row-b',
      cols: 3, rows: 3,
      slots: [
        cell(0, 0, 2, 2), // big top-left
        cell(2, 0, 1, 2), // tall right column for top half
        cell(0, 2),
        cell(1, 2),
        cell(2, 2),
      ],
    },
    {
      // mirror — big top-right
      id: 'tall-l-big-tr-row-b',
      cols: 3, rows: 3,
      slots: [
        cell(1, 0, 2, 2), // big top-right (cols 1-2)
        cell(0, 0, 1, 2), // tall left column for top
        cell(0, 2),
        cell(1, 2),
        cell(2, 2),
      ],
    },
    {
      // row top + big bottom-left
      id: 'row-t-big-bl-tall-r',
      cols: 3, rows: 3,
      slots: [
        cell(0, 0), cell(1, 0), cell(2, 0),
        cell(0, 1, 2, 2), // big bottom-left
        cell(2, 1, 1, 2), // tall right
      ],
    },
  ],
  6: [
    {
      // 3 short slots on top, 3 tall slots filling the rest.
      id: '3-top-3-tall',
      cols: 3, rows: 3,
      slots: [
        cell(0, 0), cell(1, 0), cell(2, 0),
        cell(0, 1, 1, 2), cell(1, 1, 1, 2), cell(2, 1, 1, 2),
      ],
    },
  ],
  7: [
    {
      id: '6-grid-1wide-bottom',
      cols: 3, rows: 3,
      slots: [
        cell(0, 0), cell(1, 0), cell(2, 0),
        cell(0, 1), cell(1, 1), cell(2, 1),
        cell(0, 2, 3, 1),
      ],
    },
  ],
  8: [
    {
      id: '6-grid-1wide-1-bottom',
      cols: 3, rows: 3,
      slots: [
        cell(0, 0), cell(1, 0), cell(2, 0),
        cell(0, 1), cell(1, 1), cell(2, 1),
        cell(0, 2, 2, 1), // wide bottom-left
        cell(2, 2),
      ],
    },
  ],
  9: [
    {
      id: '3x3',
      cols: 3, rows: 3,
      slots: [
        cell(0, 0), cell(1, 0), cell(2, 0),
        cell(0, 1), cell(1, 1), cell(2, 1),
        cell(0, 2), cell(1, 2), cell(2, 2),
      ],
    },
  ],
}

export const DEFAULT_SHAPE_ID: Record<number, string> = {
  2: '2-cols',
  3: '2top-1wide-bottom',
  4: '2x2',
  5: 'big-tl-tall-r-row-b',
  6: '3-top-3-tall',
  7: '6-grid-1wide-bottom',
  8: '6-grid-1wide-1-bottom',
  9: '3x3',
}

export const MAX_SPLIT_N = 9

export function shapeById(n: number, id: string): Shape | undefined {
  return SHAPES_BY_N[n]?.find((s) => s.id === id)
}

export function defaultShapeFor(n: number): Shape | null {
  if (n < 2 || n > MAX_SPLIT_N) return null
  const shapes = SHAPES_BY_N[n]
  if (!shapes || shapes.length === 0) return null
  const id = DEFAULT_SHAPE_ID[n]
  return shapes.find((s) => s.id === id) ?? shapes[0]
}

/**
 * Resolves a possibly-stale shape id for a group with N members.
 * Returns the requested shape if it's still valid for N, otherwise the default.
 */
export function resolveShape(n: number, shapeId: string | null): Shape | null {
  if (!shapeId) return defaultShapeFor(n)
  return shapeById(n, shapeId) ?? defaultShapeFor(n)
}

/** Center cell coordinate of a slot (in grid-cell units). */
function slotCenter(slot: SlotRect): { cx: number; cy: number } {
  return { cx: slot.col + slot.colSpan / 2, cy: slot.row + slot.rowSpan / 2 }
}

/**
 * Pick the best enumerated shape for a drop interaction.
 *
 * Given the current shape, the index of the slot the user is dragging, and the
 * grid-cell the user dropped on, return the candidate shape whose `slotIdx`
 * lands closest to the drop cell. Ties are broken in favour of the current
 * shape so small, ambiguous drags don't reshuffle unnecessarily.
 *
 * Note: candidates may have different (cols, rows) than the current shape
 * (e.g. dragging a 4-up tile out of the 2x2 substrate into a 3x3 cell).
 * `dropCol` / `dropRow` should be expressed in the candidate's grid space; we
 * normalise by mapping the drop fractional position 0..1 across each grid.
 */
export function pickShapeForDrop(
  n: number,
  currentShapeId: string | null,
  draggedSlotIdx: number,
  dropFracX: number,  // 0..1 across the modal preview
  dropFracY: number,
): Shape | null {
  const candidates = SHAPES_BY_N[n]
  if (!candidates || candidates.length === 0) return null

  let best: Shape | null = null
  let bestScore = Infinity
  for (const candidate of candidates) {
    const slot = candidate.slots[draggedSlotIdx]
    if (!slot) continue
    const { cx, cy } = slotCenter(slot)
    // Normalise slot center into the same 0..1 fractional space as the drop.
    const sx = cx / candidate.cols
    const sy = cy / candidate.rows
    const dx = sx - dropFracX
    const dy = sy - dropFracY
    let score = dx * dx + dy * dy
    if (candidate.id === currentShapeId) score -= 0.0005 // tiebreak toward stable
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}
