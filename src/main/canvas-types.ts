// Canvas artifact types — the declarative UI payloads a session's agent (or the
// user-image auto-display path) can put on a session's canvas.
//
// Pure types + caps only: no electron imports, so canvas-validate.ts and its
// unit tests can import this under plain `node --test`. The renderer keeps a
// mirror of these types in src/renderer/store/index.ts.

/** Global cap on stored artifacts; addArtifact prunes oldest-first past this. */
export const MAX_CANVAS_ARTIFACTS = 50

// ── Caps enforced by canvas-validate.ts (and advertised in the MCP schema) ──
export const MAX_TABLE_COLUMNS = 24
export const MAX_TABLE_ROWS = 2000
export const MAX_TABLE_CELLS = 20000
export const MAX_CELL_CHARS = 1000
export const MAX_MARKDOWN_CHARS = 100_000
export const MAX_ANNOTATIONS = 100
export const MAX_TITLE_CHARS = 120
export const MAX_ANNOTATION_TEXT_CHARS = 200

export const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

export type CanvasArtifactSource = 'agent' | 'user'

export interface CanvasArtifactBase {
  id: string
  /** App/PTY session id (APP_SESSION_ID) of the emitter. */
  sessionId: string
  /** Claude conversation id — the only session identity that survives an app
   *  restart, so it's what re-binds persisted artifacts to a restored session. */
  claudeSessionId: string | null
  /** 'agent' = emitted via canvas-show; 'user' = auto-displayed image path
   *  detected in the user's submitted prompt. */
  source: CanvasArtifactSource
  /** Short label shown in the dock header / history selector. */
  title?: string
  /** ms epoch, server-assigned. */
  createdAt: number
}

export interface TableColumn {
  key: string
  label?: string
  align?: 'left' | 'right' | 'center'
}

export type TableCell = string | number | boolean | null

export interface TableSpec {
  columns: TableColumn[]
  rows: Array<Record<string, TableCell>>
}

export interface ImageSpec {
  /** Absolute local path. Served to the renderer via canvas://image/<artifactId>
   *  (looked up by artifact id in the store — never by caller-supplied path).
   *  At emit time the source file is COPIED into the app-owned canvas-images
   *  dir and this points at the copy — artifacts own their pixels, so a
   *  source living in an ephemeral location (~/.claude/image-cache, /tmp)
   *  can't take the artifact down with it when cleaned up. */
  path: string
  /** The caller-supplied source path the copy was made from (display only). */
  originalPath?: string
  alt?: string
}

/** Overlay annotations. All coordinates are PIXELS in the image's NATURAL size;
 *  the renderer overlays an SVG with viewBox="0 0 natW natH" so shapes scale
 *  uniformly with the displayed image. */
export type Annotation =
  | { kind: 'circle'; cx: number; cy: number; r: number; label?: string; color?: string }
  | { kind: 'box'; x: number; y: number; w: number; h: number; label?: string; color?: string }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; label?: string; color?: string }
  | { kind: 'label'; x: number; y: number; text: string; color?: string }

export type CanvasArtifact =
  | (CanvasArtifactBase & { component: 'result-table'; table: TableSpec })
  | (CanvasArtifactBase & { component: 'markdown'; markdown: string })
  | (CanvasArtifactBase & { component: 'image'; image: ImageSpec })
  | (CanvasArtifactBase & { component: 'annotated-image'; image: ImageSpec; annotations: Annotation[] })
// Future components (chart, pick-one, approval, …) extend this union.

/** The validated, un-stamped payload accepted by canvas-store.addArtifact —
 *  everything except the server-assigned/stamped envelope fields. */
export type CanvasArtifactPayload =
  | { component: 'result-table'; title?: string; table: TableSpec }
  | { component: 'markdown'; title?: string; markdown: string }
  | { component: 'image'; title?: string; image: ImageSpec }
  | { component: 'annotated-image'; title?: string; image: ImageSpec; annotations: Annotation[] }
