/**
 * Note editor — structured section inputs with frontmatter form fields.
 */

import { useState, useEffect, useCallback } from 'react'

interface NoteData {
  filename: string
  title: string
  type: string
  tags: string[]
  date: string
  modified: string
  body: string
}

const NOTE_TYPES = ['project', 'decision', 'context', 'reference', 'session-log', 'user', 'feedback']

/** Extract section content from a markdown body by ## heading name. */
function extractSection(body: string, heading: string): string {
  const lines = body.split('\n')
  const header = `## ${heading}`
  const idx = lines.findIndex((l) => l.trim() === header)
  if (idx === -1) return ''

  let endIdx = lines.length
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { endIdx = i; break }
  }

  return lines.slice(idx + 1, endIdx).join('\n').trim()
}

/** Extract summary — text between H1 and first ## section. */
function extractSummary(body: string): string {
  const lines = body.split('\n')
  const h1Idx = lines.findIndex((l) => l.startsWith('# '))
  if (h1Idx === -1) return ''

  const summaryLines: string[] = []
  for (let i = h1Idx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) break
    summaryLines.push(lines[i])
  }
  return summaryLines.join('\n').trim()
}

interface Props {
  filename: string | null // null = new note
  onSave: () => void
  onCancel: () => void
}

function SectionField({ label, value, onChange, rows }: {
  label: string; value: string; onChange: (v: string) => void; rows?: number
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: '#667', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </label>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows ?? 4}
        style={{
          background: '#0d0f12', border: '1px solid #1e2530', borderRadius: 4, resize: 'vertical',
          padding: '8px 10px', color: '#c8cdd3', fontSize: 13, lineHeight: 1.6,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', outline: 'none',
        }}
        onFocus={(e) => (e.currentTarget.style.borderColor = '#3a4a5a')}
        onBlur={(e) => (e.currentTarget.style.borderColor = '#1e2530')}
      />
    </div>
  )
}

export default function NoteEditor({ filename, onSave, onCancel }: Props) {
  const [title, setTitle] = useState('')
  const [type, setType] = useState('context')
  const [tagsInput, setTagsInput] = useState('')
  const [summary, setSummary] = useState('')
  const [context, setContext] = useState('')
  const [details, setDetails] = useState('')
  const [outcome, setOutcome] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load existing note into structured fields
  useEffect(() => {
    if (!filename) return
    window.api.memoryRead(filename).then((data) => {
      if (!data) return
      const note = data as NoteData
      setTitle(note.title)
      setType(note.type || 'context')
      setTagsInput(note.tags.join(', '))
      setSummary(extractSummary(note.body))
      setContext(extractSection(note.body, 'Context'))
      setDetails(extractSection(note.body, 'Details'))
      setOutcome(extractSection(note.body, 'Outcome'))
    })
  }, [filename])

  const handleSave = useCallback(async () => {
    if (!title.trim()) { setError('Title is required'); return }
    setSaving(true)
    setError(null)

    try {
      const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean)

      if (filename) {
        // Update existing — rebuild full body from sections
        const sections: string[] = [`# ${title.trim()}`, '']
        if (summary.trim()) { sections.push(summary.trim(), '') }
        if (context.trim()) { sections.push('## Context', '', context.trim(), '') }
        if (details.trim()) { sections.push('## Details', '', details.trim(), '') }
        if (outcome.trim()) { sections.push('## Outcome', '', outcome.trim(), '') }
        sections.push('## Related', '')

        // Read existing Related section to preserve it
        const existing = await window.api.memoryRead(filename) as NoteData | null
        if (existing) {
          const relatedContent = extractSection(existing.body, 'Related')
          if (relatedContent) sections.push(relatedContent, '')
        }

        await window.api.memoryUpdate({
          filename,
          frontmatter: { title: title.trim(), type, tags },
          body: '\n' + sections.join('\n'),
        })
      } else {
        // Create new
        await window.api.memoryCreate({
          title: title.trim(),
          type,
          tags,
          summary: summary.trim() || undefined,
          context: context.trim() || undefined,
          details: details.trim() || undefined,
          outcome: outcome.trim() || undefined,
        })
      }
      onSave()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [filename, title, type, tagsInput, summary, context, details, outcome, onSave])

  // Which sections to show based on type
  const showContext = ['project', 'decision', 'session-log', 'feedback'].includes(type) || !!context
  const showDetails = ['project', 'decision', 'context', 'reference', 'user', 'feedback'].includes(type) || !!details
  const showOutcome = ['decision', 'session-log'].includes(type) || !!outcome

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Frontmatter form */}
      <div style={{
        padding: '12px 20px', borderBottom: '1px solid #1a1f28',
        display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Note title..."
            style={{
              flex: 1, background: '#111418', border: '1px solid #1e2530', borderRadius: 4,
              padding: '6px 10px', color: '#e0e0e0', fontSize: 14, fontWeight: 600, outline: 'none',
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = '#3a4a5a')}
            onBlur={(e) => (e.currentTarget.style.borderColor = '#1e2530')}
          />
          <select value={type} onChange={(e) => setType(e.target.value)}
            style={{
              background: '#111418', border: '1px solid #1e2530', borderRadius: 4,
              padding: '6px 8px', color: '#889', fontSize: 12, outline: 'none', cursor: 'pointer',
            }}>
            {NOTE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="Tags (comma-separated)..."
          style={{
            background: '#111418', border: '1px solid #1e2530', borderRadius: 4,
            padding: '5px 10px', color: '#889', fontSize: 12, fontFamily: 'ui-monospace, monospace', outline: 'none',
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = '#3a4a5a')}
          onBlur={(e) => (e.currentTarget.style.borderColor = '#1e2530')}
        />
      </div>

      {/* Structured section editors */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SectionField label="Summary" value={summary} onChange={setSummary} rows={2} />
        {showContext && <SectionField label="Context" value={context} onChange={setContext} />}
        {showDetails && <SectionField label="Details" value={details} onChange={setDetails} rows={8} />}
        {showOutcome && <SectionField label="Outcome" value={outcome} onChange={setOutcome} />}
      </div>

      {/* Actions */}
      <div style={{
        padding: '10px 20px', borderTop: '1px solid #1a1f28',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0,
      }}>
        <div>
          {error && <span style={{ color: '#e04040', fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>{error}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCancel} style={{
            background: 'none', border: '1px solid #2a3545', borderRadius: 4,
            padding: '6px 14px', cursor: 'pointer', color: '#889',
            fontFamily: 'ui-monospace, monospace', fontSize: 12,
          }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving} style={{
            background: '#1a2530', border: '1px solid #3a4a5a', borderRadius: 4,
            padding: '6px 14px', cursor: 'pointer', color: '#6cf',
            fontFamily: 'ui-monospace, monospace', fontSize: 12,
            opacity: saving ? 0.6 : 1,
          }}>
            {saving ? 'Saving...' : filename ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
