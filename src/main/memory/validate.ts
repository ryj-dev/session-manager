/**
 * Note validation and sanitization.
 * Adapted from tc-sql-atlas validate.ts.
 */

import matter from 'gray-matter'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

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

/** Canonical section order. Related is always last and auto-managed. */
export const SECTION_ORDER = ['Context', 'Details', 'Outcome', 'Related'] as const
export type SectionName = (typeof SECTION_ORDER)[number]

/** Which sections are recommended per note type (not enforced, but used by templates). */
export const TYPE_SECTIONS: Record<NoteType, SectionName[]> = {
  project:       ['Context', 'Details', 'Related'],
  decision:      ['Context', 'Details', 'Outcome', 'Related'],
  context:       ['Details', 'Related'],
  reference:     ['Details', 'Related'],
  'session-log': ['Context', 'Outcome', 'Related'],
  user:          ['Details', 'Related'],
  feedback:      ['Context', 'Details', 'Related'],
}

/**
 * Validate a raw markdown note body (with frontmatter).
 */
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

/**
 * Sanitize user-provided content to prevent markdown structure injection.
 */
export function sanitize(input: string): string {
  return input
    .replace(/^---$/gm, '\\---')
    .replace(/^(#{1,2})\s/gm, '\\$1 ')
}

/**
 * Slugify a title into a valid filename.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return slug ? `${slug}.md` : `note-${Date.now()}.md`
}
