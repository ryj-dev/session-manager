/**
 * Note generation and section editing helpers.
 * Adapted from tc-sql-atlas note-templates.ts.
 */

import { buildRawBody } from './store'
import { TYPE_SECTIONS, type NoteType, type SectionName } from './validate'

const TODAY = (): string => new Date().toISOString().split('T')[0]

export interface NoteInput {
  title: string
  type?: NoteType
  tags?: string[]
  summary?: string
  context?: string
  details?: string
  outcome?: string
}

/**
 * Generate a new memory note with rigid section structure.
 * Sections are included based on the note type's recommended sections,
 * plus any sections that have content provided.
 */
export function generateNote(input: NoteInput): string {
  const date = TODAY()
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

  // H1 title
  lines.push(`# ${input.title}`)
  lines.push('')

  // Summary (always present — even if empty placeholder)
  if (input.summary) {
    lines.push(input.summary)
    lines.push('')
  }

  // Sections based on type + provided content
  if (shouldInclude('Context', recommendedSections, input.context)) {
    lines.push('## Context')
    lines.push('')
    if (input.context) { lines.push(input.context); lines.push('') }
  }

  if (shouldInclude('Details', recommendedSections, input.details)) {
    lines.push('## Details')
    lines.push('')
    if (input.details) { lines.push(input.details); lines.push('') }
  }

  if (shouldInclude('Outcome', recommendedSections, input.outcome)) {
    lines.push('## Outcome')
    lines.push('')
    if (input.outcome) { lines.push(input.outcome); lines.push('') }
  }

  // Related is always present
  lines.push('## Related')
  lines.push('')

  return buildRawBody(frontmatter, '\n' + lines.join('\n'))
}

function shouldInclude(section: SectionName, recommended: SectionName[], content?: string): boolean {
  if (section === 'Related') return true
  if (content) return true
  return recommended.includes(section)
}

/**
 * Update the `modified` date in frontmatter of a raw note body.
 */
export function touchModified(rawBody: string): string {
  const date = TODAY()
  // Only match `modified:` within frontmatter (between the two `---` delimiters)
  const fmMatch = rawBody.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) return rawBody

  const fmContent = fmMatch[1]
  const fmStart = 4 // length of '---\n'
  const fmEnd = fmStart + fmContent.length

  if (/^modified:\s*.+$/m.test(fmContent)) {
    const updatedFm = fmContent.replace(/^modified:\s*.+$/m, `modified: '${date}'`)
    return rawBody.slice(0, fmStart) + updatedFm + rawBody.slice(fmEnd)
  }
  // No modified field — insert before the closing ---
  const closingIdx = fmStart + fmContent.length
  return rawBody.slice(0, closingIdx) + `\nmodified: '${date}'` + rawBody.slice(closingIdx)
}

/**
 * Append content to a specific ## section.
 * If the section doesn't exist, creates it in the correct position
 * relative to the canonical section order.
 */
export function appendToSection(
  rawBody: string,
  sectionName: string,
  content: string
): string {
  const lines = rawBody.split('\n')
  const sectionHeader = `## ${sectionName}`
  const sectionIdx = lines.findIndex((l) => l.trim() === sectionHeader)

  if (sectionIdx !== -1) {
    // Section exists — find end and insert before it
    let endIdx = lines.length
    for (let i = sectionIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) { endIdx = i; break }
    }
    lines.splice(endIdx, 0, content)
    return lines.join('\n')
  }

  // Section doesn't exist — insert in canonical order
  return insertSectionInOrder(rawBody, sectionName, content)
}

/**
 * Replace the content of a specific ## section entirely.
 */
export function replaceSectionContent(
  rawBody: string,
  sectionName: string,
  newContent: string
): string {
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

/**
 * Prepend content to a specific ## section (after the header).
 */
export function prependToSection(
  rawBody: string,
  sectionName: string,
  content: string
): string {
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

/**
 * Insert a new section in the canonical order (Context → Details → Outcome → Related).
 * Places it before the first section that comes after it in the order,
 * or before ## Related if none found.
 */
function insertSectionInOrder(rawBody: string, sectionName: string, content: string): string {
  const lines = rawBody.split('\n')
  const sectionHeader = `## ${sectionName}`

  // Find position in canonical order
  const orderIndex = SECTION_ORDER_MAP[sectionName] ?? 99

  // Find the first existing section that comes after this one in the order
  let insertBeforeIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('## ')) continue
    const existingName = lines[i].replace(/^## /, '').trim()
    const existingOrder = SECTION_ORDER_MAP[existingName] ?? 99
    if (existingOrder > orderIndex) {
      insertBeforeIdx = i
      break
    }
  }

  if (insertBeforeIdx !== -1) {
    lines.splice(insertBeforeIdx, 0, sectionHeader, '', content, '', '')
    return lines.join('\n')
  }

  // No later section found — append before end
  const trimmed = rawBody.trimEnd()
  return `${trimmed}\n\n${sectionHeader}\n\n${content}\n`
}

const SECTION_ORDER_MAP: Record<string, number> = {
  Context: 0,
  Details: 1,
  Outcome: 2,
  Related: 3,
}
