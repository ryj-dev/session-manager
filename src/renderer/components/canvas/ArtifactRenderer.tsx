import type { CanvasArtifact } from '../../store'
import { ResultTable } from './ResultTable'
import { MarkdownArtifact } from './MarkdownArtifact'
import { AnnotatedImage } from './AnnotatedImage'

/** Dispatch an artifact to its component renderer. The default arm guards
 *  against a newer canvas.json being read by an older build. */
export function ArtifactRenderer({ artifact }: { artifact: CanvasArtifact }): JSX.Element {
  switch (artifact.component) {
    case 'result-table':
      return <ResultTable table={artifact.table} />
    case 'markdown':
      return <MarkdownArtifact content={artifact.markdown} />
    case 'image':
    case 'annotated-image':
      return <AnnotatedImage artifact={artifact} />
    default:
      return (
        <div className="flex items-center justify-center h-full px-6 py-10 text-center">
          <span className="text-[11px] text-zinc-500">
            Unsupported artifact type “{(artifact as { component: string }).component}” — update session-manager to view it.
          </span>
        </div>
      )
  }
}
