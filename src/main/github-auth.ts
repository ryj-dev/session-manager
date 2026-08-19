import { app, safeStorage, shell } from 'electron'
import { join } from 'path'
import { readFileSync, mkdirSync, unlinkSync, existsSync } from 'fs'
import { execFile } from 'child_process'
import { atomicWriteSync } from './atomic-write'

// GitHub authentication for the PR panel / notifications poller.
//
// Token sources, in probe order:
//   1. 'stored'  — a token the user connected explicitly (device flow or paste),
//                  encrypted with safeStorage in userData/state/github-auth.json.
//                  Most durable: survives `gh auth logout`.
//   2. 'gh-cli'  — the GitHub CLI's token (`gh auth token`), re-probed live so
//                  the app rides the CLI's login with zero setup. Can rotate or
//                  vanish underneath us — the poller treats a 401 as auth-lost
//                  and re-probes rather than going silently stale.
//
// Device flow needs an OAuth app client id (public, not a secret). Empty here
// means the "Connect to GitHub" button falls back to token paste; set the env
// var or fill the constant after registering an OAuth app with device flow
// enabled (GitHub → Settings → Developer settings → OAuth Apps).
const GITHUB_OAUTH_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID ?? ''
// Full control of private repos INCLUDES notifications access; anything less
// can't read private-repo PR notifications.
const DEVICE_FLOW_SCOPE = 'repo'

export const GITHUB_API = 'https://api.github.com'

export type GithubTokenSource = 'stored' | 'gh-cli'

export interface GithubAuthStatus {
  connected: boolean
  /** Which source produced the active token. */
  source: GithubTokenSource | null
  login: string | null
  /** Raw x-oauth-scopes header (classic tokens); null for fine-grained PATs. */
  scopes: string | null
  /** Whether device flow is configured (client id present). */
  deviceFlowAvailable: boolean
  /** Human-readable problem, e.g. scope warnings or probe failures. */
  error: string | null
}

interface StoredAuth {
  /** base64 of safeStorage-encrypted token, or plaintext when encryption is
   *  unavailable (flagged so we can surface it). */
  token: string
  encrypted: boolean
}

// ── Stored token persistence ─────────────────────────────────────────────────

function authPath(): string {
  const dir = join(app.getPath('userData'), 'state')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'github-auth.json')
}

function readStoredToken(): string | null {
  try {
    const raw: StoredAuth = JSON.parse(readFileSync(authPath(), 'utf-8'))
    if (!raw.token) return null
    if (!raw.encrypted) return raw.token
    return safeStorage.decryptString(Buffer.from(raw.token, 'base64'))
  } catch {
    return null
  }
}

export function storeToken(token: string): void {
  const canEncrypt = safeStorage.isEncryptionAvailable()
  const data: StoredAuth = canEncrypt
    ? { token: safeStorage.encryptString(token).toString('base64'), encrypted: true }
    : { token, encrypted: false }
  atomicWriteSync(authPath(), JSON.stringify(data))
}

export function clearStoredToken(): void {
  try {
    if (existsSync(authPath())) unlinkSync(authPath())
  } catch { /* best-effort */ }
}

// ── gh CLI probe ─────────────────────────────────────────────────────────────

/** `gh auth token`, or null when gh is missing / logged out. Never throws. */
function probeGhCliToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 5_000 }, (err, stdout) => {
      if (err) return resolve(null)
      const token = stdout.trim()
      resolve(token.length > 0 ? token : null)
    })
  })
}

// ── Token validation ─────────────────────────────────────────────────────────

interface ValidatedToken {
  login: string
  scopes: string | null
}

/** GET /user with the token; null when the token is invalid/expired. */
async function validateToken(token: string): Promise<ValidatedToken | null> {
  try {
    const res = await fetch(`${GITHUB_API}/user`, { headers: apiHeaders(token) })
    if (!res.ok) return null
    const user = (await res.json()) as { login: string }
    return { login: user.login, scopes: res.headers.get('x-oauth-scopes') }
  } catch {
    return null
  }
}

/** Classic-token scope check: notifications access needs `repo` or
 *  `notifications`. Fine-grained PATs report no scopes header — assume OK and
 *  let the poller's 401/403 handling surface a real problem. */
function scopeWarning(scopes: string | null): string | null {
  if (scopes === null || scopes === '') return null
  const list = scopes.split(',').map((s) => s.trim())
  if (list.includes('repo') || list.includes('notifications')) return null
  return `Token is missing the "repo" (or "notifications") scope — PR notifications won't load. Current scopes: ${scopes}`
}

// ── Active-token resolution (the poller's entry point) ───────────────────────

// Cache the resolved token so the 60s poll doesn't shell out to `gh` each tick.
// invalidateAuth() (called on 401, disconnect, or a new connect) drops it.
let cached: { token: string; source: GithubTokenSource } | null = null
let lastStatus: GithubAuthStatus | null = null

export function invalidateAuth(): void {
  cached = null
  lastStatus = null
}

/** Resolve the active token: stored first, then gh CLI. Validates on first
 *  resolution (cached afterwards). Returns null when nothing works. */
export async function getActiveToken(): Promise<{ token: string; source: GithubTokenSource } | null> {
  if (cached) return cached
  const stored = readStoredToken()
  if (stored && (await validateToken(stored))) {
    cached = { token: stored, source: 'stored' }
    return cached
  }
  const cli = await probeGhCliToken()
  if (cli && (await validateToken(cli))) {
    cached = { token: cli, source: 'gh-cli' }
    return cached
  }
  return null
}

/** Full status for the panel/settings UI. Re-validates (bypasses cache) so the
 *  UI always shows the truth; also refreshes the token cache as a side effect. */
export async function getAuthStatus(): Promise<GithubAuthStatus> {
  const base = {
    deviceFlowAvailable: GITHUB_OAUTH_CLIENT_ID.length > 0,
  }
  const stored = readStoredToken()
  if (stored) {
    const valid = await validateToken(stored)
    if (valid) {
      cached = { token: stored, source: 'stored' }
      lastStatus = { connected: true, source: 'stored', login: valid.login, scopes: valid.scopes, error: scopeWarning(valid.scopes), ...base }
      return lastStatus
    }
  }
  const cli = await probeGhCliToken()
  if (cli) {
    const valid = await validateToken(cli)
    if (valid) {
      cached = { token: cli, source: 'gh-cli' }
      lastStatus = { connected: true, source: 'gh-cli', login: valid.login, scopes: valid.scopes, error: scopeWarning(valid.scopes), ...base }
      return lastStatus
    }
  }
  cached = null
  lastStatus = {
    connected: false,
    source: null,
    login: null,
    scopes: null,
    error: stored ? 'Stored token is no longer valid — reconnect.' : null,
    ...base,
  }
  return lastStatus
}

export function getLastKnownStatus(): GithubAuthStatus | null {
  return lastStatus
}

/** Explicit connect with a pasted token (PAT). Validates before storing. */
export async function connectWithToken(token: string): Promise<GithubAuthStatus> {
  const trimmed = token.trim()
  const valid = await validateToken(trimmed)
  if (!valid) throw new Error('Token was rejected by GitHub — check it and try again.')
  storeToken(trimmed)
  invalidateAuth()
  return getAuthStatus()
}

/** Forget the stored token. The gh CLI fallback (if logged in) takes over on
 *  the next status probe — full disconnect requires `gh auth logout` too. */
export async function disconnect(): Promise<GithubAuthStatus> {
  clearStoredToken()
  invalidateAuth()
  return getAuthStatus()
}

// ── OAuth device flow ────────────────────────────────────────────────────────

export interface DeviceFlowStart {
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

interface PendingDeviceFlow {
  deviceCode: string
  interval: number
  expiresAt: number
}

let pendingFlow: PendingDeviceFlow | null = null

/** Kick off the device flow: returns the code for the UI to display and opens
 *  the verification page in the default browser. */
export async function startDeviceFlow(): Promise<DeviceFlowStart> {
  if (!GITHUB_OAUTH_CLIENT_ID) throw new Error('Device flow is not configured (no OAuth client id). Paste a token instead.')
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: GITHUB_OAUTH_CLIENT_ID, scope: DEVICE_FLOW_SCOPE }),
  })
  if (!res.ok) throw new Error(`GitHub device-code request failed (${res.status})`)
  const data = (await res.json()) as {
    device_code: string
    user_code: string
    verification_uri: string
    expires_in: number
    interval: number
  }
  pendingFlow = {
    deviceCode: data.device_code,
    interval: Math.max(5, data.interval || 5),
    expiresAt: Date.now() + data.expires_in * 1000,
  }
  shell.openExternal(data.verification_uri).catch(() => { /* user can type the URL */ })
  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: pendingFlow.interval,
  }
}

/** Poll until the user approves (or the flow expires). Resolves with the new
 *  auth status; the token is stored on success. */
export async function waitForDeviceFlow(): Promise<GithubAuthStatus> {
  const flow = pendingFlow
  if (!flow) throw new Error('No device flow in progress.')
  while (Date.now() < flow.expiresAt) {
    // A newer flow superseded this one — abandon quietly.
    if (pendingFlow !== flow) throw new Error('Device flow was restarted.')
    await new Promise((r) => setTimeout(r, flow.interval * 1000))
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_OAUTH_CLIENT_ID,
        device_code: flow.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    const data = (await res.json()) as { access_token?: string; error?: string; interval?: number }
    if (data.access_token) {
      pendingFlow = null
      storeToken(data.access_token)
      invalidateAuth()
      return getAuthStatus()
    }
    if (data.error === 'authorization_pending') continue
    if (data.error === 'slow_down') {
      flow.interval += 5
      continue
    }
    pendingFlow = null
    throw new Error(`Device flow failed: ${data.error ?? 'unknown error'}`)
  }
  pendingFlow = null
  throw new Error('Device flow expired — try connecting again.')
}

// ── Shared request headers ───────────────────────────────────────────────────

export function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'session-manager',
  }
}
