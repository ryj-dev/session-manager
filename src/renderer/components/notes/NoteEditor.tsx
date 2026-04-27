import { useEffect, useRef, useState } from 'react'

interface Props {
  relPath: string
}

export function NoteEditor({ relPath }: Props): JSX.Element {
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressNextLoad = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (suppressNextLoad.current) {
      suppressNextLoad.current = false
      return
    }
    setLoaded(false)
    window.api.notesReadNote(relPath).then((c) => {
      setContent(c)
      setLoaded(true)
    })
  }, [relPath])

  const handleChange = (next: string): void => {
    setContent(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      suppressNextLoad.current = true
      await window.api.notesWriteNote(relPath, next)
      setSavedAt(Date.now())
    }, 400)
  }

  const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0
  const displayName = relPath.split('/').pop()?.replace(/\.md$/, '') ?? relPath
  const project = relPath.includes('/') ? relPath.split('/')[0] : null

  if (!loaded) {
    return (
      <div className="h-full flex items-center justify-center">
        <span className="font-display italic text-sm" style={{ color: 'var(--ink-faint)' }}>loading…</span>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col ink-fade-in">
      {/* Document head */}
      <div className="shrink-0 px-14 pt-10 pb-5 relative">
        <div className="flex items-baseline justify-between mb-4 font-mono-ui text-[9px] smallcaps" style={{ color: 'var(--ink-faint)' }}>
          <span>
            {project && <>Folio · {project} · </>}Entry
          </span>
          <span>
            {wordCount} word{wordCount === 1 ? '' : 's'}
            {savedAt && <span className="ml-4" style={{ color: 'var(--accent)' }}>↵ committed</span>}
          </span>
        </div>
        <h1 className="font-display text-[42px] leading-[1.05] tracking-tight" style={{ color: 'var(--ink)', fontWeight: 400 }}>
          {displayName}
        </h1>
        <div className="mt-3 flex items-center gap-3">
          <div className="h-px flex-1" style={{ background: 'linear-gradient(to right, var(--accent) 0, var(--accent) 36px, var(--rule) 36px, var(--rule-strong))' }} />
          <span className="font-mono-ui text-[9px] smallcaps" style={{ color: 'var(--ink-faint)' }}>
            {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto notes-scroll px-14 pb-14">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Begin writing…"
          spellCheck={false}
          autoFocus
          className="w-full min-h-full resize-none outline-none bg-transparent"
          style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontSize: 18,
            lineHeight: 1.7,
            color: 'var(--ink)',
            caretColor: 'var(--accent)',
            letterSpacing: '-0.003em',
            fontOpticalSizing: 'auto',
          }}
        />
      </div>
    </div>
  )
}
