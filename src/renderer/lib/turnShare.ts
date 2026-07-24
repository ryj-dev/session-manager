// Share Turn — pure helpers for composing a turn into markdown, flagging
// possible secrets, and applying span-level redactions.
//
// The preview and the composed output walk the SAME segments (stable ids per
// piece of user content), so a redaction made in the preview lands in the
// output byte-for-byte. Redactions replace spans with a fixed `[REDACTED]`
// marker — never silent removal, never length-preserving dots.

import type { ShareableTurn, TurnTimelineItem, TurnFileDiff } from '../../preload'

export type TurnToolLevel = 'summary' | 'commands' | 'full'

export interface LayerOptions {
  prompt: boolean
  tool: boolean
  result: boolean
  toolLevel: TurnToolLevel
}

/** A redaction span, anchored to a segment's text by char offsets. */
export interface Redaction {
  segmentId: string
  start: number
  end: number
}

/** A possible-secret flag within a segment (advisory only — never auto-masked). */
export interface FlagSpan {
  start: number
  end: number
}

export const REDACTED_MARKER = '[REDACTED]'

/** Bash-style results are trimmed to this many lines at the Commands level. */
export const COMMANDS_RESULT_LINES = 6

// ── Entropy flagging ────────────────────────────────────────────────────────

/** Candidate token: long unbroken run of identifier/base64-ish chars.
 *  '/' and '.' are excluded so file paths split into short components;
 *  '=' is excluded so `TOKEN=value` flags only the value, keeping the
 *  variable name readable after redaction. */
const TOKEN_RE = /[A-Za-z0-9_+-]{20,}/g

const MIN_ENTROPY = 3.6

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let entropy = 0
  for (const n of counts.values()) {
    const p = n / s.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

/** Flag long, high-entropy tokens that look like secrets. Warning only —
 *  false positives (git SHAs, hashes in diffs) are acceptable because nothing
 *  is masked without a click. Requires both letters and digits so ordinary
 *  long words and kebab-case names don't trip it. */
export function flagSpans(text: string): FlagSpan[] {
  const flags: FlagSpan[] = []
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0]
    if (!/\d/.test(token) || !/[a-zA-Z]/.test(token)) continue
    if (shannonEntropy(token) < MIN_ENTROPY) continue
    flags.push({ start: match.index, end: match.index + token.length })
  }
  return flags
}

// ── Redaction application ───────────────────────────────────────────────────

/** Replace each redacted span with the `[REDACTED]` marker. Spans are clamped
 *  to the text (level toggles can shorten segments), merged when overlapping,
 *  and each surviving span becomes its own marker. */
export function applyRedactions(text: string, spans: Array<{ start: number; end: number }>): string {
  const clamped = spans
    .map((s) => ({ start: Math.max(0, s.start), end: Math.min(text.length, s.end) }))
    .filter((s) => s.start < s.end)
    .sort((a, b) => a.start - b.start)
  if (!clamped.length) return text
  const merged: Array<{ start: number; end: number }> = []
  for (const s of clamped) {
    const last = merged[merged.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else merged.push({ ...s })
  }
  let out = ''
  let pos = 0
  for (const s of merged) {
    out += text.slice(pos, s.start) + REDACTED_MARKER
    pos = s.end
  }
  return out + text.slice(pos)
}

export function redactionsFor(redactions: Redaction[], segmentId: string): Redaction[] {
  return redactions.filter((r) => r.segmentId === segmentId)
}

// ── Segments ────────────────────────────────────────────────────────────────
//
// Segment ids are stable per turn content:
//   prompt          — the prompt text
//   tl<i>           — narration text at timeline index i
//   tl<i>a          — tool call arg at timeline index i
//   tl<i>r          — tool result text (possibly line-truncated by level)
//   tl<i>d          — tool diff, one string of unified-diff lines
//   result          — trailing assistant prose

export function truncateLines(text: string, maxLines: number): { text: string; dropped: number } {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { text, dropped: 0 }
  return { text: lines.slice(0, maxLines).join('\n'), dropped: lines.length - maxLines }
}

/** All unified-diff lines of a file diff, flattened across hunks. Preview and
 *  composer both use per-line segments (`tl<i>d<lineIdx>`) so diff lines can
 *  be colorized in the preview while staying redactable. */
export function flatDiffLines(diff: TurnFileDiff): string[] {
  return diff.hunks.flatMap((h) => h.lines)
}

/** Resolved text for a tool call's result segment at the given level. */
export function toolResultSegmentText(item: TurnTimelineItem, level: TurnToolLevel): { text: string; dropped: number } {
  if (item.kind !== 'tool' || !item.resultText) return { text: '', dropped: 0 }
  if (level === 'full') return { text: item.resultText, dropped: 0 }
  return truncateLines(item.resultText, COMMANDS_RESULT_LINES)
}

/** One-line rollup for the Summary level, e.g. "Read ×4 · Bash ×2 · edited store.ts". */
export function summaryLine(turn: ShareableTurn): string {
  const counts = new Map<string, number>()
  const editedFiles: string[] = []
  for (const item of turn.timeline) {
    if (item.kind !== 'tool') continue
    if (item.isEdit && item.diff) {
      const base = item.diff.filePath.split('/').pop() ?? item.diff.filePath
      if (!editedFiles.includes(base)) editedFiles.push(base)
      continue
    }
    counts.set(item.name, (counts.get(item.name) ?? 0) + 1)
  }
  const parts = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
  if (editedFiles.length) parts.push(`edited ${editedFiles.join(', ')}`)
  return parts.length ? parts.join(' · ') : 'no tool activity'
}

// ── Markdown composition ────────────────────────────────────────────────────

/** Every redactable segment included by the current layer options, in order.
 *  Drives the flag counter in the modal — must stay in lockstep with what
 *  composeTurnMarkdown and the preview actually render. */
export function collectSegments(turn: ShareableTurn, options: LayerOptions): Array<{ id: string; text: string }> {
  const segments: Array<{ id: string; text: string }> = []
  const pushDiff = (i: number, item: TurnTimelineItem): void => {
    if (item.kind !== 'tool' || !item.diff) return
    flatDiffLines(item.diff).forEach((line, li) => segments.push({ id: `tl${i}d${li}`, text: line }))
  }
  if (options.prompt) segments.push({ id: 'prompt', text: turn.promptText })
  if (options.tool && options.toolLevel !== 'summary') {
    turn.timeline.forEach((item, i) => {
      if (item.kind === 'text') {
        segments.push({ id: `tl${i}`, text: item.text })
        return
      }
      segments.push({ id: `tl${i}a`, text: item.arg })
      if (item.isEdit && item.diff) {
        pushDiff(i, item)
        return
      }
      const { text } = toolResultSegmentText(item, options.toolLevel)
      if (text) segments.push({ id: `tl${i}r`, text })
    })
  }
  if (options.result) {
    if (turn.resultText) segments.push({ id: 'result', text: turn.resultText })
    if ((!options.tool || options.toolLevel === 'summary') && turn.diffs.length) {
      turn.timeline.forEach((item, i) => pushDiff(i, item))
    }
  }
  return segments
}

/** Longest backtick fence inside `text`, +1 — so embedded fences can't break out. */
function fenceFor(text: string): string {
  const runs = text.match(/`{3,}/g)
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0
  return '`'.repeat(Math.max(3, longest + 1))
}

function fencedBlock(text: string, lang = ''): string {
  const fence = fenceFor(text)
  return `${fence}${lang}\n${text}\n${fence}`
}

function redactedDiffBlock(
  diff: TurnFileDiff,
  timelineIndex: number,
  redact: (segmentId: string, text: string) => string
): string {
  const lines = flatDiffLines(diff).map((line, li) => redact(`tl${timelineIndex}d${li}`, line))
  return fencedBlock(lines.join('\n'), 'diff')
}

/** Compose the shareable markdown for a turn. `redact` resolves a segment's
 *  final text (redactions applied) so preview and output can't drift. */
export function composeTurnMarkdown(
  turn: ShareableTurn,
  options: LayerOptions,
  redactions: Redaction[],
  meta?: { projectName?: string }
): string {
  const redact = (segmentId: string, text: string): string =>
    applyRedactions(text, redactionsFor(redactions, segmentId))

  const when = new Date(turn.timestamp)
  const stamp = isNaN(when.getTime()) ? turn.timestamp : when.toLocaleString()
  const parts: string[] = []
  parts.push(`# Turn — ${stamp}${meta?.projectName ? ` (${meta.projectName})` : ''}`)
  if (turn.interrupted) parts.push('_This turn was interrupted by the user._')

  if (options.prompt) {
    parts.push('## Prompt')
    parts.push(redact('prompt', turn.promptText))
  }

  if (options.tool) {
    parts.push('## Tool activity')
    if (options.toolLevel === 'summary') {
      parts.push(summaryLine(turn))
    } else {
      turn.timeline.forEach((item, i) => {
        if (item.kind === 'text') {
          parts.push(redact(`tl${i}`, item.text))
          return
        }
        const arg = redact(`tl${i}a`, item.arg)
        parts.push(`**${item.name}** \`${arg.replace(/`/g, "'")}\``)
        if (item.isEdit && item.diff) {
          parts.push(redactedDiffBlock(item.diff, i, redact))
          return
        }
        const { text, dropped } = toolResultSegmentText(item, options.toolLevel)
        if (text) {
          const suffix = dropped > 0 ? `\n… (+${dropped} more lines truncated)` : ''
          parts.push(fencedBlock(redact(`tl${i}r`, text) + suffix))
        }
      })
    }
  }

  if (options.result) {
    parts.push('## Result')
    if (turn.resultText) parts.push(redact('result', turn.resultText))
    // The diffs ARE the payload — attach them to the result layer even when
    // tool activity is off.
    const showDiffs = !options.tool || options.toolLevel === 'summary'
    if (showDiffs && turn.diffs.length) {
      parts.push('### Changes')
      turn.timeline.forEach((item, i) => {
        if (item.kind === 'tool' && item.diff) {
          parts.push(`**\`${item.diff.filePath}\`**`)
          parts.push(redactedDiffBlock(item.diff, i, redact))
        }
      })
    }
    if (!turn.resultText && !(showDiffs && turn.diffs.length)) parts.push('_(no final text)_')
  }

  return parts.join('\n\n') + '\n'
}

// ── Filenames ───────────────────────────────────────────────────────────────

export function defaultFilename(turn: ShareableTurn): string {
  const when = new Date(turn.timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const date = isNaN(when.getTime())
    ? 'turn'
    : `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}`
  const slug = turn.promptText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug ? `${date}-${slug}.md` : `${date}.md`
}
