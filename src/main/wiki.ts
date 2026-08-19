/**
 * Read-only loader for the bundled feature wiki (docs/wiki/*.md in the repo,
 * resources/wiki in the packaged app). The wiki is product documentation —
 * versioned with the app and authoritative — deliberately separate from the
 * per-user memory knowledge base.
 *
 * Used by both the main process (embed indexing) and the standalone MCP
 * server (list/read/search tools).
 */

import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'

export const WIKI_KEY_PREFIX = 'wiki:'

export interface WikiArticle {
  slug: string
  title: string
  summary: string
  related: string[]
  /** Article markdown without frontmatter. */
  body: string
}

/** Resolve the wiki directory for the running app (main process only). */
export function resolveAppWikiDir(appPath: string, isPackaged: boolean, resourcesPath: string): string {
  return isPackaged ? path.join(resourcesPath, 'wiki') : path.join(appPath, 'docs', 'wiki')
}

function parseArticle(dir: string, filename: string): WikiArticle | null {
  try {
    const raw = fs.readFileSync(path.join(dir, filename), 'utf-8')
    const { data, content } = matter(raw)
    const slug = filename.replace(/\.md$/, '')
    return {
      slug,
      title: typeof data.title === 'string' ? data.title : slug,
      summary: typeof data.summary === 'string' ? data.summary : '',
      related: Array.isArray(data.related) ? data.related.map(String) : [],
      body: content.trim(),
    }
  } catch (err) {
    // Loud, not silent: a YAML frontmatter typo once made an article invisible
    // to every wiki tool with no trace. Returning null still keeps the rest of
    // the wiki serving.
    console.warn(`[wiki] failed to parse ${filename} — article will be missing from the wiki:`, err instanceof Error ? err.message : err)
    return null
  }
}

/** List all wiki articles (README index excluded). */
export function listWikiArticles(dir: string): WikiArticle[] {
  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }
  return files
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort()
    .map((f) => parseArticle(dir, f))
    .filter((a): a is WikiArticle => a !== null)
}

/** Read one article by slug (filename without .md). */
export function readWikiArticle(dir: string, slug: string): WikiArticle | null {
  const clean = slug.replace(/\.md$/, '')
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(clean)) return null
  if (!fs.existsSync(path.join(dir, `${clean}.md`))) return null
  return parseArticle(dir, `${clean}.md`)
}

/** Embedding corpus for one article — title weighted by repetition, like todos. */
export function wikiCorpusFor(a: WikiArticle): string {
  return `${a.title}\n${a.title}\n${a.summary}\n${a.body}`.trim()
}

/**
 * Keyword scoring for search-wiki: token overlap against slug/title/summary
 * (weighted) plus substring hits in the body. Corpus is ~20 small articles,
 * so a full scan per query is fine.
 */
export function scoreWikiKeyword(article: WikiArticle, query: string): number {
  const q = query.toLowerCase().trim()
  if (!q) return 0
  const tokens = q.match(/[a-z0-9][a-z0-9-]*/g) ?? []
  const head = `${article.slug} ${article.title} ${article.summary}`.toLowerCase()
  const body = article.body.toLowerCase()
  let score = 0
  if (head.includes(q)) score += 5
  for (const t of tokens) {
    if (t.length < 3) continue
    if (head.includes(t)) score += 2
    else if (body.includes(t)) score += 1
  }
  return score
}
