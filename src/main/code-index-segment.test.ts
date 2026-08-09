// Unit tests for the tree-sitter segmenter, using the committed grammar WASMs.
// Run with: npm test

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configureSegmenter, segmentFile, windowChunks } from './code-index/segment.ts'

before(() => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  configureSegmenter(join(root, 'resources', 'tree-sitter'))
})

const TS_FIXTURE = `import fs from 'node:fs'

export const MAX = 42

export function topLevel(a: string): number {
  return a.length
}

export const arrowFn = (x: number): number => x * 2

export interface Config {
  name: string
}

export type Alias = Config | null

export class Widget {
  private size = 1

  render(depth: number): string {
    return 'x'.repeat(depth)
  }

  static create(): Widget {
    return new Widget()
  }
}
`

test('TS: symbols extracted with kinds, parents, line spans', async () => {
  const { symbols } = await segmentFile('repo', 'src/widget.ts', 'typescript', TS_FIXTURE)
  const byName = new Map(symbols.map((s) => [s.name, s]))

  assert.equal(byName.get('topLevel')?.kind, 'function')
  assert.equal(byName.get('arrowFn')?.kind, 'function')
  assert.equal(byName.get('Config')?.kind, 'interface')
  assert.equal(byName.get('Alias')?.kind, 'type')
  assert.equal(byName.get('Widget')?.kind, 'class')
  assert.equal(byName.get('render')?.kind, 'method')
  assert.equal(byName.get('render')?.parentName, 'Widget')
  assert.equal(byName.get('create')?.parentName, 'Widget')
  assert.equal(byName.get('Widget')?.parentName, null)
  // MAX is a plain const (not a function) — not a symbol
  assert.equal(byName.has('MAX'), false)

  const topLevelSym = byName.get('topLevel')
  assert.ok(topLevelSym && topLevelSym.startLine === 5 && topLevelSym.endLine === 7)
  // def node lives inside export_statement, so the signature starts at `function`
  assert.match(topLevelSym.signature, /^function topLevel\(a: string\)/)
})

test('TS: chunks carry synthesised headers and cover gaps', async () => {
  const { chunks } = await segmentFile('repo', 'src/widget.ts', 'typescript', TS_FIXTURE)
  const widgetChunk = chunks.find((c) => c.header.endsWith('· Widget'))
  assert.ok(widgetChunk, 'class chunk exists')
  assert.ok(widgetChunk.text.startsWith('repo · src/widget.ts · Widget\n'))
  assert.ok(widgetChunk.text.includes('render(depth: number)'))
  // imports + plain consts land in gap chunks with the base header
  const gap = chunks.find((c) => c.text.includes("import fs from 'node:fs'"))
  assert.ok(gap, 'gap chunk covers imports')
  assert.equal(gap.symbolIdx, null)
  assert.equal(gap.header, 'repo · src/widget.ts')
})

test('Python: functions, classes, methods, decorated defs', async () => {
  const py = `import os

@lru_cache
def cached(n):
    return n * 2

class Store:
    def get(self, key):
        return self.data[key]

def main():
    pass
`
  const { symbols } = await segmentFile('repo', 'store.py', 'python', py)
  const byName = new Map(symbols.map((s) => [s.name, s]))
  assert.equal(byName.get('cached')?.kind, 'function')
  assert.equal(byName.get('Store')?.kind, 'class')
  assert.equal(byName.get('get')?.parentName, 'Store')
  assert.equal(byName.get('main')?.parentName, null)
})

test('unknown lang falls back to windowed whole-file chunks', async () => {
  const { symbols, chunks } = await segmentFile('repo', 'notes.md', 'text', '# Title\n\nsome text\n')
  assert.equal(symbols.length, 0)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].header, 'repo · notes.md')
  assert.ok(chunks[0].text.includes('some text'))
})

test('long bodies split into multiple windows, all headed', async () => {
  const lines = Array.from({ length: 200 }, (_, i) => `  console.log(${i}) // padding padding`)
  const src = `export function big(): void {\n${lines.join('\n')}\n}\n`
  const { chunks } = await segmentFile('repo', 'big.ts', 'typescript', src)
  const bigChunks = chunks.filter((c) => c.header.endsWith('· big'))
  assert.ok(bigChunks.length > 1, 'body split into multiple windows')
  for (const c of bigChunks) {
    assert.ok(c.text.startsWith('repo · big.ts · big\n'))
    assert.ok(c.text.length <= 1600 + 'repo · big.ts · big\n'.length + 80)
  }
  // line spans are contiguous-ish and within the file
  assert.equal(bigChunks[0].startLine, 1)
  assert.ok(bigChunks[bigChunks.length - 1].endLine >= 200)
})

test('windowChunks respects line boundaries and start lines', () => {
  const chunks = windowChunks('h', 'a\nb\nc', 10)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].startLine, 10)
  assert.equal(chunks[0].endLine, 12)
  assert.equal(chunks[0].text, 'h\na\nb\nc')
})

test('TSX parses via the tsx grammar', async () => {
  const tsx = `export function App(): JSX.Element {
  return <div className="x">hi</div>
}
`
  const { symbols } = await segmentFile('repo', 'App.tsx', 'tsx', tsx)
  assert.equal(symbols[0]?.name, 'App')
  assert.equal(symbols[0]?.kind, 'function')
})
