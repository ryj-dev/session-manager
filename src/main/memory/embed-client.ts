/**
 * Client for the main process's embed-server.
 *
 * Used by the MCP server (a child process) to run semantic searches without
 * loading its own copy of the bge-small model. Falls back gracefully when
 * the socket is unreachable — caller should treat "no hits" as a signal to
 * use keyword-only results.
 *
 * Protocol: newline-delimited JSON, one outstanding request at a time per
 * connection. We open a fresh connection per request — these are local
 * sockets, the cost is negligible and it sidesteps all reconnection edge
 * cases.
 */

import net from 'node:net'

export interface SemanticHit {
  filename: string
  chunkIdx: number
  text: string
  distance: number
}

const REQUEST_TIMEOUT_MS = 5000
const PING_TIMEOUT_MS = 500

let socketPath: string | null = null
let availabilityCache: { value: boolean; checkedAt: number } | null = null
const AVAILABILITY_TTL_MS = 30_000

export function configureEmbedClient(path: string | null): void {
  socketPath = path
  availabilityCache = null
}

/**
 * Quick check: is the embed-server reachable and reporting as available?
 * Cached for AVAILABILITY_TTL_MS to avoid pinging on every search.
 */
export async function isAvailable(): Promise<boolean> {
  if (!socketPath) return false
  const now = Date.now()
  if (availabilityCache && now - availabilityCache.checkedAt < AVAILABILITY_TTL_MS) {
    return availabilityCache.value
  }
  try {
    const res = (await request({ op: 'ping' }, PING_TIMEOUT_MS)) as {
      ok: boolean
      available?: boolean
    }
    const value = res.ok && res.available === true
    availabilityCache = { value, checkedAt: now }
    return value
  } catch {
    availabilityCache = { value: false, checkedAt: now }
    return false
  }
}

export async function searchSemantic(
  query: string,
  limit = 50
): Promise<SemanticHit[]> {
  if (!socketPath) return []
  if (!query.trim()) return []
  try {
    const res = (await request({ op: 'search', query, limit })) as {
      ok: boolean
      hits?: SemanticHit[]
    }
    return res.ok && res.hits ? res.hits : []
  } catch {
    return []
  }
}

export interface KeywordHit {
  filename: string
  score: number
}

/**
 * Keyword-overlap search against the main process's IndexedNote map.
 * Returns ranked filename+score pairs. Empty on unreachable socket — caller
 * should treat that as "no hits" and either fall back or skip.
 */
export async function searchKeyword(
  tokensOrQuery: string[] | string,
  opts: { limit?: number; bodyChars?: number } = {}
): Promise<KeywordHit[]> {
  if (!socketPath) return []
  const payload: Record<string, unknown> = {
    op: 'searchKeyword',
    limit: opts.limit ?? 50,
    bodyChars: opts.bodyChars ?? 500,
  }
  if (Array.isArray(tokensOrQuery)) payload.tokens = tokensOrQuery
  else payload.query = tokensOrQuery
  try {
    const res = (await request(payload)) as { ok: boolean; hits?: KeywordHit[] }
    return res.ok && res.hits ? res.hits : []
  } catch {
    return []
  }
}

export interface IndexedNoteMeta {
  filename: string
  title: string
  type: string
  tags: string[]
  wikilinks: string[]
}

/**
 * Pull the full metadata-only index from the main process. Used for orphan
 * audits, graph analysis, and cross-note curation tasks. No body text.
 */
export async function listIndexed(): Promise<IndexedNoteMeta[]> {
  if (!socketPath) return []
  try {
    const res = (await request({ op: 'listIndexed' })) as {
      ok: boolean
      notes?: IndexedNoteMeta[]
    }
    return res.ok && res.notes ? res.notes : []
  } catch {
    return []
  }
}

// ─── Internals ──────────────────────────────────────────────────────────────

let nextId = 1

function request(
  payload: Record<string, unknown>,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<unknown> {
  if (!socketPath) return Promise.reject(new Error('embed client not configured'))
  const id = String(nextId++)
  const line = JSON.stringify({ id, ...payload }) + '\n'

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath! })
    let buffer = ''
    let settled = false

    const finish = (err: Error | null, result?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.end()
      } catch {
        /* ignore */
      }
      if (err) reject(err)
      else resolve(result)
    }

    const timer = setTimeout(() => finish(new Error('embed request timeout')), timeoutMs)

    socket.on('connect', () => {
      socket.write(line)
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const nl = buffer.indexOf('\n')
      if (nl === -1) return
      const responseLine = buffer.slice(0, nl)
      try {
        const obj = JSON.parse(responseLine)
        if (obj.id !== id) {
          finish(new Error('embed response id mismatch'))
          return
        }
        finish(null, obj)
      } catch (e) {
        finish(e instanceof Error ? e : new Error('parse failed'))
      }
    })
    socket.on('error', (err) => finish(err))
    socket.on('close', () => {
      if (!settled) finish(new Error('embed socket closed before response'))
    })
  })
}
