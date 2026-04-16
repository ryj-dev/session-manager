/**
 * Atomic file write — prevents corruption if the app crashes mid-write.
 * Writes to a temp file first, then renames (atomic on same filesystem).
 */

import { writeFileSync, renameSync, unlinkSync } from 'fs'

export function atomicWriteSync(filePath: string, data: string, encoding: BufferEncoding = 'utf-8'): void {
  const tmp = filePath + '.tmp'
  writeFileSync(tmp, data, encoding)
  try {
    renameSync(tmp, filePath)
  } catch {
    // On Windows, rename can fail if the target is locked by another process.
    // Fall back to direct overwrite (not atomic but avoids data loss).
    writeFileSync(filePath, data, encoding)
    try { unlinkSync(tmp) } catch { /* best-effort cleanup */ }
  }
}
