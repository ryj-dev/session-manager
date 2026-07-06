import type { CanvasArtifact } from '../../store'

/** One-line summary for an artifact — used by the compact card, the dock's
 *  history selector tooltip, and anywhere a full render doesn't fit. */
export function summaryFor(artifact: CanvasArtifact): string {
  switch (artifact.component) {
    case 'result-table':
      return `table · ${artifact.table.rows.length} rows`
    case 'markdown': {
      const k = artifact.markdown.length / 1000
      return `markdown · ${k >= 1 ? `${k.toFixed(1)}k chars` : `${artifact.markdown.length} chars`}`
    }
    case 'image':
      return 'image'
    case 'annotated-image':
      return `annotated image · ${artifact.annotations.length} note${artifact.annotations.length === 1 ? '' : 's'}`
  }
}

/** Display title: explicit title, else the summary. */
export function titleFor(artifact: CanvasArtifact): string {
  return artifact.title || summaryFor(artifact)
}
