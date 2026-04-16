/**
 * Pure types, constants, and string-manipulation functions for memory notes.
 * No electron imports, no fs imports — safe to import from both main process and MCP server.
 */

import matter from 'gray-matter'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface MemoryNote {
  filename: string
  title: string
  type: string
  tags: string[]
  date: string
  modified: string
  body: string
  rawBody: string
  wikilinks: string[]
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export interface NoteInput {
  title: string
  type?: NoteType
  tags?: string[]
  summary?: string
  context?: string
  details?: string
  outcome?: string
}

// ─── Constants ─────────────────────────────────────────────────────────────

export const NOTE_TYPES = [
  'project',
  'decision',
  'context',
  'reference',
  'session-log',
  'user',
  'feedback',
] as const

export type NoteType = (typeof NOTE_TYPES)[number]

export const SECTION_ORDER = ['Context', 'Details', 'Outcome', 'Related'] as const
export type SectionName = (typeof SECTION_ORDER)[number]

export const TYPE_SECTIONS: Record<NoteType, SectionName[]> = {
  project:       ['Context', 'Details', 'Related'],
  decision:      ['Context', 'Details', 'Outcome', 'Related'],
  context:       ['Details', 'Related'],
  reference:     ['Details', 'Related'],
  'session-log': ['Context', 'Outcome', 'Related'],
  user:          ['Details', 'Related'],
  feedback:      ['Context', 'Details', 'Related'],
}

const SECTION_ORDER_MAP: Record<string, number> = {
  Context: 0,
  Details: 1,
  Outcome: 2,
  Related: 3,
}

// ─── Parsing ───────────────────────────────────────────────────────────────

export function formatDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().split('T')[0]
  if (typeof value === 'string') return value
  return ''
}

export function extractWikilinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]]+)\]\]/g)
  return [...new Set([...matches].map((m) => m[1]))]
}

export function parseRawNote(filename: string, raw: string): MemoryNote {
  const { data, content } = matter(raw)
  return {
    filename,
    title: typeof data.title === 'string' ? data.title : filename.replace(/\.md$/, ''),
    type: typeof data.type === 'string' ? data.type : '',
    tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
    date: formatDate(data.date),
    modified: formatDate(data.modified),
    body: content,
    rawBody: raw,
    wikilinks: extractWikilinks(content)
  }
}

export function buildRawBody(
  frontmatter: Record<string, unknown>,
  body: string
): string {
  return matter.stringify(body, frontmatter)
}

// ─── Validation ────────────────────────────────────────────────────────────

export function validateNote(rawBody: string): ValidationResult {
  const errors: string[] = []

  let data: Record<string, unknown>
  try {
    const parsed = matter(rawBody)
    data = parsed.data
  } catch {
    return { valid: false, errors: ['Invalid YAML frontmatter'] }
  }

  if (!data.title || typeof data.title !== 'string') {
    errors.push('Missing or invalid "title" in frontmatter')
  }

  if (!data.date) {
    errors.push('Missing "date" in frontmatter')
  }

  if (data.type && typeof data.type === 'string' && !(NOTE_TYPES as readonly string[]).includes(data.type)) {
    errors.push(`Invalid type "${data.type}". Valid types: ${NOTE_TYPES.join(', ')}`)
  }

  if (data.tags && !Array.isArray(data.tags)) {
    errors.push('"tags" must be an array')
  }

  return { valid: errors.length === 0, errors }
}

export function sanitize(input: string): string {
  return input
    .replace(/^---$/gm, '\\---')
    .replace(/^(#{1,2})\s/gm, '\\$1 ')
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return slug ? `${slug}.md` : `note-${Date.now()}.md`
}

// ─── Section editing ───────────────────────────────────────────────────────

export function insertSectionInOrder(rawBody: string, sectionName: string, content: string): string {
  const lines = rawBody.split('\n')
  const sectionHeader = `## ${sectionName}`
  const orderIndex = SECTION_ORDER_MAP[sectionName] ?? 99

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('## ')) continue
    const existingName = lines[i].replace(/^## /, '').trim()
    const existingOrder = SECTION_ORDER_MAP[existingName] ?? 99
    if (existingOrder > orderIndex) {
      lines.splice(i, 0, sectionHeader, '', content, '', '')
      return lines.join('\n')
    }
  }

  const trimmed = rawBody.trimEnd()
  return `${trimmed}\n\n${sectionHeader}\n\n${content}\n`
}

export function appendToSection(rawBody: string, sectionName: string, content: string): string {
  const lines = rawBody.split('\n')
  const sectionHeader = `## ${sectionName}`
  const sectionIdx = lines.findIndex((l) => l.trim() === sectionHeader)

  if (sectionIdx !== -1) {
    let endIdx = lines.length
    for (let i = sectionIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) { endIdx = i; break }
    }
    lines.splice(endIdx, 0, content)
    return lines.join('\n')
  }

  return insertSectionInOrder(rawBody, sectionName, content)
}

export function replaceSectionContent(rawBody: string, sectionName: string, newContent: string): string {
  const lines = rawBody.split('\n')
  const sectionHeader = `## ${sectionName}`
  const sectionIdx = lines.findIndex((l) => l.trim() === sectionHeader)

  if (sectionIdx === -1) {
    return insertSectionInOrder(rawBody, sectionName, newContent)
  }

  let endIdx = lines.length
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { endIdx = i; break }
  }

  const before = lines.slice(0, sectionIdx + 1)
  const after = lines.slice(endIdx)

  return [...before, '', newContent, '', ...after].join('\n')
}

export function prependToSection(rawBody: string, sectionName: string, content: string): string {
  const lines = rawBody.split('\n')
  const sectionHeader = `## ${sectionName}`
  const sectionIdx = lines.findIndex((l) => l.trim() === sectionHeader)

  if (sectionIdx === -1) {
    return insertSectionInOrder(rawBody, sectionName, content)
  }

  let insertAt = sectionIdx + 1
  while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++

  lines.splice(insertAt, 0, content)
  return lines.join('\n')
}

// ─── Note generation ───────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function shouldIncludeSection(section: SectionName, recommended: SectionName[], content?: string): boolean {
  if (section === 'Related') return true
  if (content) return true
  return recommended.includes(section)
}

export function generateNote(input: NoteInput): string {
  const date = today()
  const type: NoteType = input.type || 'context'
  const frontmatter: Record<string, unknown> = {
    title: input.title,
    type,
    tags: input.tags || [],
    date,
    modified: date,
  }

  const recommendedSections = TYPE_SECTIONS[type]
  const lines: string[] = []

  lines.push(`# ${input.title}`)
  lines.push('')

  if (input.summary) {
    lines.push(input.summary)
    lines.push('')
  }

  if (shouldIncludeSection('Context', recommendedSections, input.context)) {
    lines.push('## Context')
    lines.push('')
    if (input.context) { lines.push(input.context); lines.push('') }
  }

  if (shouldIncludeSection('Details', recommendedSections, input.details)) {
    lines.push('## Details')
    lines.push('')
    if (input.details) { lines.push(input.details); lines.push('') }
  }

  if (shouldIncludeSection('Outcome', recommendedSections, input.outcome)) {
    lines.push('## Outcome')
    lines.push('')
    if (input.outcome) { lines.push(input.outcome); lines.push('') }
  }

  lines.push('## Related')
  lines.push('')

  return buildRawBody(frontmatter, '\n' + lines.join('\n'))
}

export function touchModified(rawBody: string): string {
  const date = today()
  const fmMatch = rawBody.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) return rawBody

  const fmContent = fmMatch[1]
  const fmStart = 4
  const fmEnd = fmStart + fmContent.length

  if (/^modified:\s*.+$/m.test(fmContent)) {
    const updatedFm = fmContent.replace(/^modified:\s*.+$/m, `modified: '${date}'`)
    return rawBody.slice(0, fmStart) + updatedFm + rawBody.slice(fmEnd)
  }
  const closingIdx = fmStart + fmContent.length
  return rawBody.slice(0, closingIdx) + `\nmodified: '${date}'` + rawBody.slice(closingIdx)
}

// ─── Backlink string operations ────────────────────────────────────────────

export function filenameToWikilink(filename: string): string {
  return filename.replace(/\.md$/, '')
}

export function addToRelatedSection(rawBody: string, wikilink: string): string {
  const entry = `- [[${wikilink}]]`
  const sectionRegex = /^## Related\s*$/m

  if (sectionRegex.test(rawBody)) {
    const lines = rawBody.split('\n')
    const idx = lines.findIndex((l) => /^## Related\s*$/.test(l))

    // Find end of Related section
    let endIdx = lines.length
    for (let i = idx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) { endIdx = i; break }
    }

    // Only check for duplicates within the Related section
    const relatedLines = lines.slice(idx, endIdx)
    if (relatedLines.some((l) => l.includes(`[[${wikilink}]]`))) return rawBody

    let insertAt = idx + 1
    for (let i = idx + 1; i < endIdx; i++) {
      if (lines[i].trim()) insertAt = i + 1
    }
    lines.splice(insertAt, 0, entry)
    return lines.join('\n')
  }

  return `${rawBody.trimEnd()}\n\n## Related\n\n${entry}\n`
}

export function removeFromRelatedSection(rawBody: string, wikilink: string): string {
  const lines = rawBody.split('\n')
  const relatedIdx = lines.findIndex((l) => /^## Related\s*$/.test(l))
  if (relatedIdx === -1) return rawBody

  let endIdx = lines.length
  for (let i = relatedIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { endIdx = i; break }
  }

  const before = lines.slice(0, relatedIdx + 1)
  const section = lines.slice(relatedIdx + 1, endIdx).filter((l) => l.trim() !== `- [[${wikilink}]]`)
  const after = lines.slice(endIdx)
  return [...before, ...section, ...after].join('\n')
}
