declare module 'js-yaml' {
  export interface DumpOptions {
    lineWidth?: number
    noRefs?: boolean
    indent?: number
    skipInvalid?: boolean
    sortKeys?: boolean
  }
  export function load(input: string): unknown
  export function dump(obj: unknown, opts?: DumpOptions): string
  const _default: { load: typeof load; dump: typeof dump }
  export default _default
}
