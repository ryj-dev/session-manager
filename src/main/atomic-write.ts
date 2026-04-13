/**
 * Atomic file write — prevents corruption if the app crashes mid-write.
 * Writes to a temp file first, then renames (atomic on same filesystem).
 */

import { writeFileSync, renameSync } from 'fs'

export function atomicWriteSync(filePath: string, data: string, encoding: BufferEncoding = 'utf-8'): void {
  const tmp = filePath + '.tmp'
  writeFileSync(tmp, data, encoding)
  renameSync(tmp, filePath)
}
