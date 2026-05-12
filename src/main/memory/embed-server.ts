/**
 * Local embedder IPC server.
 *
 * Runs in the main Electron process. MCP server children connect over a
 * Unix domain socket (or Windows named pipe) and ask this server to run
 * semantic searches. Centralizing here means the bge-small model is only
 * loaded into one process regardless of how many Claude sessions are open.
 *
 * Protocol: newline-delimited JSON. Every request has an `id` echoed back
 * on the response.
 *
 *   → {"id":"1","op":"ping"}
 *   ← {"id":"1","ok":true}
 *
 *   → {"id":"2","op":"search","query":"...","limit":50}
 *   ← {"id":"2","ok":true,"hits":[{filename,chunkIdx,text,distance}, ...]}
 */

import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { searchSemantic, isEmbeddingsAvailable } from './embeddings'
import { getIndex } from './index'

export interface EmbedServerHandle {
  socketPath: string
  close: () => void
}

interface Request {
  id: string
  op: 'ping' | 'search' | 'searchKeyword' | 'listIndexed'
  query?: string
  tokens?: string[]
  limit?: number
  bodyChars?: number
}

const KEYWORD_STOPWORDS = new Set([
  'the','a','an','and','or','but','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','should','could','may',
  'might','must','can','this','that','these','those','i','you','he','she','it',
  'we','they','them','their','what','which','who','when','where','why','how',
  'all','each','every','both','few','more','most','other','some','such','no',
  'nor','not','only','own','same','so','than','too','very','just','with','from',
  'into','onto','about','between','through','during','before','after','above',
  'below','to','of','in','on','at','by','for','as','if','then','else','because',
  'while','note','notes','see','also','use','used','using','one','two','three'
])

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter(
    (t) => !KEYWORD_STOPWORDS.has(t)
  )
}

let active: EmbedServerHandle | null = null

function defaultSocketPath(): string {
  if (process.platform === 'win32') {
    // Named pipe — unique per app install, derived from userData path.
    const tag = Buffer.from(app.getPath('userData')).toString('hex').slice(0, 16)
    return `\\\\.\\pipe\\session-manager-embed-${tag}`
  }
  // Unix domain socket. Place it inside userData so the path is deterministic
  // and not subject to sandbox-leaked TMPDIRs from other processes. userData
  // on macOS/Linux stays comfortably under the 104-byte sun_path limit.
  return path.join(app.getPath('userData'), 'embed.sock')
}

async function isSocketLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection({ path: socketPath })
    let settled = false
    const finish = (live: boolean) => {
      if (settled) return
      settled = true
      try { probe.destroy() } catch { /* ignore */ }
      resolve(live)
    }
    probe.once('connect', () => finish(true))
    probe.once('error', () => finish(false))
    setTimeout(() => finish(false), 250)
  })
}

export async function startEmbedServer(): Promise<EmbedServerHandle> {
  if (active) return active
  const socketPath = defaultSocketPath()

  // Unix: a leftover socket file from a crashed run blocks listen() with
  // EADDRINUSE. Probe for liveness before deleting so we don't trample a
  // genuinely running second instance.
  if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
    const live = await isSocketLive(socketPath)
    if (live) {
      throw new Error(
        `embed-server already running at ${socketPath}; refusing to start a second instance`
      )
    }
    try { fs.unlinkSync(socketPath) } catch { /* best-effort */ }
  }

  const server = net.createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (!line.trim()) continue
        void handleLine(socket, line)
      }
    })
    socket.on('error', () => {
      /* client disconnected — fine */
    })
  })

  server.listen(socketPath, () => {
    console.log('[embed-server] listening on', socketPath)
  })
  server.on('error', (err) => {
    console.error('[embed-server] listen error:', err)
  })

  active = {
    socketPath,
    close: () => {
      server.close()
      if (process.platform !== 'win32') {
        try {
          fs.unlinkSync(socketPath)
        } catch {
          /* best-effort */
        }
      }
      active = null
    }
  }
  return active
}

export function getEmbedSocketPath(): string | null {
  return active?.socketPath ?? null
}

export function stopEmbedServer(): void {
  active?.close()
}

async function handleLine(socket: net.Socket, line: string): Promise<void> {
  let req: Request
  try {
    req = JSON.parse(line) as Request
  } catch {
    return // malformed; ignore
  }
  const { id, op } = req
  try {
    if (op === 'ping') {
      respond(socket, { id, ok: true, available: isEmbeddingsAvailable() })
      return
    }
    if (op === 'search') {
      if (!req.query) {
        respond(socket, { id, ok: true, hits: [] })
        return
      }
      const hits = await searchSemantic(req.query, req.limit ?? 50)
      respond(socket, { id, ok: true, hits })
      return
    }
    if (op === 'searchKeyword') {
      // Token-overlap scoring against the in-memory IndexedNote map. Scans
      // title + filename + a leading body slice; counts unique query tokens
      // present. Returns ranked filename+score pairs.
      const tokens = (req.tokens ?? (req.query ? tokenize(req.query) : []))
      if (tokens.length === 0) {
        respond(socket, { id, ok: true, hits: [] })
        return
      }
      const bodyChars = req.bodyChars ?? 500
      const limit = req.limit ?? 50
      const querySet = new Set(tokens)
      const idx = getIndex()
      const scored: { filename: string; score: number }[] = []
      for (const note of idx.values()) {
        const haystack = `${note.title}\n${note.filename}\n${note.text.slice(0, bodyChars)}`
        const targetSet = new Set(tokenize(haystack))
        let overlap = 0
        for (const t of querySet) if (targetSet.has(t)) overlap++
        if (overlap > 0) scored.push({ filename: note.filename, score: overlap })
      }
      scored.sort((a, b) => b.score - a.score)
      respond(socket, { id, ok: true, hits: scored.slice(0, limit) })
      return
    }
    if (op === 'listIndexed') {
      // Metadata-only dump of every indexed note — for orphan audits,
      // graph analysis, curation. No body text shipped over the wire.
      const idx = getIndex()
      const notes = [...idx.values()].map((n) => ({
        filename: n.filename,
        title: n.title,
        type: n.type,
        tags: n.tags,
        wikilinks: n.wikilinks,
      }))
      respond(socket, { id, ok: true, notes })
      return
    }
    respond(socket, { id, ok: false, error: `unknown op: ${op}` })
  } catch (err) {
    respond(socket, {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

function respond(socket: net.Socket, payload: unknown): void {
  try {
    socket.write(JSON.stringify(payload) + '\n')
  } catch {
    /* socket closed — fine */
  }
}
