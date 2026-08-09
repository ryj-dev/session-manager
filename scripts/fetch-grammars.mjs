// Fetches tree-sitter grammar WASMs into resources/tree-sitter/ from the
// official grammar npm packages (which ship prebuilt .wasm since ~0.23).
// Run manually when adding a language or bumping web-tree-sitter; the WASMs
// are committed, not fetched at build time.
//
//   node scripts/fetch-grammars.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// package → wasm files inside its tarball root
const SOURCES = [
  { pkg: 'tree-sitter-typescript@0.23.2', files: ['tree-sitter-typescript.wasm', 'tree-sitter-tsx.wasm'] },
  { pkg: 'tree-sitter-javascript@0.25.0', files: ['tree-sitter-javascript.wasm'] },
  { pkg: 'tree-sitter-python@0.25.0', files: ['tree-sitter-python.wasm'] }
]

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources', 'tree-sitter')
mkdirSync(outDir, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'ts-wasms-'))
try {
  for (const { pkg, files } of SOURCES) {
    const tarball = execFileSync('npm', ['pack', pkg, '--pack-destination', work], {
      encoding: 'utf8'
    })
      .trim()
      .split('\n')
      .pop()
    execFileSync('tar', ['-xzf', join(work, tarball), '-C', work])
    for (const file of files) {
      copyFileSync(join(work, 'package', file), join(outDir, file))
      console.log(`fetched ${file} from ${pkg}`)
    }
    rmSync(join(work, 'package'), { recursive: true, force: true })
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
console.log(`done → ${outDir}`)
