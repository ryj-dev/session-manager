import { useMemo } from 'react'
import { useStore, artifactsForSession, type Session } from '../../store'
import { summaryFor, titleFor } from './summary'

const ICONS: Record<string, string> = {
  'result-table': '▦',
  markdown: '¶',
  image: '▣',
  'annotated-image': '◎',
}

/**
 * Compact stand-in for the canvas dock in narrow split panes: a small pill
 * showing the latest artifact's summary. Clicking opens the full-viewport
 * ArtifactOverlay (wired by SplitView).
 */
export function CompactArtifactCard({ session, onOpen }: { session: Session; onOpen: () => void }): JSX.Element | null {
  const canvasArtifacts = useStore((s) => s.canvasArtifacts)
  const unseen = useStore((s) => s.unseenCanvasSessionIds.includes(session.id))

  const artifacts = useMemo(
    () => artifactsForSession(canvasArtifacts, session),
    [canvasArtifacts, session],
  )
  const latest = artifacts[artifacts.length - 1]
  if (!latest) return null

  return (
    <button
      onClick={onOpen}
      className="absolute bottom-2 right-2 z-10 flex items-center gap-1.5 px-2 py-1 rounded-md bg-zinc-900/95 border border-zinc-700/80 hover:border-zinc-500 shadow-lg"
      title={`${titleFor(latest)} — open canvas${artifacts.length > 1 ? ` (${artifacts.length} artifacts)` : ''}`}
    >
      <span className="text-[11px] text-violet-300">{ICONS[latest.component] ?? '▣'}</span>
      <span className="text-[10px] text-zinc-300 max-w-[180px] truncate">{summaryFor(latest)}</span>
      {artifacts.length > 1 && (
        <span className="text-[9px] text-zinc-500 tabular-nums">{artifacts.length}</span>
      )}
      {unseen && <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />}
    </button>
  )
}
