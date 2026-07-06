import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Markdown artifact renderer. Mirrors the inline-style component map used by
 * PipelineView's MarkdownBody / memory NoteViewer — the app has no
 * @tailwindcss/typography plugin, so `prose` classes are unavailable and
 * styles are applied inline.
 */
export function MarkdownArtifact({ content }: { content: string }): JSX.Element {
  return (
    <div className="text-[12px] leading-relaxed text-zinc-300 px-4 py-3">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" style={{ color: '#6cf' }}>{children}</a>,
          h1: ({ children }) => <h1 style={{ fontSize: 18, fontWeight: 600, color: '#e0e0e0', marginBottom: 8 }}>{children}</h1>,
          h2: ({ children }) => <h2 style={{ fontSize: 15, fontWeight: 600, color: '#c0c8d0', marginTop: 18, marginBottom: 6, borderBottom: '1px solid #1e2530', paddingBottom: 4 }}>{children}</h2>,
          h3: ({ children }) => <h3 style={{ fontSize: 13, fontWeight: 600, color: '#aab8c0', marginTop: 14, marginBottom: 4 }}>{children}</h3>,
          p: ({ children }) => <p style={{ marginBottom: 10 }}>{children}</p>,
          ul: ({ children }) => <ul style={{ paddingLeft: 18, marginBottom: 10, listStyle: 'disc' }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ paddingLeft: 18, marginBottom: 10, listStyle: 'decimal' }}>{children}</ol>,
          li: ({ children }) => <li style={{ marginBottom: 3 }}>{children}</li>,
          code: ({ children, className }) => {
            if (className) {
              return <code style={{ display: 'block', background: '#111418', padding: 10, borderRadius: 4, fontSize: 11, fontFamily: 'ui-monospace, monospace', overflowX: 'auto', marginBottom: 10 }}>{children}</code>
            }
            return <code style={{ background: '#1a2030', padding: '1px 5px', borderRadius: 3, fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>{children}</code>
          },
          table: ({ children }) => <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10, fontSize: 12 }}>{children}</table>,
          th: ({ children }) => <th style={{ textAlign: 'left', padding: '5px 8px', borderBottom: '1px solid #2a3545', color: '#aab', fontWeight: 600, fontSize: 11 }}>{children}</th>,
          td: ({ children }) => <td style={{ padding: '4px 8px', borderBottom: '1px solid #1a1f28' }}>{children}</td>,
          blockquote: ({ children }) => <blockquote style={{ borderLeft: '3px solid #2a3545', paddingLeft: 14, color: '#889', marginBottom: 10 }}>{children}</blockquote>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
