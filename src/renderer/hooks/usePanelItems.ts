export interface PanelItem {
  id: string
  name: string
  description: string
  filePath: string
  content: string
  allowedTools?: string[]
}

export interface DesignItem extends PanelItem {
  brandColor: string
  previewHtmlPath: string
  previewDarkHtmlPath: string
}

/**
 * Extract brand accent color from DESIGN.md "Key Characteristics" section.
 * Looks for backtick-wrapped hex color codes.
 */
export function extractBrandColor(designMd: string): string {
  const keyCharsMatch = designMd.match(/Key Characteristics[\s\S]*?(?=\n## |\n$)/i)
  if (keyCharsMatch) {
    const hexMatch = keyCharsMatch[0].match(/`(#[0-9a-fA-F]{6})`/)
    if (hexMatch) return hexMatch[1]
  }
  // Fallback: first hex color in the entire file
  const fallback = designMd.match(/`(#[0-9a-fA-F]{6})`/)
  return fallback ? fallback[1] : '#888888'
}

/**
 * Extract name and description from a markdown file.
 * Name comes from the first H1, description from the first paragraph after it.
 */
export function parseMarkdownMeta(content: string): { name: string; description: string } {
  let name = ''
  let description = ''

  // Try YAML frontmatter first (between --- delimiters)
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (fmMatch) {
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m)
    const descMatch = fmMatch[1].match(/^description:\s*"?(.+?)"?\s*$/m)
    if (nameMatch) name = nameMatch[1].trim()
    if (descMatch) description = descMatch[1].trim()
  }

  // Fall back to H1 + first paragraph
  if (!name || !description) {
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!name && line.startsWith('# ')) {
        name = line.slice(2).trim()
        continue
      }
      if (name && !description && line && !line.startsWith('#') && !line.startsWith('---')) {
        description = line
        break
      }
    }
  }

  return { name: name || 'Untitled', description }
}
