// Validation for canvas artifact payloads at the hook-server boundary.
//
// Pure module (no electron/fs imports) so it is unit-testable with `node --test`.
// Existence checks on image paths are the caller's job (hook-server) — this
// module validates shape, caps, and coordinate sanity only.
//
// Error messages are surfaced verbatim to the emitting agent via the MCP tool
// result, so they are written to be self-correcting instructions.

import { isAbsolute, extname } from 'path'
import {
  ALLOWED_IMAGE_EXTS,
  MAX_ANNOTATIONS,
  MAX_ANNOTATION_TEXT_CHARS,
  MAX_CELL_CHARS,
  MAX_MARKDOWN_CHARS,
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  MAX_TITLE_CHARS,
  type Annotation,
  type CanvasArtifactPayload,
  type TableCell,
  type TableSpec,
} from './canvas-types.ts'

/** Coordinate space for incoming annotations. 'natural' = pixels in the
 *  image's natural size (storage format). 'relative' = fractions 0–1 of
 *  width/height — converted to natural pixels at the emit boundary so the
 *  agent never needs to know the image's pixel dimensions. */
export type CoordSpace = 'natural' | 'relative'

export type ValidationResult =
  | { ok: true; value: CanvasArtifactPayload; coordSpace: CoordSpace }
  | { ok: false; error: string }

const KNOWN_COMPONENTS = new Set(['result-table', 'markdown', 'image', 'annotated-image'])

/** CSS color: #rgb/#rgba/#rrggbb/#rrggbbaa or a bare lowercase keyword. */
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$|^[a-z]+$/

function err(error: string): ValidationResult {
  return { ok: false, error }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finiteNonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

function validTitle(title: unknown): string | undefined | null {
  if (title === undefined) return undefined
  if (typeof title !== 'string' || title.length > MAX_TITLE_CHARS) return null
  return title
}

function validateTable(table: unknown): { value?: TableSpec; error?: string } {
  if (!isRecord(table)) return { error: 'table must be an object with columns and rows' }
  const { columns, rows } = table as { columns?: unknown; rows?: unknown }

  if (!Array.isArray(columns) || columns.length === 0) {
    return { error: 'table.columns must be a non-empty array' }
  }
  if (columns.length > MAX_TABLE_COLUMNS) {
    return { error: `table.columns exceeds the cap of ${MAX_TABLE_COLUMNS}` }
  }
  const keys = new Set<string>()
  for (const col of columns) {
    if (!isRecord(col) || typeof col.key !== 'string' || col.key.length === 0) {
      return { error: 'every table column needs a non-empty string "key"' }
    }
    if (keys.has(col.key)) return { error: `duplicate table column key "${col.key}"` }
    keys.add(col.key)
    if (col.label !== undefined && typeof col.label !== 'string') {
      return { error: `column "${col.key}" label must be a string` }
    }
    if (col.align !== undefined && !['left', 'right', 'center'].includes(col.align as string)) {
      return { error: `column "${col.key}" align must be left|right|center` }
    }
  }

  if (!Array.isArray(rows)) return { error: 'table.rows must be an array' }
  if (rows.length > MAX_TABLE_ROWS) {
    return { error: `table.rows exceeds the cap of ${MAX_TABLE_ROWS} rows` }
  }
  if (rows.length * columns.length > MAX_TABLE_CELLS) {
    return { error: `table exceeds the cap of ${MAX_TABLE_CELLS} total cells (rows × columns)` }
  }
  for (const row of rows) {
    if (!isRecord(row)) return { error: 'every table row must be an object keyed by column key' }
    for (const [k, v] of Object.entries(row)) {
      const t = typeof v
      if (v !== null && t !== 'string' && t !== 'number' && t !== 'boolean') {
        return { error: `cell "${k}" must be a string, number, boolean, or null` }
      }
      if (t === 'string' && (v as string).length > MAX_CELL_CHARS) {
        return { error: `cell "${k}" exceeds ${MAX_CELL_CHARS} chars` }
      }
    }
  }

  return {
    value: {
      columns: columns.map((c) => {
        const col = c as Record<string, unknown>
        return {
          key: col.key as string,
          ...(col.label !== undefined ? { label: col.label as string } : {}),
          ...(col.align !== undefined ? { align: col.align as 'left' | 'right' | 'center' } : {}),
        }
      }),
      rows: rows as Array<Record<string, TableCell>>,
    },
  }
}

function validateImagePath(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0) return null
  if (!isAbsolute(path)) return null
  if (!ALLOWED_IMAGE_EXTS.has(extname(path).toLowerCase())) return null
  return path
}

/** Per-kind required coords; normalizes to the internal Annotation union. */
function validateAnnotation(a: unknown, i: number): { value?: Annotation; error?: string } {
  if (!isRecord(a)) return { error: `annotation ${i} must be an object` }
  const bad = (msg: string): { error: string } => ({ error: `annotation ${i} (${a.kind}): ${msg}` })

  if (a.color !== undefined && (typeof a.color !== 'string' || !COLOR_RE.test(a.color))) {
    return bad('color must be a hex color like "#f43f5e" or a CSS keyword like "red"')
  }
  const color = a.color as string | undefined
  if (a.label !== undefined && typeof a.label !== 'string') return bad('label must be a string')
  if (a.text !== undefined && typeof a.text !== 'string') return bad('text must be a string')
  const labelText = (a.label ?? a.text) as string | undefined
  if (labelText !== undefined && labelText.length > MAX_ANNOTATION_TEXT_CHARS) {
    return bad(`label/text exceeds ${MAX_ANNOTATION_TEXT_CHARS} chars`)
  }

  switch (a.kind) {
    case 'circle': {
      if (!finiteNonNegative(a.cx) || !finiteNonNegative(a.cy) || !finiteNonNegative(a.r)) {
        return bad('requires numeric cx, cy, r (pixels in the image\'s natural size)')
      }
      return { value: { kind: 'circle', cx: a.cx, cy: a.cy, r: a.r, ...(labelText ? { label: labelText } : {}), ...(color ? { color } : {}) } }
    }
    case 'box': {
      if (!finiteNonNegative(a.x) || !finiteNonNegative(a.y) || !finiteNonNegative(a.w) || !finiteNonNegative(a.h)) {
        return bad('requires numeric x, y, w, h (pixels in the image\'s natural size)')
      }
      return { value: { kind: 'box', x: a.x, y: a.y, w: a.w, h: a.h, ...(labelText ? { label: labelText } : {}), ...(color ? { color } : {}) } }
    }
    case 'arrow': {
      if (!finiteNonNegative(a.x1) || !finiteNonNegative(a.y1) || !finiteNonNegative(a.x2) || !finiteNonNegative(a.y2)) {
        return bad('requires numeric x1, y1, x2, y2 (tail → head, pixels in the image\'s natural size)')
      }
      return { value: { kind: 'arrow', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, ...(labelText ? { label: labelText } : {}), ...(color ? { color } : {}) } }
    }
    case 'label': {
      if (!finiteNonNegative(a.x) || !finiteNonNegative(a.y)) {
        return bad('requires numeric x, y (pixels in the image\'s natural size)')
      }
      if (!labelText) return bad('requires "text"')
      return { value: { kind: 'label', x: a.x, y: a.y, text: labelText, ...(color ? { color } : {}) } }
    }
    default:
      return { error: `annotation ${i}: unknown kind "${String(a.kind)}" — use circle, box, arrow, or label` }
  }
}

/** Validate an artifact payload (as sent to /canvas/emit). Normalizes
 *  image + non-empty annotations to component 'annotated-image'. */
export function validateCanvasArtifact(input: unknown): ValidationResult {
  if (!isRecord(input)) return err('artifact must be an object')
  const component = input.component
  if (typeof component !== 'string' || !KNOWN_COMPONENTS.has(component)) {
    return err(
      `unknown component "${String(component)}" — must be one of: result-table, markdown, image, annotated-image`,
    )
  }

  const title = validTitle(input.title)
  if (title === null) return err(`title must be a string of at most ${MAX_TITLE_CHARS} chars`)

  const coordSpaceRaw = input.coordSpace
  if (coordSpaceRaw !== undefined && coordSpaceRaw !== 'natural' && coordSpaceRaw !== 'relative') {
    return err('coordSpace must be "natural" (pixels) or "relative" (0–1 fractions)')
  }
  const coordSpace: CoordSpace = (coordSpaceRaw as CoordSpace | undefined) ?? 'natural'

  switch (component) {
    case 'result-table': {
      const { value, error } = validateTable(input.table)
      if (!value) return err(error!)
      return { ok: true, coordSpace, value: { component: 'result-table', ...(title ? { title } : {}), table: value } }
    }
    case 'markdown': {
      if (typeof input.markdown !== 'string' || input.markdown.length === 0) {
        return err('markdown must be a non-empty string')
      }
      if (input.markdown.length > MAX_MARKDOWN_CHARS) {
        return err(`markdown exceeds the cap of ${MAX_MARKDOWN_CHARS} chars`)
      }
      return { ok: true, coordSpace, value: { component: 'markdown', ...(title ? { title } : {}), markdown: input.markdown } }
    }
    case 'image':
    case 'annotated-image': {
      if (!isRecord(input.image)) return err('image must be an object with a "path"')
      const path = validateImagePath(input.image.path)
      if (!path) {
        return err(
          'image.path must be an ABSOLUTE path to a .png/.jpg/.jpeg/.gif/.webp file',
        )
      }
      const alt = input.image.alt
      if (alt !== undefined && typeof alt !== 'string') return err('image.alt must be a string')
      const image = { path, ...(alt ? { alt } : {}) }

      const rawAnnotations = input.annotations
      if (rawAnnotations !== undefined && !Array.isArray(rawAnnotations)) {
        return err('annotations must be an array')
      }
      const list = (rawAnnotations as unknown[] | undefined) ?? []
      if (list.length > MAX_ANNOTATIONS) {
        return err(`annotations exceed the cap of ${MAX_ANNOTATIONS}`)
      }
      if (list.length === 0) {
        return { ok: true, coordSpace, value: { component: 'image', ...(title ? { title } : {}), image } }
      }
      const annotations: Annotation[] = []
      for (let i = 0; i < list.length; i++) {
        const { value, error } = validateAnnotation(list[i], i)
        if (!value) return err(error!)
        annotations.push(value)
      }
      if (coordSpace === 'relative') {
        const rangeError = relativeRangeError(annotations)
        if (rangeError) return err(rangeError)
      }
      return {
        ok: true,
        coordSpace,
        value: { component: 'annotated-image', ...(title ? { title } : {}), image, annotations },
      }
    }
  }
  return err('unreachable') // switch is exhaustive over KNOWN_COMPONENTS
}

// ── Coordinate-space helpers (used by hook-server at the emit boundary) ──────

/** Numeric fields per annotation kind, split by which image axis scales them. */
const X_FIELDS = ['x', 'cx', 'x1', 'x2', 'w'] as const
const Y_FIELDS = ['y', 'cy', 'y1', 'y2', 'h'] as const

/** In 'relative' mode every coordinate must be a 0–1 fraction. A value > 1 is
 *  almost always pixel coords sent with the wrong coordSpace — say so. */
function relativeRangeError(annotations: Annotation[]): string | null {
  for (let i = 0; i < annotations.length; i++) {
    const a = annotations[i] as unknown as Record<string, unknown>
    for (const f of [...X_FIELDS, ...Y_FIELDS, 'r']) {
      const v = a[f]
      if (typeof v === 'number' && v > 1) {
        return `annotation ${i} (${a.kind}): ${f}=${v} but coordSpace is "relative" — pass 0–1 fractions of the image size, or use coordSpace "natural" for pixel values`
      }
    }
  }
  return null
}

/** Convert relative (0–1) annotations to natural-pixel coordinates: x-axis
 *  fields scale by width, y-axis by height, circle radius by min(w,h). */
export function scaleAnnotationsToNatural(annotations: Annotation[], width: number, height: number): Annotation[] {
  return annotations.map((a) => {
    const out = { ...a } as unknown as Record<string, unknown>
    for (const f of X_FIELDS) if (typeof out[f] === 'number') out[f] = Math.round((out[f] as number) * width)
    for (const f of Y_FIELDS) if (typeof out[f] === 'number') out[f] = Math.round((out[f] as number) * height)
    if (typeof out.r === 'number') out.r = Math.round(out.r * Math.min(width, height))
    return out as unknown as Annotation
  })
}

/** Reject natural-pixel annotations whose anchors land clearly outside the
 *  image (5% tolerance — labels may intentionally hug an edge). Vision models
 *  mis-estimating scale is the common failure; the error carries the real
 *  dimensions so the agent can correct without measuring the file itself. */
export function annotationBoundsError(annotations: Annotation[], width: number, height: number): string | null {
  const maxX = width * 1.05
  const maxY = height * 1.05
  for (let i = 0; i < annotations.length; i++) {
    const a = annotations[i] as unknown as Record<string, unknown>
    for (const f of X_FIELDS) {
      const v = a[f]
      if (typeof v === 'number' && v > maxX) {
        return `annotation ${i} (${a.kind}): ${f}=${v} is outside the image — it is ${width}×${height} pixels. Use coordinates within those bounds, or coordSpace "relative" with 0–1 fractions.`
      }
    }
    for (const f of Y_FIELDS) {
      const v = a[f]
      if (typeof v === 'number' && v > maxY) {
        return `annotation ${i} (${a.kind}): ${f}=${v} is outside the image — it is ${width}×${height} pixels. Use coordinates within those bounds, or coordSpace "relative" with 0–1 fractions.`
      }
    }
  }
  return null
}
