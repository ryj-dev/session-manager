import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { projectColor, projectColorDim } from '../../lib/simulation'
import type { Todo, TagCount } from './types'
import { isProjectTag, projectFromTag } from './types'
import { TagChip } from './TagChip'

interface Props {
  todo: Todo
  allTags: TagCount[]
  /** Project tags inferred from currently-open sessions; merged with allTags for the project picker. */
  activeProjectTags: string[]
  onUpdate: (patch: { title?: string; body?: string; done?: boolean; tags?: string[] }) => void
  onDelete: () => void
  onClose: () => void
}

export function TodoDetail({ todo, allTags, activeProjectTags, onUpdate, onDelete, onClose }: Props): JSX.Element {
  const [title, setTitle] = useState(todo.title)
  const [body, setBody] = useState(todo.body)
  const [tagInput, setTagInput] = useState('')
  const [addingTag, setAddingTag] = useState(false)
  const tagInputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  // Auto-size the body textarea to its content so the entire detail pane scrolls.
  const resizeBody = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  useEffect(() => { resizeBody() }, [body, todo.id, resizeBody])

  // Reset local state when switching todo
  useEffect(() => {
    setTitle(todo.title)
    setBody(todo.body)
    setTagInput('')
    setAddingTag(false)
  }, [todo.id])

  // Persist on blur (avoid IPC chatter on every keystroke)
  const persistTitle = useCallback(() => {
    if (title !== todo.title) onUpdate({ title })
  }, [title, todo.title, onUpdate])
  const persistBody = useCallback(() => {
    if (body !== todo.body) onUpdate({ body })
  }, [body, todo.body, onUpdate])

  const handleAddTag = useCallback((tag: string) => {
    const clean = tag.trim()
    if (!clean) return
    if (todo.tags.includes(clean)) {
      setTagInput('')
      setAddingTag(false)
      return
    }
    onUpdate({ tags: [...todo.tags, clean] })
    setTagInput('')
    setAddingTag(false)
  }, [todo.tags, onUpdate])

  const handleRemoveTag = useCallback((tag: string) => {
    onUpdate({ tags: todo.tags.filter((t) => t !== tag) })
  }, [todo.tags, onUpdate])

  // Project = single project tag (or none). Stored as `project:<name>` in tags.
  const currentProjectTag = useMemo(() => todo.tags.find(isProjectTag) ?? null, [todo.tags])
  const knownProjectTags = useMemo(() => {
    const merged = new Set<string>()
    for (const t of allTags) if (isProjectTag(t.tag)) merged.add(t.tag)
    for (const t of activeProjectTags) merged.add(t)
    return [...merged].sort((a, b) => a.localeCompare(b))
  }, [allTags, activeProjectTags])

  const handleSetProject = useCallback((tag: string | null) => {
    const remaining = todo.tags.filter((t) => !isProjectTag(t))
    const next = tag ? [tag, ...remaining] : remaining
    onUpdate({ tags: next })
  }, [todo.tags, onUpdate])

  useEffect(() => {
    if (addingTag) tagInputRef.current?.focus()
  }, [addingTag])

  // Non-project tags only (project is its own field).
  const nonProjectTags = todo.tags.filter((t) => !isProjectTag(t))
  const suggestions = tagInput.trim()
    ? allTags
        .filter((t) => !isProjectTag(t.tag)
          && t.tag.toLowerCase().includes(tagInput.toLowerCase())
          && !todo.tags.includes(t.tag))
        .slice(0, 6)
    : []

  const created = new Date(todo.created)
  const breadcrumb = `${created.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`

  return (
    <aside style={{
      display: 'flex', flexDirection: 'column',
      background: 'var(--todos-surface)',
      height: '100%',
      minWidth: 0, minHeight: 0,
    }}>
      <header className="titlebar-drag" style={{
        padding: '14px 20px',
        borderBottom: '1px solid var(--todos-border)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span className="titlebar-no-drag" style={{ fontSize: 11, color: 'var(--todos-text-faint)' }}>
          Created {breadcrumb}
        </span>
        <button
          className="titlebar-no-drag"
          onClick={onDelete}
          title="Delete todo"
          style={{ marginLeft: 'auto', color: 'var(--todos-text-faint)', fontSize: 12 }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--todos-danger)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--todos-text-faint)' }}
        >
          Delete
        </button>
        <button
          className="titlebar-no-drag"
          onClick={onClose}
          title="Close detail"
          style={{ color: 'var(--todos-text-faint)' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--todos-text)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--todos-text-faint)' }}
        >
          ✕
        </button>
      </header>

      <div className="todos-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={persistTitle}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          placeholder="Title"
          style={{
            width: '100%',
            fontSize: 20,
            fontWeight: 600,
            lineHeight: 1.3,
            padding: '4px 0',
          }}
        />

        <div style={{
          marginTop: 16,
          display: 'grid',
          gridTemplateColumns: '80px 1fr',
          rowGap: 10,
          columnGap: 12,
          alignItems: 'center',
        }}>
          <div style={{ fontSize: 12, color: 'var(--todos-text-faint)' }}>Status</div>
          <div>
            <button
              onClick={() => onUpdate({ done: !todo.done })}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '3px 8px',
                borderRadius: 999,
                background: 'var(--todos-chip-bg)',
                color: todo.done ? 'var(--todos-done)' : 'var(--todos-text-dim)',
                fontSize: 12,
              }}
            >
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: todo.done ? 'var(--todos-done)' : 'var(--todos-text-faint)',
              }} />
              {todo.done ? 'Completed' : 'Open'}
            </button>
          </div>

          <div style={{ fontSize: 12, color: 'var(--todos-text-faint)' }}>Project</div>
          <div>
            <ProjectPicker
              currentTag={currentProjectTag}
              knownTags={knownProjectTags}
              onSelect={handleSetProject}
            />
          </div>

          <div style={{ fontSize: 12, color: 'var(--todos-text-faint)' }}>Tags</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', position: 'relative' }}>
            {nonProjectTags.map((tag) => (
              <TagChip
                key={tag}
                tag={tag}
                onRemove={() => handleRemoveTag(tag)}
                size="md"
              />
            ))}
            {addingTag ? (
              <div style={{ position: 'relative' }}>
                <input
                  ref={tagInputRef}
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddTag(tagInput)
                    else if (e.key === 'Escape') { setTagInput(''); setAddingTag(false) }
                  }}
                  onBlur={() => setTimeout(() => { setAddingTag(false); setTagInput('') }, 150)}
                  placeholder="tag name"
                  style={{
                    height: 22, padding: '0 8px', borderRadius: 4,
                    border: '1px solid var(--todos-border-strong)',
                    fontSize: 11,
                    width: 140,
                  }}
                />
                {suggestions.length > 0 && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, marginTop: 4,
                    background: 'var(--todos-surface-2)',
                    border: '1px solid var(--todos-border)',
                    borderRadius: 6,
                    padding: 4,
                    minWidth: 180,
                    zIndex: 10,
                    boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
                  }}>
                    {suggestions.map((s) => (
                      <button
                        key={s.tag}
                        onMouseDown={(e) => { e.preventDefault(); handleAddTag(s.tag) }}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          width: '100%', padding: '5px 8px',
                          borderRadius: 4, fontSize: 12,
                          color: 'var(--todos-text-dim)',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--todos-surface)'; e.currentTarget.style.color = 'var(--todos-text)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--todos-text-dim)' }}
                      >
                        <span>{isProjectTag(s.tag) ? projectFromTag(s.tag) : s.tag}</span>
                        <span style={{ fontSize: 10, color: 'var(--todos-text-faint)' }}>{s.count}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={() => setAddingTag(true)}
                style={{
                  display: 'inline-flex', alignItems: 'center',
                  height: 22, padding: '0 8px', borderRadius: 4,
                  border: '1px dashed var(--todos-border-strong)',
                  color: 'var(--todos-text-faint)', fontSize: 11,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--todos-text-dim)'; e.currentTarget.style.borderColor = 'var(--todos-text-faint)' }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--todos-text-faint)'; e.currentTarget.style.borderColor = 'var(--todos-border-strong)' }}
              >
                + add tag
              </button>
            )}
          </div>
        </div>

        <div style={{
          marginTop: 24, marginBottom: 8,
          fontSize: 12, color: 'var(--todos-text-faint)',
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>Details</div>
        <textarea
          ref={bodyRef}
          value={body}
          onChange={(e) => { setBody(e.target.value); resizeBody() }}
          onBlur={persistBody}
          placeholder="Add details, links, code snippets…"
          rows={1}
          style={{
            width: '100%',
            fontSize: 13, lineHeight: 1.6,
            color: 'var(--todos-text)',
            resize: 'none',
            overflow: 'hidden',
            fontFamily: 'inherit',
          }}
        />
      </div>
    </aside>
  )
}

function ProjectPicker({
  currentTag, knownTags, onSelect,
}: {
  currentTag: string | null
  knownTags: string[]
  onSelect: (tag: string | null) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const currentName = currentTag ? projectFromTag(currentTag) : null

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 22,
          padding: '0 8px',
          borderRadius: 4,
          background: currentTag ? projectColorDim(currentName ?? '') : 'transparent',
          color: currentTag ? projectColor(currentName ?? '') : 'var(--todos-text-faint)',
          border: currentTag ? '1px solid transparent' : '1px dashed var(--todos-border-strong)',
          fontSize: 11,
        }}
      >
        {currentTag ? currentName : '+ assign project'}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ opacity: 0.6 }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4,
          background: 'var(--todos-surface-2)',
          border: '1px solid var(--todos-border)',
          borderRadius: 6,
          padding: 4,
          minWidth: 200,
          zIndex: 10,
          boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
        }}>
          <PickerRow
            label="No project"
            dotColor="var(--todos-text-faint)"
            active={currentTag === null}
            onClick={() => { onSelect(null); setOpen(false) }}
          />
          {knownTags.length > 0 && <Divider />}
          {knownTags.map((tag) => {
            const name = projectFromTag(tag)
            return (
              <PickerRow
                key={tag}
                label={name}
                dotColor={projectColor(name)}
                active={currentTag === tag}
                onClick={() => { onSelect(tag); setOpen(false) }}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function PickerRow({
  label, dotColor, active, onClick,
}: { label: string; dotColor: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      onMouseDown={(e) => { e.preventDefault(); onClick() }}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', padding: '5px 8px',
        borderRadius: 4, fontSize: 12,
        color: active ? 'var(--todos-text)' : 'var(--todos-text-dim)',
        background: active ? 'var(--todos-surface)' : 'transparent',
      }}
      onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = 'var(--todos-surface)'; e.currentTarget.style.color = 'var(--todos-text)' } }}
      onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--todos-text-dim)' } }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
      <span>{label}</span>
    </button>
  )
}

function Divider(): JSX.Element {
  return <div style={{ height: 1, background: 'var(--todos-border)', margin: '4px 0' }} />
}
