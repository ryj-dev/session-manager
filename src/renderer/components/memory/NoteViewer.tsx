/**
 * Markdown note viewer with inline section editing and wikilink navigation.
 * Click any section heading to edit that section in-place.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface NoteData {
  filename: string
  title: string
  type: string
  tags: string[]
  date: string
  modified: string
  body: string
}

interface Section {
  heading: string
  content: string
  startLine: number
  endLine: number
}

interface Props {
  filename: string
  onNavigate: (filename: string) => void
  onChanged?: () => void
}

/** Parse a markdown body into sections (## headings). */
function parseSections(body: string): { preamble: string; sections: Section[] } {
  const lines = body.split('\n')
  const sections: Section[] = []
  let preambleEnd = lines.length

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      if (sections.length === 0) preambleEnd = i
      const heading = lines[i].replace(/^## /, '').trim()
      // Close previous section
      if (sections.length > 0) {
        sections[sections.length - 1].endLine = i
        sections[sections.length - 1].content = lines
          .slice(sections[sections.length - 1].startLine, i)
          .join('\n')
          .trim()
      }
      sections.push({ heading, content: '', startLine: i + 1, endLine: lines.length })
    }
  }

  // Close last section
  if (sections.length > 0) {
    const last = sections[sections.length - 1]
    last.content = lines.slice(last.startLine, last.endLine).join('\n').trim()
  }

  const preamble = lines.slice(0, preambleEnd).join('\n').trim()
  return { preamble, sections }
}

/** Preprocess [[wikilinks]] into markdown links for react-markdown. */
function preprocessWikilinks(body: string): string {
  return body.replace(/\[\[([^\]]+)\]\]/g, (_, link) => {
    const label = link.replace(/\.md$/, '')
    return `[${label}](/memory/${link})`
  })
}

const TYPE_COLORS: Record<string, string> = {
  context: '#007F7E',
  decision: '#C48A1A',
  project: '#1e90ff',
  reference: '#9C27B0',
  'session-log': '#777',
  user: '#e040a0',
  feedback: '#ff6b35',
}

function MarkdownContent({ content, onLinkClick }: { content: string; onLinkClick: (href: string) => void }) {
  const processed = preprocessWikilinks(content)
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => {
          if (href?.startsWith('/memory/')) {
            return (
              <a href={href} onClick={(e) => { e.preventDefault(); onLinkClick(href) }}
                style={{ color: '#6cf', textDecoration: 'none', borderBottom: '1px dotted #6cf4' }}>
                {children}
              </a>
            )
          }
          return <a href={href} target="_blank" rel="noreferrer" style={{ color: '#6cf' }}>{children}</a>
        },
        h1: ({ children }) => <h1 style={{ fontSize: 22, fontWeight: 600, color: '#e0e0e0', marginBottom: 8 }}>{children}</h1>,
        h2: ({ children }) => <h2 style={{ fontSize: 16, fontWeight: 600, color: '#c0c8d0', marginTop: 24, marginBottom: 8, borderBottom: '1px solid #1e2530', paddingBottom: 4 }}>{children}</h2>,
        h3: ({ children }) => <h3 style={{ fontSize: 14, fontWeight: 600, color: '#aab8c0', marginTop: 16, marginBottom: 4 }}>{children}</h3>,
        p: ({ children }) => <p style={{ marginBottom: 12 }}>{children}</p>,
        ul: ({ children }) => <ul style={{ paddingLeft: 20, marginBottom: 12 }}>{children}</ul>,
        ol: ({ children }) => <ol style={{ paddingLeft: 20, marginBottom: 12 }}>{children}</ol>,
        li: ({ children }) => <li style={{ marginBottom: 4 }}>{children}</li>,
        code: ({ children, className }) => {
          if (className) {
            return <code style={{ display: 'block', background: '#111418', padding: 12, borderRadius: 4, fontSize: 12, fontFamily: 'ui-monospace, monospace', overflowX: 'auto', marginBottom: 12 }}>{children}</code>
          }
          return <code style={{ background: '#1a2030', padding: '1px 5px', borderRadius: 3, fontSize: 13, fontFamily: 'ui-monospace, monospace' }}>{children}</code>
        },
        table: ({ children }) => (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12, fontSize: 13 }}>{children}</table>
        ),
        th: ({ children }) => (
          <th style={{ textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid #2a3545', color: '#aab', fontWeight: 600, fontSize: 12 }}>{children}</th>
        ),
        td: ({ children }) => (
          <td style={{ padding: '5px 10px', borderBottom: '1px solid #1a1f28' }}>{children}</td>
        ),
        blockquote: ({ children }) => (
          <blockquote style={{ borderLeft: '3px solid #2a3545', paddingLeft: 16, color: '#889', marginBottom: 12 }}>{children}</blockquote>
        ),
      }}
    >
      {processed}
    </ReactMarkdown>
  )
}

function InlineSectionEditor({ content, onSave, onCancel }: {
  content: string
  onSave: (newContent: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(content)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const latestValueRef = useRef(value)
  latestValueRef.current = value

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.setSelectionRange(value.length, value.length)
    }
  }, [])

  // Auto-save on blur or after debounce
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      if (latestValueRef.current !== content) {
        onSave(latestValueRef.current)
      }
    }, 800)
  }, [content, onSave])

  // Save immediately on blur
  const handleBlur = useCallback(() => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    if (latestValueRef.current !== content) {
      onSave(latestValueRef.current)
    } else {
      onCancel()
    }
  }, [content, onSave, onCancel])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    scheduleSave()
  }, [scheduleSave])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
      onCancel()
    }
  }

  // Cleanup timer on unmount
  useEffect(() => {
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [])

  return (
    <div style={{ marginTop: 8 }}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        rows={Math.max(4, value.split('\n').length + 1)}
        style={{
          width: '100%', background: '#0d0f12', border: '1px solid #2a3a4a', borderRadius: 4,
          padding: '8px 10px', color: '#c8cdd3', fontSize: 13, lineHeight: 1.6, resize: 'vertical',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', outline: 'none',
          boxSizing: 'border-box',
        }}
        onFocus={(e) => (e.currentTarget.style.borderColor = '#4a6a8a')}
      />
      <div style={{ marginTop: 4 }}>
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: '#445' }}>
          auto-saves · Esc to discard
        </span>
      </div>
    </div>
  )
}

export default function NoteViewer({ filename, onNavigate, onChanged }: Props) {
  const [note, setNote] = useState<NoteData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingSection, setEditingSection] = useState<string | null>(null)

  const loadNote = useCallback(() => {
    setError(null)
    window.api.memoryRead(filename).then((data) => {
      if (data) setNote(data as NoteData)
      else setError(`Note "${filename}" not found`)
    })
  }, [filename])

  useEffect(() => {
    loadNote()
    setEditingSection(null)
  }, [loadNote])

  const handleLinkClick = useCallback((href: string) => {
    if (href.startsWith('/memory/')) {
      const target = href.replace('/memory/', '')
      const fn = target.endsWith('.md') ? target : `${target}.md`
      onNavigate(fn)
    }
  }, [onNavigate])

  const handleSaveSection = useCallback(async (heading: string, newContent: string) => {
    if (!note) return
    try {
      await window.api.memoryEditSection({
        filename,
        heading,
        operation: 'replace',
        content: newContent,
      })
      setEditingSection(null)
      loadNote()
      onChanged?.()
    } catch (err) {
      console.error('Failed to save section:', err)
    }
  }, [filename, note, loadNote, onChanged])

  if (error) return (
    <div style={{ padding: 32, color: '#889', fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>{error}</div>
  )
  if (!note) return (
    <div style={{ padding: 32, color: '#556', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>Loading...</div>
  )

  const { preamble, sections } = parseSections(note.body)
  const isRelated = (heading: string) => heading === 'Related'

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '20px 32px' }}>
      {/* Frontmatter strip */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        {note.type && (
          <span style={{
            fontFamily: 'ui-monospace, monospace', fontSize: 10, padding: '2px 8px', borderRadius: 3,
            background: (TYPE_COLORS[note.type] ?? '#556') + '22',
            color: TYPE_COLORS[note.type] ?? '#889',
            border: `1px solid ${TYPE_COLORS[note.type] ?? '#556'}44`,
          }}>
            {note.type}
          </span>
        )}
        {note.tags.map((tag) => (
          <span key={tag} style={{
            fontFamily: 'ui-monospace, monospace', fontSize: 10, padding: '2px 6px', borderRadius: 3,
            background: '#111418', color: '#889', border: '1px solid #1e2530',
          }}>
            {tag}
          </span>
        ))}
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: '#445', marginLeft: 'auto' }}>
          {note.date}{note.modified && note.modified !== note.date ? ` (modified ${note.modified})` : ''}
        </span>
      </div>

      {/* Preamble (H1 title + summary) */}
      <div className="prose prose-invert max-w-none" style={{ color: '#c8cdd3', lineHeight: 1.7, fontSize: 14 }}>
        <MarkdownContent content={preamble} onLinkClick={handleLinkClick} />
      </div>

      {/* Sections */}
      {sections.map((section) => (
        <div key={section.heading} style={{ marginTop: 20 }}>
          {/* Section heading — clickable for non-Related sections */}
          <h2
            onClick={isRelated(section.heading) ? undefined : () => setEditingSection(
              editingSection === section.heading ? null : section.heading
            )}
            style={{
              fontSize: 16, fontWeight: 600, color: '#c0c8d0', marginBottom: 8,
              borderBottom: '1px solid #1e2530', paddingBottom: 4,
              cursor: isRelated(section.heading) ? 'default' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 8,
            }}
            onMouseEnter={(e) => { if (!isRelated(section.heading)) e.currentTarget.style.color = '#6cf' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#c0c8d0' }}
          >
            {section.heading}
            {!isRelated(section.heading) && (
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ opacity: 0.4 }}>
                <path d="M8.5 1.5l2 2M1 11l.7-2.8L9.2 .7l2 2L3.8 10.2 1 11z" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </h2>

          {editingSection === section.heading ? (
            <InlineSectionEditor
              content={section.content}
              onSave={(newContent) => handleSaveSection(section.heading, newContent)}
              onCancel={() => setEditingSection(null)}
            />
          ) : (
            <div className="prose prose-invert max-w-none" style={{ color: '#c8cdd3', lineHeight: 1.7, fontSize: 14 }}>
              <MarkdownContent content={section.content || '*empty*'} onLinkClick={handleLinkClick} />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
