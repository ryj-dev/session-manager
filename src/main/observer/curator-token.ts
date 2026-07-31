/**
 * The per-run curator token — layer 2 of the curator boundary.
 *
 * Layer 1 (observer/role-gate.ts) removes `observer-suggest` from every
 * non-curator session's MCP tool list. That is not sufficient on its own:
 * `/observer/suggest` is plain localhost HTTP, and the X-Hook-Secret guarding
 * it is shared by every session the app launches, so any session could skip
 * its own MCP server and curl the endpoint directly to inject suggestions into
 * the user's inbox.
 *
 * So each curator run mints a fresh random token, hands it to its PTY through
 * the env (SM_CURATOR_TOKEN), and the endpoint accepts nothing else. The token
 * is burned when the run ends, which makes a leaked one useless: there is
 * exactly one valid token, only while exactly one run is in flight.
 *
 * A leaf module (crypto only) so the token lifecycle can be unit-tested
 * without pulling in pty-manager → electron.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

/** The live run's token, or null when no run is in flight. */
let activeToken: string | null = null

/** 256 bits of randomness — this is a bearer token, not an identifier. */
export function mintCuratorToken(): string {
  return randomBytes(32).toString('hex')
}

/** Arm a minted token. Called once the run's PTY actually exists, so a failed
 *  spawn cannot leave a valid token behind with no session attached to it. */
export function armCuratorToken(token: string): void {
  activeToken = token
}

/** Invalidate the live token. Idempotent. */
export function clearCuratorToken(): void {
  activeToken = null
}

/**
 * Constant-time check of a presented token against the live run's.
 *
 * False when no run is in flight — a token from a finished run is a stale
 * token, not a valid one, which is the whole point of minting per run.
 */
export function isValidCuratorToken(presented: unknown): boolean {
  if (!activeToken || typeof presented !== 'string' || presented.length === 0) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(activeToken)
  if (a.length !== b.length) return false   // timingSafeEqual throws on length mismatch
  try { return timingSafeEqual(a, b) } catch { return false }
}

/** The header name the curator's MCP server sends the run token under. */
export const CURATOR_TOKEN_HEADER = 'x-curator-token'

/**
 * The authorization decision /observer/suggest makes, as a pure function of the
 * request headers — so the endpoint's actual gate can be tested without an
 * Electron-bound HTTP server. Node lowercases header names and may hand back an
 * array when a header is repeated; a repeated token header is not a
 * well-formed request, so it is rejected rather than resolved.
 */
export function authorizeSuggestRequest(
  headers: Record<string, string | string[] | undefined>,
): { ok: true } | { ok: false; error: string } {
  if (!isValidCuratorToken(headers[CURATOR_TOKEN_HEADER])) {
    return { ok: false, error: 'forbidden: observer-suggest is restricted to the in-flight curator run' }
  }
  return { ok: true }
}
