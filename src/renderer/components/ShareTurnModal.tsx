import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore, type TurnToolLevel } from '../store'
import type { ShareableTurn, TurnTimelineItem, TurnFileDiff } from '../../preload'
import {
  applyRedactions,
  collectSegments,
  composeTurnMarkdown,
  defaultFilename,
  flagSpans,
  flatDiffLines,
  redactionsFor,
  summaryLine,
  toolResultSegmentText,
  type LayerOptions,
  type Redaction,
} from '../lib/turnShare'

// ─── Redaction context (plain module state would leak across turns; these are
//     passed down through props to keep the tree honest) ─────────────────────

interface RedactApi {
  redactions: Redaction[]
  addRedaction: (r: Redaction) => void
  removeRedactionsAt: (segmentId: string, start: number, end: number) => void
}

/** Renders a segment's text with flagged tokens (dashed, click to redact) and
 *  redacted spans (pill, click to restore). Every rendered piece carries
 *  data-seg-start so text selections can be mapped back to char offsets. */
function RedactableText({
  segmentId,
  text,
  mono,
  redact,
}: {
  segmentId: string
  text: string
  mono?: boolean
  redact: RedactApi
}): JSX.Element {
  const flags = useMemo(() => flagSpans(text), [text])
  const spans = redactionsFor(redact.redactions, segmentId)

  const nodes: JSX.Element[] = []
  // Merge + clamp redactions, drop flags that overlap a redaction.
  const merged = useMemo(() => {
    const clamped = spans
      .map((s) => ({ start: Math.max(0, s.start), end: Math.min(text.length, s.end) }))
      .filter((s) => s.start < s.end)
      .sort((a, b) => a.start - b.start)
    const out: Array<{ start: number; end: number }> = []
    for (const s of clamped) {
      const last = out[out.length - 1]
      if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
      else out.push({ ...s })
    }
    return out
  }, [spans, text])

  const visibleFlags = flags.filter((f) => !merged.some((r) => f.start < r.end && r.start < f.end))
  const marks = [
    ...merged.map((r) => ({ ...r, kind: 'redacted' as const })),
    ...visibleFlags.map((f) => ({ ...f, kind: 'flag' as const })),
  ].sort((a, b) => a.start - b.start)

  let pos = 0
  marks.forEach((mark, mi) => {
    if (mark.start > pos) {
      nodes.push(
        <span key={`t${mi}`} data-seg-start={pos}>
          {text.slice(pos, mark.start)}
        </span>
      )
    }
    if (mark.kind === 'redacted') {
      nodes.push(
        <button
          key={`r${mi}`}
          data-seg-start={mark.start}
          data-seg-end={mark.end}
          data-redacted="1"
          className="mx-0.5 inline-flex items-center rounded border border-amber-500/40 bg-amber-500/15 px-1 font-mono text-[0.85em] leading-tight text-amber-300 hover:bg-amber-500/25"
          title="Redacted — will appear as [REDACTED] in the output. Click to restore."
          onClick={(e) => {
            e.stopPropagation()
            redact.removeRedactionsAt(segmentId, mark.start, mark.end)
          }}
        >
          REDACTED
        </button>
      )
    } else {
      nodes.push(
        <button
          key={`f${mi}`}
          data-seg-start={mark.start}
          data-seg-end={mark.end}
          className="cursor-pointer rounded-sm font-mono text-red-300/90 underline decoration-red-400/70 decoration-dashed underline-offset-2 hover:bg-red-500/10"
          title="Possible secret (long high-entropy string) — click to redact. Nothing is masked automatically."
          onClick={(e) => {
            e.stopPropagation()
            redact.addRedaction({ segmentId, start: mark.start, end: mark.end })
          }}
        >
          {text.slice(mark.start, mark.end)}
        </button>
      )
    }
    pos = mark.end
  })
  if (pos < text.length) {
    nodes.push(
      <span key="tail" data-seg-start={pos}>
        {text.slice(pos)}
      </span>
    )
  }

  return (
    <span data-segment-id={segmentId} className={`whitespace-pre-wrap break-words ${mono ? 'font-mono' : ''}`}>
      {nodes}
    </span>
  )
}

/** Map a DOM selection endpoint inside a segment back to a char offset. */
function offsetInSegment(node: Node, offset: number): number | null {
  let el: Node | null = node
  while (el && !(el instanceof HTMLElement && el.dataset.segStart !== undefined)) {
    el = el.parentNode
  }
  if (!(el instanceof HTMLElement)) return null
  const base = Number(el.dataset.segStart)
  if (Number.isNaN(base)) return null
  // Redacted pills: snap to their boundary (their visible text isn't the content).
  if (el.dataset.redacted) return offset === 0 ? base : Number(el.dataset.segEnd ?? base)
  if (node.nodeType === Node.TEXT_NODE) return base + offset
  return base
}

function segmentIdOf(node: Node): string | null {
  let el: Node | null = node
  while (el && !(el instanceof HTMLElement && el.dataset.segmentId)) {
    el = el.parentNode
  }
  return el instanceof HTMLElement ? (el.dataset.segmentId ?? null) : null
}

// ─── Preview blocks ──────────────────────────────────────────────────────────

function BlockShell({
  title,
  accent,
  tag,
  children,
}: {
  title: string
  accent: string
  tag?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${accent}`}>{title}</span>
        {tag && <span className="ml-auto font-mono text-[10px] text-zinc-600">{tag}</span>}
      </div>
      <div className="px-3 py-2.5 text-[12.5px] leading-relaxed text-zinc-200">{children}</div>
    </div>
  )
}

function DiffView({ diff, timelineIndex, redact }: { diff: TurnFileDiff; timelineIndex: number; redact: RedactApi }): JSX.Element {
  const lines = flatDiffLines(diff)
  return (
    <div className="my-1.5 overflow-hidden rounded border border-zinc-800 font-mono text-[11.5px] leading-relaxed">
      <div className="border-b border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-400">{diff.filePath}</div>
      <div className="overflow-x-auto">
        {lines.map((line, li) => {
          const cls = line.startsWith('+')
            ? 'bg-emerald-500/10 text-emerald-300'
            : line.startsWith('-')
              ? 'bg-red-500/10 text-red-300'
              : 'text-zinc-500'
          return (
            <div key={li} className={`px-2.5 ${cls}`}>
              <RedactableText segmentId={`tl${timelineIndex}d${li}`} text={line} mono redact={redact} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ToolCallView({
  item,
  index,
  level,
  redact,
}: {
  item: TurnTimelineItem & { kind: 'tool' }
  index: number
  level: TurnToolLevel
  redact: RedactApi
}): JSX.Element {
  const { text, dropped } = toolResultSegmentText(item, level)
  return (
    <div className="border-t border-zinc-800/70 py-1.5 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex items-baseline gap-2 font-mono text-[12px]">
        <span
          className={`shrink-0 rounded px-1.5 text-[11px] font-semibold ${
            item.isEdit ? 'bg-purple-400/10 text-purple-300' : item.name === 'Bash' ? 'bg-sky-400/10 text-sky-300' : 'bg-cyan-400/10 text-cyan-300'
          }`}
        >
          {item.name}
        </span>
        <span className="min-w-0 text-zinc-400">
          <RedactableText segmentId={`tl${index}a`} text={item.arg} mono redact={redact} />
        </span>
      </div>
      {item.isEdit && item.diff ? (
        <DiffView diff={item.diff} timelineIndex={index} redact={redact} />
      ) : text ? (
        <div className="mt-1 pl-1 font-mono text-[11.5px] leading-relaxed text-zinc-500">
          <RedactableText segmentId={`tl${index}r`} text={text} mono redact={redact} />
          {dropped > 0 && <div className="italic text-zinc-600">… (+{dropped} more lines truncated)</div>}
        </div>
      ) : null}
    </div>
  )
}

// ─── The modal ───────────────────────────────────────────────────────────────

export function ShareTurnModal(): JSX.Element | null {
  const sessionId = useStore((s) => s.shareTurnSessionId)
  const setShareTurnSessionId = useStore((s) => s.setShareTurnSessionId)
  const shareDefaults = useStore((s) => s.turnShareDefaults)
  const sessions = useStore((s) => s.sessions)

  const [turns, setTurns] = useState<ShareableTurn[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [turnIndex, setTurnIndex] = useState(0)
  const [options, setOptions] = useState<LayerOptions>({ ...shareDefaults })
  const [redactionsByTurn, setRedactionsByTurn] = useState<Record<number, Redaction[]>>({})
  const [menuOpen, setMenuOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [filename, setFilename] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [selection, setSelection] = useState<{ segmentId: string; start: number; end: number; x: number; y: number } | null>(null)

  const previewRef = useRef<HTMLDivElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const session = sessions.find((s) => s.id === sessionId)
  const close = useCallback(() => setShareTurnSessionId(null), [setShareTurnSessionId])

  // Load turns when opened; reset to the settings defaults each time.
  useEffect(() => {
    if (!sessionId) return
    // Steal focus from the terminal so keystrokes don't leak into the PTY.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    setTurns(null)
    setLoadError(null)
    setRedactionsByTurn({})
    setMenuOpen(false)
    setSaveOpen(false)
    setSelection(null)
    setOptions({ ...useStore.getState().turnShareDefaults })
    let cancelled = false
    window.api.listTurns(sessionId).then(({ turns, error }) => {
      if (cancelled) return
      setTurns(turns)
      setTurnIndex(Math.max(0, turns.length - 1))
      if (error) setLoadError(error)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const turn = turns?.[turnIndex] ?? null
  const redactions = useMemo(() => redactionsByTurn[turnIndex] ?? [], [redactionsByTurn, turnIndex])

  const redactApi: RedactApi = useMemo(
    () => ({
      redactions,
      addRedaction: (r) => {
        setRedactionsByTurn((prev) => ({ ...prev, [turnIndex]: [...(prev[turnIndex] ?? []), r] }))
        setSelection(null)
      },
      removeRedactionsAt: (segmentId, start, end) =>
        setRedactionsByTurn((prev) => ({
          ...prev,
          [turnIndex]: (prev[turnIndex] ?? []).filter(
            (r) => !(r.segmentId === segmentId && r.start < end && start < r.end)
          ),
        })),
    }),
    [redactions, turnIndex]
  )

  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }, [])

  const markdown = useMemo(
    () => (turn ? composeTurnMarkdown(turn, options, redactions, { projectName: session?.projectName }) : ''),
    [turn, options, redactions, session?.projectName]
  )

  // Advisory counts for the caution strip.
  const { flaggedCount, redactedCount } = useMemo(() => {
    if (!turn) return { flaggedCount: 0, redactedCount: 0 }
    let flagged = 0
    let redacted = 0
    for (const seg of collectSegments(turn, options)) {
      const spans = redactionsFor(redactions, seg.id)
        .map((s) => ({ start: Math.max(0, s.start), end: Math.min(seg.text.length, s.end) }))
        .filter((s) => s.start < s.end)
      redacted += spans.length
      flagged += flagSpans(seg.text).filter((f) => !spans.some((r) => f.start < r.end && r.start < f.end)).length
    }
    return { flaggedCount: flagged, redactedCount: redacted }
  }, [turn, options, redactions])

  const doCopy = useCallback(() => {
    if (!turn) return
    void navigator.clipboard.writeText(markdown).then(() => showToast('Turn copied to clipboard as markdown'))
    setMenuOpen(false)
  }, [turn, markdown, showToast])

  const openSave = useCallback(() => {
    if (!turn) return
    setFilename(defaultFilename(turn))
    setSaveOpen(true)
    setMenuOpen(false)
  }, [turn])

  const doSave = useCallback(() => {
    if (!turn || !sessionId) return
    void window.api.saveTurn({ sessionId, filename, markdown }).then(({ path, error }) => {
      if (error) showToast(error)
      else {
        showToast(`Saved to ${path}`)
        setSaveOpen(false)
      }
    })
  }, [turn, sessionId, filename, markdown, showToast])

  // Keyboard: Escape closes, ←/→ step turns, Cmd/Ctrl+Enter copies.
  useEffect(() => {
    if (!sessionId) return
    const handler = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const inInput = e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (menuOpen) setMenuOpen(false)
        else if (saveOpen) setSaveOpen(false)
        else close()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        doCopy()
        return
      }
      if (inInput || !turns?.length) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setTurnIndex((i) => Math.max(0, i - 1))
        setSelection(null)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setTurnIndex((i) => Math.min(turns.length - 1, i + 1))
        setSelection(null)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [sessionId, turns, menuOpen, saveOpen, close, doCopy])

  // Text selection → floating "Redact" affordance.
  const onPreviewMouseUp = useCallback((): void => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !previewRef.current) {
      setSelection(null)
      return
    }
    const range = sel.getRangeAt(0)
    if (!previewRef.current.contains(range.commonAncestorContainer)) {
      setSelection(null)
      return
    }
    const segA = segmentIdOf(range.startContainer)
    const segB = segmentIdOf(range.endContainer)
    if (!segA || segA !== segB) {
      setSelection(null)
      return
    }
    const start = offsetInSegment(range.startContainer, range.startOffset)
    const end = offsetInSegment(range.endContainer, range.endOffset)
    if (start === null || end === null || end <= start) {
      setSelection(null)
      return
    }
    const rect = range.getBoundingClientRect()
    const host = previewRef.current.getBoundingClientRect()
    setSelection({
      segmentId: segA,
      start,
      end,
      x: rect.left + rect.width / 2 - host.left,
      y: rect.top - host.top + previewRef.current.scrollTop,
    })
  }, [])

  if (!sessionId) return null

  const layers: Array<{ key: 'prompt' | 'tool' | 'result'; name: string; desc: string }> = [
    { key: 'prompt', name: 'Prompt', desc: 'What you asked' },
    { key: 'tool', name: 'Tool activity', desc: 'What the agent actually did' },
    { key: 'result', name: 'Result / diff', desc: 'Final answer + code changes' },
  ]

  const showResultDiffs = turn ? (!options.tool || options.toolLevel === 'summary') && turn.diffs.length > 0 : false

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={close} />
      <div className="relative z-10 flex h-[min(680px,92vh)] w-[min(960px,94vw)] flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl">
        {/* Header: title + turn selector */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[14px] font-semibold text-zinc-100">
              Share turn
              {session && <span className="text-[11px] font-normal text-zinc-500">{session.projectName}</span>}
            </div>
            <div className="mt-0.5 text-[11.5px] text-zinc-500">
              Choose what to include, then copy or save — nothing leaves until you confirm.
            </div>
          </div>
          <div className="flex items-center gap-2">
            {turns && turns.length > 0 && (
              <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-1.5 py-1">
                <button
                  className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
                  disabled={turnIndex === 0}
                  onClick={() => setTurnIndex((i) => Math.max(0, i - 1))}
                  title="Previous turn (←)"
                >
                  ◂
                </button>
                <div className="min-w-[190px] text-center">
                  <div className="text-[11.5px] text-zinc-200">
                    Turn {turnIndex + 1} of {turns.length}
                    {turn?.interrupted && <span className="ml-1.5 text-amber-400">interrupted</span>}
                  </div>
                  <div className="truncate text-[10.5px] text-zinc-500">
                    {turn && new Date(turn.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    {turn?.label ? ` · ${turn.label}` : ''}
                  </div>
                </div>
                <button
                  className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
                  disabled={turnIndex >= turns.length - 1}
                  onClick={() => setTurnIndex((i) => Math.min(turns.length - 1, i + 1))}
                  title="Next turn (→)"
                >
                  ▸
                </button>
              </div>
            )}
            <button className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" onClick={close} title="Close (Esc)">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]">
          {/* Layer controls */}
          <div className="flex min-h-0 flex-col gap-1 overflow-y-auto border-r border-zinc-800 p-3">
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-600">Layers</div>
            {layers.map((layer) => {
              const on = options[layer.key]
              return (
                <div
                  key={layer.key}
                  className={`cursor-pointer rounded-lg border px-2.5 py-2 transition-colors ${
                    on ? 'border-zinc-800 bg-zinc-900' : 'border-transparent hover:bg-zinc-900/50'
                  }`}
                  onClick={() => setOptions((o) => ({ ...o, [layer.key]: !o[layer.key] }))}
                >
                  <div className="flex items-start gap-2.5">
                    <span
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        on ? 'border-sky-500 bg-sky-500 text-zinc-950' : 'border-zinc-600 bg-zinc-900'
                      }`}
                    >
                      {on && (
                        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      )}
                    </span>
                    <div className="min-w-0">
                      <div className={`text-[12.5px] font-medium ${on ? 'text-zinc-100' : 'text-zinc-400'}`}>{layer.name}</div>
                      <div className="text-[11px] leading-snug text-zinc-600">{layer.desc}</div>
                      {layer.key === 'tool' && on && (
                        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                          <div className="flex gap-0.5 rounded-lg border border-zinc-800 bg-zinc-950 p-0.5">
                            {(['summary', 'commands', 'full'] as const).map((lv) => (
                              <button
                                key={lv}
                                className={`flex-1 rounded-md px-1 py-1 text-[11px] font-medium capitalize transition-colors ${
                                  options.toolLevel === lv ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200'
                                }`}
                                onClick={() => setOptions((o) => ({ ...o, toolLevel: lv }))}
                              >
                                {lv}
                              </button>
                            ))}
                          </div>
                          <div className="mt-1.5 px-0.5 text-[10.5px] leading-snug text-zinc-600">
                            {options.toolLevel === 'summary' && 'One-line rollup — no commands or output.'}
                            {options.toolLevel === 'commands' && (
                              <>
                                Calls with results truncated. <b className="text-zinc-500">File edits keep their full diff</b> — only command output is trimmed.
                              </>
                            )}
                            {options.toolLevel === 'full' && 'Commands plus complete output. Most verbose — good for PR evidence.'}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Preview */}
          <div className="flex min-h-0 min-w-0 flex-col bg-zinc-950">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
              <span className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-600">Live preview</span>
              <span className="font-mono text-[10.5px] text-zinc-600">markdown</span>
            </div>
            {/* Honest, persistent caution strip */}
            <div
              className={`flex items-center gap-2 border-b border-zinc-800 px-4 py-2 text-[11.5px] ${
                flaggedCount > 0 ? 'bg-amber-500/[0.07] text-amber-300/90' : 'bg-zinc-900/60 text-zinc-500'
              }`}
            >
              <span>⚠</span>
              <span>
                {flaggedCount > 0 || redactedCount > 0
                  ? `${flaggedCount} possible secret${flaggedCount === 1 ? '' : 's'} flagged · ${redactedCount} redacted — `
                  : ''}
                flags are suggestions only; click a flagged token or select any text to redact it before sharing.
              </span>
            </div>
            <div ref={previewRef} className="relative flex-1 space-y-3 overflow-y-auto p-4" onMouseUp={onPreviewMouseUp}>
              {!turns && !loadError && <div className="pt-10 text-center text-[12px] text-zinc-600">Loading turns…</div>}
              {loadError && turns?.length === 0 && <div className="pt-10 text-center text-[12px] text-zinc-500">{loadError}</div>}
              {turns && turns.length > 0 && turn && (
                <>
                  {options.prompt && (
                    <BlockShell title="Prompt" accent="text-sky-400">
                      <RedactableText segmentId="prompt" text={turn.promptText} redact={redactApi} />
                    </BlockShell>
                  )}
                  {options.tool && (
                    <BlockShell
                      title="Tool activity"
                      accent="text-cyan-400"
                      tag={
                        options.toolLevel === 'summary'
                          ? 'summary'
                          : `${turn.timeline.filter((t) => t.kind === 'tool').length} calls · ${options.toolLevel}`
                      }
                    >
                      {options.toolLevel === 'summary' ? (
                        <div className="font-mono text-[12px] text-zinc-400">{summaryLine(turn)}</div>
                      ) : (
                        turn.timeline.map((item, i) =>
                          item.kind === 'text' ? (
                            <div key={i} className="border-t border-zinc-800/70 py-1.5 text-zinc-400 first:border-t-0 first:pt-0 last:pb-0">
                              <RedactableText segmentId={`tl${i}`} text={item.text} redact={redactApi} />
                            </div>
                          ) : (
                            <ToolCallView key={i} item={item} index={i} level={options.toolLevel} redact={redactApi} />
                          )
                        )
                      )}
                    </BlockShell>
                  )}
                  {options.result && (
                    <BlockShell title="Result" accent="text-emerald-400" tag={turn.diffs.length ? `${turn.diffs.length} file${turn.diffs.length === 1 ? '' : 's'} changed` : undefined}>
                      {turn.resultText ? (
                        <RedactableText segmentId="result" text={turn.resultText} redact={redactApi} />
                      ) : (
                        !showResultDiffs && <span className="italic text-zinc-600">(no final text)</span>
                      )}
                      {showResultDiffs &&
                        turn.timeline.map((item, i) =>
                          item.kind === 'tool' && item.diff ? <DiffView key={i} diff={item.diff} timelineIndex={i} redact={redactApi} /> : null
                        )}
                    </BlockShell>
                  )}
                  {!options.prompt && !options.tool && !options.result && (
                    <div className="pt-10 text-center text-[12px] text-zinc-600">
                      Nothing selected — pick at least one layer to build a turn block.
                    </div>
                  )}
                </>
              )}
              {/* Floating Redact affordance for the current selection */}
              {selection && (
                <button
                  className="absolute z-20 -translate-x-1/2 -translate-y-full rounded-md border border-amber-500/50 bg-zinc-900 px-2.5 py-1 text-[11.5px] font-medium text-amber-300 shadow-lg hover:bg-zinc-800"
                  style={{ left: selection.x, top: Math.max(selection.y - 6, 4) }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    redactApi.addRedaction({ segmentId: selection.segmentId, start: selection.start, end: selection.end })
                    window.getSelection()?.removeAllRanges()
                  }}
                >
                  Redact
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-3">
          <div className="text-[11px] text-zinc-600">
            {layers
              .filter((l) => options[l.key])
              .map((l) => (l.key === 'tool' ? `Tool activity (${options.toolLevel})` : l.name.replace(' / diff', '')))
              .join(' · ') || 'Nothing selected'}
          </div>
          <div className="relative flex items-center gap-2">
            {saveOpen && (
              <div className="flex items-center gap-1.5">
                <input
                  className="w-72 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-[11.5px] text-zinc-200 outline-none focus:border-sky-500"
                  value={filename}
                  onChange={(e) => setFilename(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') doSave()
                  }}
                  autoFocus
                />
                <button
                  className="rounded-md bg-sky-500 px-3 py-1.5 text-[12px] font-semibold text-zinc-950 hover:bg-sky-400"
                  onClick={doSave}
                >
                  Save
                </button>
                <button className="rounded-md px-2 py-1.5 text-[12px] text-zinc-400 hover:text-zinc-200" onClick={() => setSaveOpen(false)}>
                  Cancel
                </button>
              </div>
            )}
            {!saveOpen && (
              <>
                <button className="rounded-md border border-zinc-700 px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200" onClick={close}>
                  Cancel
                </button>
                <div className="flex overflow-hidden rounded-md">
                  <button
                    className="flex items-center gap-1.5 bg-sky-500 px-3.5 py-1.5 text-[12.5px] font-semibold text-zinc-950 hover:bg-sky-400 disabled:opacity-40"
                    disabled={!turn || (!options.prompt && !options.tool && !options.result)}
                    onClick={doCopy}
                    title="Copy markdown to clipboard (⌘↵)"
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    Copy
                  </button>
                  <button
                    className="border-l border-zinc-950/30 bg-sky-500 px-2 text-zinc-950 hover:bg-sky-400 disabled:opacity-40"
                    disabled={!turn}
                    onClick={() => setMenuOpen((v) => !v)}
                    title="Copy options"
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                </div>
                {menuOpen && (
                  <div className="absolute bottom-full right-0 z-20 mb-2 w-60 rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-2xl">
                    <button className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-zinc-800" onClick={doCopy}>
                      <div>
                        <div className="text-[12px] font-medium text-zinc-100">Copy to clipboard</div>
                        <div className="text-[10.5px] text-zinc-500">Markdown — paste into Slack, PRs, docs</div>
                      </div>
                      <span className="ml-auto self-center rounded border border-zinc-700 px-1 py-0.5 text-[9.5px] text-zinc-500">⌘↵</span>
                    </button>
                    <button className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-zinc-800" onClick={openSave}>
                      <div>
                        <div className="text-[12px] font-medium text-zinc-100">Save as file…</div>
                        <div className="text-[10.5px] text-zinc-500">.md into the turn export folder</div>
                      </div>
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Toast */}
        {toast && (
          <div className="absolute bottom-16 left-1/2 z-30 -translate-x-1/2 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-[12px] text-zinc-200 shadow-2xl">
            <span className="mr-1.5 text-emerald-400">✓</span>
            {toast}
          </div>
        )}
      </div>
    </div>
  )
}
