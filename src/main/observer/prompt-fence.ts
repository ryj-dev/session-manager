/**
 * Fencing for mined text — the one genuinely untrusted input in the curator's
 * prompt.
 *
 * A pattern's label and signature are built from shell commands the user ran,
 * so their content is attacker-influenceable in the ordinary way any
 * repository is: a filename, a README snippet, or a command a previous agent
 * was talked into running becomes part of the label, gets mined for recurring
 * on four separate days, and lands verbatim in the prompt of an unattended
 * agent. It arrived as ordinary prose, indistinguishable from the instructions
 * around it.
 *
 * So each candidate's free text is wrapped in an explicit delimiter and the
 * prompt states that everything inside is data. The sanitiser here is what
 * makes that claim true: without stripping the delimiter itself, injected text
 * could simply close the fence and continue as instructions.
 *
 * A leaf module (no imports) so the sanitiser can be tested without pulling in
 * pty-manager → electron.
 */

export const FENCE_OPEN = '<observed>'
export const FENCE_CLOSE = '</observed>'

/**
 * Wrap untrusted mined text so it cannot be read as instructions.
 *
 * Three defences, all load-bearing:
 *  - the delimiter, in any spelling, is removed from the content, so the fence
 *    cannot be closed from inside;
 *  - control characters (newlines included) become spaces, so injected text
 *    cannot fake the prompt's own block structure with a fresh `## heading`;
 *  - the value is length-capped, so one pattern cannot crowd out the rest.
 */
export function fenceObservedText(text: string, maxChars = 300): string {
  const cleaned = text
    .replace(/\p{Cc}/gu, ' ')
    .replace(/<\/?\s*observed\s*>/gi, '(removed)')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
  return `${FENCE_OPEN}${cleaned}${FENCE_CLOSE}`
}
