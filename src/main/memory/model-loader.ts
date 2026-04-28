/**
 * Resolve the local path of the bge-small-en-v1.5 model, downloading it
 * lazily into userData on first launch if no bundled copy is present.
 *
 * Resolution order:
 *   1. Bundled at build time:  <resources>/models/bge-small-en-v1.5/
 *   2. Previously cached:      <userData>/models/bge-small-en-v1.5/
 *   3. Fresh download into #2.
 *
 * Idempotent — files already on disk are skipped.
 */

import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { stat, mkdir } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MODEL_DIR_NAME = 'bge-small-en-v1.5'
const REPO = 'Xenova/bge-small-en-v1.5'
const REVISION = 'main'

// Files needed by transformers.js to load a feature-extraction pipeline.
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx'
] as const

export interface ModelDownloadProgress {
  file: string
  index: number
  total: number
  bytes: number
}

function bundledPath(): string {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'models')
    : path.join(app.getAppPath(), 'resources', 'models')
  return path.join(root, MODEL_DIR_NAME)
}

function cachedPath(): string {
  return path.join(app.getPath('userData'), 'models', MODEL_DIR_NAME)
}

function isComplete(dir: string): boolean {
  if (!fs.existsSync(dir)) return false
  for (const f of FILES) {
    const p = path.join(dir, f)
    if (!fs.existsSync(p)) return false
    if (fs.statSync(p).size === 0) return false
  }
  return true
}

async function downloadOne(file: string, dest: string): Promise<number> {
  await mkdir(path.dirname(dest), { recursive: true })
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${file}`
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`)
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest))
  const s = await stat(dest)
  return s.size
}

function notify(p: ModelDownloadProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('memory:model-download', p)
    }
  }
}

/**
 * Returns a usable model directory, downloading missing files if needed.
 * Throws if the download fails — the caller should handle by disabling
 * semantic search and falling back to keyword-only.
 */
export async function ensureModelAvailable(): Promise<string> {
  const bundled = bundledPath()
  if (isComplete(bundled)) return bundled

  const cached = cachedPath()
  if (isComplete(cached)) return cached

  // Download missing files into the userData cache.
  await mkdir(cached, { recursive: true })
  for (let i = 0; i < FILES.length; i++) {
    const file = FILES[i]
    const dest = path.join(cached, file)
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      notify({ file, index: i + 1, total: FILES.length, bytes: fs.statSync(dest).size })
      continue
    }
    const bytes = await downloadOne(file, dest)
    notify({ file, index: i + 1, total: FILES.length, bytes })
  }

  if (!isComplete(cached)) {
    throw new Error('Model download finished but cache is incomplete')
  }
  return cached
}
