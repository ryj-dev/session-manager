// Unit tests for canvas artifact validation.
// Run with: npm test  (node --test, native TS type-stripping on Node 22+).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateCanvasArtifact } from './canvas-validate.ts'
import {
  MAX_ANNOTATIONS,
  MAX_MARKDOWN_CHARS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
} from './canvas-types.ts'

const okTable = {
  component: 'result-table',
  table: {
    columns: [{ key: 'name' }, { key: 'size', label: 'Size', align: 'right' }],
    rows: [
      { name: 'a.ts', size: 120 },
      { name: 'b.ts', size: null },
    ],
  },
}

test('accepts a valid result-table', () => {
  const r = validateCanvasArtifact(okTable)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.value.component, 'result-table')
})

test('accepts valid markdown', () => {
  const r = validateCanvasArtifact({ component: 'markdown', markdown: '# Hi', title: 'Report' })
  assert.equal(r.ok, true)
  if (r.ok && r.value.component === 'markdown') assert.equal(r.value.title, 'Report')
})

test('accepts a plain image and each annotation kind', () => {
  const r = validateCanvasArtifact({ component: 'image', image: { path: '/tmp/shot.png' } })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.value.component, 'image')

  const annotated = validateCanvasArtifact({
    component: 'annotated-image',
    image: { path: '/tmp/shot.PNG', alt: 'screenshot' },
    annotations: [
      { kind: 'circle', cx: 10, cy: 20, r: 5, label: 'here', color: '#f43f5e' },
      { kind: 'box', x: 0, y: 0, w: 100, h: 50, color: 'red' },
      { kind: 'arrow', x1: 0, y1: 0, x2: 10, y2: 10 },
      { kind: 'label', x: 5, y: 5, text: 'note' },
    ],
  })
  assert.equal(annotated.ok, true)
  if (annotated.ok && annotated.value.component === 'annotated-image') {
    assert.equal(annotated.value.annotations.length, 4)
  }
})

test('normalizes image + annotations to annotated-image', () => {
  const r = validateCanvasArtifact({
    component: 'image',
    image: { path: '/tmp/shot.png' },
    annotations: [{ kind: 'circle', cx: 1, cy: 1, r: 1 }],
  })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.value.component, 'annotated-image')
})

test('rejects unknown component kinds', () => {
  const r = validateCanvasArtifact({ component: 'chart', series: [] })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /unknown component/)
})

test('rejects non-object input', () => {
  assert.equal(validateCanvasArtifact(null).ok, false)
  assert.equal(validateCanvasArtifact('markdown').ok, false)
})

test('enforces table caps', () => {
  const wide = {
    component: 'result-table',
    table: {
      columns: Array.from({ length: MAX_TABLE_COLUMNS + 1 }, (_, i) => ({ key: `c${i}` })),
      rows: [],
    },
  }
  assert.equal(validateCanvasArtifact(wide).ok, false)

  const tall = {
    component: 'result-table',
    table: {
      columns: [{ key: 'a' }],
      rows: Array.from({ length: MAX_TABLE_ROWS + 1 }, () => ({ a: 1 })),
    },
  }
  assert.equal(validateCanvasArtifact(tall).ok, false)

  // 11 cols × 2000 rows = 22,000 cells > 20,000 cap, though rows/cols individually pass
  const dense = {
    component: 'result-table',
    table: {
      columns: Array.from({ length: 11 }, (_, i) => ({ key: `c${i}` })),
      rows: Array.from({ length: 2000 }, () => ({ c0: 1 })),
    },
  }
  const r = validateCanvasArtifact(dense)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /total cells/)
})

test('rejects duplicate column keys and non-primitive cells', () => {
  const dup = {
    component: 'result-table',
    table: { columns: [{ key: 'a' }, { key: 'a' }], rows: [] },
  }
  assert.equal(validateCanvasArtifact(dup).ok, false)

  const nested = {
    component: 'result-table',
    table: { columns: [{ key: 'a' }], rows: [{ a: { nested: true } }] },
  }
  assert.equal(validateCanvasArtifact(nested).ok, false)
})

test('enforces markdown cap and non-empty', () => {
  assert.equal(validateCanvasArtifact({ component: 'markdown', markdown: '' }).ok, false)
  assert.equal(
    validateCanvasArtifact({ component: 'markdown', markdown: 'x'.repeat(MAX_MARKDOWN_CHARS + 1) }).ok,
    false,
  )
})

test('rejects relative paths and disallowed extensions', () => {
  assert.equal(
    validateCanvasArtifact({ component: 'image', image: { path: 'shot.png' } }).ok,
    false,
  )
  assert.equal(
    validateCanvasArtifact({ component: 'image', image: { path: '/tmp/shot.svg' } }).ok,
    false,
  )
  assert.equal(
    validateCanvasArtifact({ component: 'image', image: { path: '/tmp/shot.pdf' } }).ok,
    false,
  )
})

test('enforces per-kind annotation required fields', () => {
  const base = { component: 'annotated-image', image: { path: '/tmp/s.png' } }
  assert.equal(
    validateCanvasArtifact({ ...base, annotations: [{ kind: 'circle', cx: 1, cy: 1 }] }).ok,
    false, // missing r
  )
  assert.equal(
    validateCanvasArtifact({ ...base, annotations: [{ kind: 'box', x: 1, y: 1, w: 5 }] }).ok,
    false, // missing h
  )
  assert.equal(
    validateCanvasArtifact({ ...base, annotations: [{ kind: 'arrow', x1: 1, y1: 1, x2: 5 }] }).ok,
    false, // missing y2
  )
  assert.equal(
    validateCanvasArtifact({ ...base, annotations: [{ kind: 'label', x: 1, y: 1 }] }).ok,
    false, // missing text
  )
  assert.equal(
    validateCanvasArtifact({ ...base, annotations: [{ kind: 'star', x: 1, y: 1 }] }).ok,
    false, // unknown kind
  )
})

test('rejects bad colors and non-finite coordinates', () => {
  const base = { component: 'annotated-image', image: { path: '/tmp/s.png' } }
  assert.equal(
    validateCanvasArtifact({
      ...base,
      annotations: [{ kind: 'circle', cx: 1, cy: 1, r: 1, color: 'javascript:alert(1)' }],
    }).ok,
    false,
  )
  assert.equal(
    validateCanvasArtifact({
      ...base,
      annotations: [{ kind: 'circle', cx: Infinity, cy: 1, r: 1 }],
    }).ok,
    false,
  )
  assert.equal(
    validateCanvasArtifact({
      ...base,
      annotations: [{ kind: 'circle', cx: -5, cy: 1, r: 1 }],
    }).ok,
    false,
  )
})

test('enforces annotation count cap', () => {
  const r = validateCanvasArtifact({
    component: 'annotated-image',
    image: { path: '/tmp/s.png' },
    annotations: Array.from({ length: MAX_ANNOTATIONS + 1 }, () => ({
      kind: 'label',
      x: 1,
      y: 1,
      text: 'x',
    })),
  })
  assert.equal(r.ok, false)
})

test('enforces title cap', () => {
  const r = validateCanvasArtifact({
    component: 'markdown',
    markdown: 'hi',
    title: 'x'.repeat(121),
  })
  assert.equal(r.ok, false)
})
