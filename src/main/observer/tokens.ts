/**
 * Pure token normalisation for the observer — no imports, no I/O, no state.
 *
 * Split out from mining.ts and capture.ts so the collapse rules (which decide
 * whether two runs of "the same thing" are recognised as one habit) and the
 * secret redactor (which decides what is safe to persist) can be unit-tested
 * without loading SQLite. Both are load-bearing: too eager a collapse merges
 * unrelated work, too literal a one means nothing ever recurs, and a leaky
 * redactor would put credentials in a log file.
 */

/** An event as stored by the observer, narrowed to what tokenisation needs.
 *  Structurally compatible with ObserverEvent in ./db. */
export interface TokenisableEvent {
  id: number
  ts: number
  sessionId: string | null
  project: string | null
  kind: 'tool' | 'prompt' | 'session' | 'ui' | 'mcp'
  payload: Record<string, unknown>
}

/** Time-of-day buckets (hours). 3-hour windows: fine enough to distinguish a
 *  morning routine from an evening one, coarse enough to actually cluster. */
export const TOD_BUCKET_HOURS = 3

// ── Action normalisation ────────────────────────────────────────────────────

/**
 * Reduce an event to a stable, low-cardinality action token.
 *
 * The token is what recurrence is measured over, so it must generalise: a
 * shell command keeps its meaningful prefix (`npm run build`) but drops
 * arguments that vary per invocation (paths, ids, flags with values), and a
 * file edit generalises to the file's extension rather than the exact path —
 * "I keep editing .ts files" is a pattern, "I edited src/main/foo.ts once" is
 * not. Returns null for events with nothing generalisable.
 */
export function actionToken(e: TokenisableEvent): string | null {
  switch (e.kind) {
    case 'tool': {
      const tool = String(e.payload.tool ?? '')
      if (!tool) return null
      const arg = typeof e.payload.arg === 'string' ? e.payload.arg : null
      if (tool === 'Bash' && arg) return `bash:${commandShape(arg)}`
      if (arg && /^[/~]/.test(arg)) {
        const ext = arg.includes('.') ? arg.slice(arg.lastIndexOf('.')) : ''
        return ext && ext.length <= 6 ? `${tool.toLowerCase()}:*${ext}` : tool.toLowerCase()
      }
      return tool.toLowerCase()
    }
    case 'ui':
      return `ui:${String(e.payload.action ?? 'unknown')}`
    case 'mcp': {
      // Server-qualified: two servers can expose the same tool name (obsidian
      // and tc-sql-atlas both have a search), and collapsing them would merge
      // unrelated work into one "habit".
      const tool = String(e.payload.tool ?? 'unknown')
      const server = typeof e.payload.server === 'string' ? e.payload.server : null
      return server ? `mcp:${server}:${tool}` : `mcp:${tool}`
    }
    case 'session': {
      let token = `session:${String(e.payload.action ?? '')}:${String(e.payload.sessionKind ?? '')}`
      // Which agent, when it was one. Every agent spawn otherwise collapses to
      // a single `session:spawn:agent` token, so "you keep reaching for the
      // code-reviewer" is indistinguishable from "you spawn agents".
      const agent = typeof e.payload.agentName === 'string' ? slugToken(e.payload.agentName) : ''
      if (agent) token += `:${agent}`
      // A session an agent spawned is a different act from one the user
      // started by hand, even though both are tagged 'user'. Without this the
      // two collapse into one token and delegation is unminable.
      return e.payload.parentSessionId ? `${token}:delegated` : token
    }
    case 'prompt':
      // A prompt is a turn boundary, not an action worth mining on its own —
      // but it IS useful punctuation inside sequences.
      return 'prompt'
  }
}

/**
 * The recurring *shape* of a shell command: the program plus the leading
 * non-value arguments, with anything that looks like a path, number, hash or
 * flag-value dropped. `npm run build --silent` and `npm run build` collapse to
 * the same shape; `git commit -m "..."` collapses regardless of the message.
 */
export function commandShape(command: string): string {
  // Only the first command in a pipeline/chain — the rest are usually plumbing.
  const first = command.split(/\s*(?:&&|\|\||\||;)\s*/)[0] ?? command
  const parts = first.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  const out: string[] = []
  for (const raw of parts.slice(0, 4)) {
    const p = raw.replace(/^['"]|['"]$/g, '')
    if (out.length > 0) {
      if (p.startsWith('-')) break            // flags start the variable tail
      if (/[/\\.]/.test(p)) break             // a path or filename
      if (/^\d|^[0-9a-f]{7,}$/i.test(p)) break // numbers / hashes
      if (p.length > 24) break                // an inline value
    }
    out.push(p)
  }
  return out.join(' ')
}

/** Hard cap on a stored command string. */
const MAX_ARG_CHARS = 400

/**
 * Redact obvious secrets from a command before it is persisted. This is a
 * best-effort net, not a guarantee — but a command log that quietly captures
 * `export AWS_SECRET_ACCESS_KEY=...` would be a genuine hazard, and the shapes
 * below cover the overwhelming majority of how secrets appear on a shell line.
 */
export function redactSecrets(command: string): string {
  return command
    // URL credentials: scheme://user:pass@host. The username is real signal
    // (which account, which registry) and the host must survive for the
    // command to stay recognisable, so only the password is destroyed.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@'"]+):([^\s/@'"]+)@/gi, '$1$2:<redacted>@')

    // KEY=value / KEY="value" where the key name smells secret.
    // The prefix is zero-or-more underscore-terminated words, so a bare
    // API_KEY= matches as readily as AWS_SECRET_ACCESS_KEY=. Getting this
    // wrong is not cosmetic — it is the difference between a usage log and a
    // credential file.
    //
    // The value alternation must handle QUOTED values before bare ones: a
    // passphrase is exactly the kind of secret that contains spaces, and a
    // bare-token-only pattern stops at the first space and stores the rest.
    .replace(
      /\b((?:[A-Za-z0-9]+_)*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)S?)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1=<redacted>',
    )

    // --token=… / --password "a b c" / -p foo. Same quoted-value rule.
    .replace(
      /(--?(?:token|password|passwd|secret|api[-_]?key|auth)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1<redacted>',
    )

    // curl -u user:pass / --user user:pass. Gated on the colon so an unrelated
    // `-u` flag (sort -u, docker -u) is not swallowed; username kept, as above.
    .replace(
      // A lookbehind, not \b: the boundary between a space and a '-' is not a
      // word boundary, so \b-u never matches a flag at all.
      /((?<![\w-])(?:-u|--user)(?:=|\s+)['"]?)([^\s:'"]+):[^\s'"]*/gi,
      '$1$2:<redacted>',
    )

    // Authorization / X-…-Token headers. The auth SCHEME is not the secret —
    // matching a single \S+ here consumed the word "Bearer" and stored the
    // token that followed it, which is the exact opposite of the intent. Keep
    // the scheme, redact the credential.
    .replace(
      /((?:Proxy-)?Authorization|X-[A-Za-z-]*(?:Token|Key|Secret))(\s*:\s*)(?:(Bearer|Basic|Token|Digest|Negotiate)\s+)?[^\s'"]+/gi,
      (_m, header: string, sep: string, scheme?: string) =>
        `${header}${sep}${scheme ? `${scheme} ` : ''}<redacted>`,
    )

    // Long opaque blobs that look like keys (sk-…, ghp_…, AKIA…, JWTs)
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '<redacted>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<redacted>')
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, '<redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<redacted>')
}

/** Structural argument for a tool use, or null when the tool has none worth
 *  keeping. Shell commands are the high-signal case; file-touching tools keep
 *  their path; everything else is recorded by tool name alone. */
export function normalizeToolArg(tool: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>

  if (tool === 'Bash' || tool === 'BashOutput') {
    const cmd = typeof obj.command === 'string' ? obj.command : null
    if (!cmd) return null
    // Collapse newlines/indentation so a heredoc doesn't dominate the log and
    // so two spellings of the same command share a signature.
    const flat = cmd.replace(/\s+/g, ' ').trim()
    return redactSecrets(flat).slice(0, MAX_ARG_CHARS)
  }

  for (const key of ['file_path', 'path', 'notebook_path']) {
    const v = obj[key]
    if (typeof v === 'string') return v.slice(0, MAX_ARG_CHARS)
  }

  // Search tools: the pattern is structural, not content — worth keeping.
  if (typeof obj.pattern === 'string') return obj.pattern.slice(0, 120)

  return null
}

/** Reduce a free-form name to a token-safe fragment. `:` is the token
 *  separator, so an unsanitised name could forge extra segments. */
export function slugToken(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
}

// ── Delegation signatures ───────────────────────────────────────────────────

/**
 * Buckets for a delegation's shape.
 *
 * Raw counts are useless as a recurrence key — nobody exchanges exactly seven
 * messages twice — so each delegation would be its own unique pattern and
 * nothing would ever cross the promotion threshold. Same reasoning as the
 * 3-hour time-of-day windows: coarse enough to actually cluster.
 */
export function fanoutBucket(children: number): string {
  return children >= 5 ? '5+' : String(children)
}

export function roundsBucket(messages: number): string {
  if (messages <= 0) return '0'
  if (messages === 1) return '1'
  if (messages <= 3) return '2-3'
  if (messages <= 9) return '4-9'
  return '10+'
}

export function delegationSignature(children: number, messages: number): string {
  return `delegation:fanout=${fanoutBucket(children)}:rounds=${roundsBucket(messages)}`
}

/**
 * The parent of a delegated spawn, or null when the event is not one.
 *
 * Note the asymmetry: a spawn event's own `sessionId` is the CHILD, and the
 * delegation belongs to the parent named in the payload.
 */
export function delegatedSpawnParent(e: TokenisableEvent): string | null {
  if (e.kind !== 'session' || e.payload.action !== 'spawn') return null
  const parent = e.payload.parentSessionId
  return typeof parent === 'string' && parent ? parent : null
}

/** True when this event is the parent messaging one of its children. */
export function isDelegationMessage(e: TokenisableEvent): boolean {
  return e.kind === 'mcp' && e.payload.tool === 'send-message'
}

/**
 * Split `mcp__<server>__<tool>` — how a hook reports a tool call into an MCP
 * server — into its parts. Returns null for an ordinary built-in tool.
 *
 * Server names never contain `__` (it is the separator the protocol reserves),
 * so the first occurrence after the prefix is an unambiguous split point;
 * tool names may contain `-` and `_` freely.
 */
export function parseMcpToolName(tool: string): { server: string; name: string } | null {
  if (!tool.startsWith('mcp__')) return null
  const rest = tool.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  if (sep <= 0 || sep + 2 >= rest.length) return null
  return { server: rest.slice(0, sep), name: rest.slice(sep + 2) }
}

/** Basename of a project directory — the grouping key for per-project mining. */
export function projectKey(projectPath: string | null | undefined): string | null {
  if (!projectPath) return null
  return projectPath.split(/[\\/]/).filter(Boolean).pop() ?? null
}
