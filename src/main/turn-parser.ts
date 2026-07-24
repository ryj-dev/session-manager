// Parse Claude Code transcript JSONL files into shareable turns.
//
// A turn = one user prompt + everything the assistant did until the next
// prompt: thinking blocks, tool calls (with results), and the final reply.
// This is the data source for the "Share turn" modal — a clean semantic
// re-render from the structured transcript, not a terminal scrape.
//
// Pure module (no electron imports) so it is unit-testable with `node --test`.
// Callers hand in the JSONL text; reading the file is their job.

import { homedir } from 'os'
import { join } from 'path'

export interface TurnDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Unified-diff lines including their ' '/'+'/'-' prefix. */
  lines: string[]
}

export interface TurnFileDiff {
  filePath: string
  hunks: TurnDiffHunk[]
}

export interface TurnToolCall {
  kind: 'tool'
  id: string
  name: string
  /** One-line argument summary (full Bash command, file path, pattern, …). */
  arg: string
  /** Text of the tool result, if any. Full text — display truncation is the
   *  composer's job (truncation is not redaction; scans see the whole thing). */
  resultText: string | null
  /** Edit/Write-style call whose diff is the payload and survives truncation. */
  isEdit: boolean
  diff?: TurnFileDiff
}

export interface TurnNarration {
  kind: 'text'
  text: string
}

export type TurnTimelineItem = TurnToolCall | TurnNarration

export interface ShareableTurn {
  index: number
  /** ISO timestamp of the prompt that started the turn. */
  timestamp: string
  endTimestamp: string | null
  promptText: string
  /** Short human label for the turn selector, e.g. "edited store.ts". */
  label: string
  /** Trailing assistant prose after the last tool call — the final answer. */
  resultText: string
  /** Chronological tool calls + interleaved narration (result text excluded). */
  timeline: TurnTimelineItem[]
  /** All file diffs from Edit/Write calls, in order, for the Result layer. */
  diffs: TurnFileDiff[]
  interrupted: boolean
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** ~/.claude/projects/<slug>/<claudeSessionId>.jsonl — fallback when no
 *  transcript_path was captured from a hook. Claude Code slugifies the cwd
 *  by replacing every non-alphanumeric character with '-'. */
export function deriveTranscriptPath(projectPath: string, claudeSessionId: string): string {
  const slug = projectPath.replace(/[^a-zA-Z0-9]/g, '-')
  return join(homedir(), '.claude', 'projects', slug, `${claudeSessionId}.jsonl`)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Extract plain text from a tool_result block's content (string or blocks). */
function toolResultText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .filter(isRecord)
      .filter((b) => b.type === 'text')
      .map((b) => asString(b.text))
      .filter(Boolean)
    return parts.length ? parts.join('\n') : null
  }
  return null
}

/** One-line summary of a tool call's arguments for the activity timeline. */
function argSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return asString(input.command)
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return asString(input.file_path)
    case 'Grep':
    case 'Glob':
      return asString(input.pattern)
    case 'WebFetch':
      return asString(input.url)
    case 'Task':
    case 'Agent':
      return asString(input.description) || asString(input.prompt).slice(0, 120)
  }
  const firstString = Object.values(input).find((v) => typeof v === 'string')
  if (typeof firstString === 'string' && firstString) return firstString.slice(0, 160)
  try {
    const json = JSON.stringify(input)
    return json.length > 160 ? json.slice(0, 160) + '…' : json
  } catch {
    return ''
  }
}

function parseHunks(structuredPatch: unknown): TurnDiffHunk[] {
  if (!Array.isArray(structuredPatch)) return []
  const hunks: TurnDiffHunk[] = []
  for (const h of structuredPatch) {
    if (!isRecord(h) || !Array.isArray(h.lines)) continue
    hunks.push({
      oldStart: typeof h.oldStart === 'number' ? h.oldStart : 0,
      oldLines: typeof h.oldLines === 'number' ? h.oldLines : 0,
      newStart: typeof h.newStart === 'number' ? h.newStart : 0,
      newLines: typeof h.newLines === 'number' ? h.newLines : 0,
      lines: h.lines.map((l: unknown) => asString(l)),
    })
  }
  return hunks
}

/** Diff for an Edit/Write call from the transcript's toolUseResult, falling
 *  back to an all-added synthetic hunk for file creations. */
function extractDiff(name: string, input: Record<string, unknown>, toolUseResult: unknown): TurnFileDiff | undefined {
  const filePath = asString(input.file_path) || (isRecord(toolUseResult) ? asString(toolUseResult.filePath) : '')
  if (isRecord(toolUseResult)) {
    const hunks = parseHunks(toolUseResult.structuredPatch)
    if (hunks.length && filePath) return { filePath, hunks }
  }
  if (name === 'Write' && filePath && typeof input.content === 'string') {
    const lines = input.content.split('\n').map((l) => '+' + l)
    return {
      filePath,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }],
    }
  }
  return undefined
}

/** True for user entries that are real prompts (not tool results, not meta,
 *  not slash-command bookkeeping). */
function promptTextOf(entry: Record<string, unknown>): string | null {
  if (entry.isMeta) return null
  const message = isRecord(entry.message) ? entry.message : null
  const content = message?.content
  if (typeof content === 'string') {
    if (
      content.startsWith('<command-name>') ||
      content.startsWith('<local-command-stdout>') ||
      content.startsWith('Caveat:')
    ) {
      return null
    }
    return content
  }
  if (Array.isArray(content)) {
    const blocks = content.filter(isRecord)
    if (blocks.some((b) => b.type === 'tool_result')) return null
    const parts = blocks
      .map((b) => (b.type === 'text' ? asString(b.text) : b.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
    return parts.length ? parts.join('\n') : null
  }
  return null
}

function makeLabel(turn: ShareableTurn): string {
  const edits = turn.timeline.filter(
    (t): t is TurnToolCall => t.kind === 'tool' && t.isEdit && !!t.diff
  )
  if (edits.length) {
    const files = [...new Set(edits.map((e) => e.diff!.filePath.split('/').pop() || ''))].filter(Boolean)
    if (files.length === 1) return `edited ${files[0]}`
    if (files.length > 1) return `edited ${files[0]} +${files.length - 1}`
  }
  const tools = turn.timeline.filter((t) => t.kind === 'tool')
  if (tools.length) return `${tools.length} tool call${tools.length === 1 ? '' : 's'}`
  return 'reply'
}

export function parseTranscriptTurns(jsonl: string): ShareableTurn[] {
  const turns: ShareableTurn[] = []
  let current: ShareableTurn | null = null
  // tool_use id → call, so results (which arrive as user entries) pair up.
  const pendingCalls = new Map<string, TurnToolCall>()

  const finalize = (turn: ShareableTurn): void => {
    // Trailing narration after the last tool call is the final answer.
    const trailing: string[] = []
    while (turn.timeline.length && turn.timeline[turn.timeline.length - 1].kind === 'text') {
      trailing.unshift((turn.timeline.pop() as TurnNarration).text)
    }
    turn.resultText = trailing.join('\n\n')
    turn.diffs = turn.timeline
      .filter((t): t is TurnToolCall => t.kind === 'tool' && !!t.diff)
      .map((t) => t.diff!)
    turn.label = makeLabel(turn)
    turns.push(turn)
  }

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(entry) || entry.isSidechain === true) continue
    const type = entry.type
    if (type !== 'user' && type !== 'assistant') continue
    const timestamp = asString(entry.timestamp)
    const message = isRecord(entry.message) ? entry.message : {}

    if (type === 'user') {
      const prompt = promptTextOf(entry)
      if (prompt !== null) {
        if (prompt.includes('[Request interrupted')) {
          if (current) current.interrupted = true
          continue
        }
        if (current) finalize(current)
        pendingCalls.clear()
        current = {
          index: turns.length,
          timestamp,
          endTimestamp: null,
          promptText: prompt,
          label: '',
          resultText: '',
          timeline: [],
          diffs: [],
          interrupted: false,
        }
        continue
      }
      // Not a prompt — attach any tool results to their pending calls.
      if (!current) continue
      current.endTimestamp = timestamp || current.endTimestamp
      const content = message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_result') continue
        const call = pendingCalls.get(asString(block.tool_use_id))
        if (!call) continue
        call.resultText = toolResultText(block.content)
        if (call.isEdit && !call.diff) {
          // structuredPatch rides on the entry, not the content block.
          const diff = extractDiff(call.name, {}, entry.toolUseResult)
          if (diff) call.diff = diff
        }
      }
      continue
    }

    // assistant entry
    if (!current) continue
    current.endTimestamp = timestamp || current.endTimestamp
    const content = message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'text') {
        const text = asString(block.text)
        if (text) current.timeline.push({ kind: 'text', text })
      } else if (block.type === 'tool_use') {
        const name = asString(block.name)
        const input = isRecord(block.input) ? block.input : {}
        const call: TurnToolCall = {
          kind: 'tool',
          id: asString(block.id),
          name,
          arg: argSummary(name, input),
          resultText: null,
          isEdit: EDIT_TOOLS.has(name),
          diff: EDIT_TOOLS.has(name) ? extractDiff(name, input, undefined) : undefined,
        }
        pendingCalls.set(call.id, call)
        current.timeline.push(call)
      }
    }
  }

  if (current) finalize(current)
  return turns
}
