/**
 * Semantic indexing for the feature wiki. Reuses the memory embeddings module
 * + DB — wiki entries are namespaced in the chunk_meta table with a
 * `wiki:<slug>` key so they live alongside memory notes and todos without
 * collision.
 *
 * The wiki is read-only at runtime, so a single reindex at startup is enough;
 * there is no watcher. If the model isn't ready, search-wiki still works via
 * keyword scan.
 */

import fs from 'fs'
import path from 'path'
import { indexNote as embedIndexNote, isEmbeddingsAvailable } from './memory/embeddings'
import { listWikiArticles, wikiCorpusFor, WIKI_KEY_PREFIX } from './wiki'

/** Reindex every wiki article. Call once on startup after the model is ready. */
export async function reindexAllWiki(wikiDir: string): Promise<void> {
  if (!isEmbeddingsAvailable()) return
  const t0 = Date.now()
  const articles = listWikiArticles(wikiDir)
  let embedded = 0
  for (const article of articles) {
    try {
      let mtime = Date.now()
      try {
        mtime = fs.statSync(path.join(wikiDir, `${article.slug}.md`)).mtimeMs
      } catch {
        // keep Date.now() — forces a reindex, which is harmless
      }
      await embedIndexNote(`${WIKI_KEY_PREFIX}${article.slug}`, wikiCorpusFor(article), mtime)
      embedded++
    } catch (err) {
      console.error('[wiki:embed] reindex error for', article.slug, err)
    }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`[wiki:embed] reindex done — ${embedded}/${articles.length} in ${dt}s`)
}
