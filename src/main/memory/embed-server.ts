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

export interface EmbedServerHandle {
  socketPath: string
  close: () => void
}

interface Request {
  id: string
  op: 'ping' | 'search'
  query?: string
  limit?: number
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
