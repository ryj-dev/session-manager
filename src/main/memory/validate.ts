/**
 * Note validation and sanitization.
 * Re-exports from core.ts — this file exists for backward compatibility.
 */

export {
  type ValidationResult,
  type NoteType,
  type SectionName,
  NOTE_TYPES,
  SECTION_ORDER,
  TYPE_SECTIONS,
  validateNote,
  sanitize,
  slugify,
} from './core'
