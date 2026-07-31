/**
 * Resolve extensionless relative imports to their .ts files for `node --test`.
 *
 * The app's source is bundled by electron-vite, which resolves `./db` to
 * `./db.ts` for free. Node's own ESM resolver does not, so any test that
 * imports a module which in turn imports a sibling — anything beyond a leaf
 * like observer/tokens.ts — fails with ERR_MODULE_NOT_FOUND before a single
 * assertion runs. That ruled out testing exactly the stateful machinery
 * (mining watermarks, job debt) most worth testing.
 *
 * This hook only fires AFTER normal resolution has already failed, so it can
 * never shadow a real module, and it is scoped to the test script.
 */

const CANDIDATE_SUFFIXES = ['.ts', '.tsx', '/index.ts']

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (err) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw err
    for (const suffix of CANDIDATE_SUFFIXES) {
      try {
        return await next(specifier + suffix, context)
      } catch { /* try the next shape */ }
    }
    throw err
  }
}
