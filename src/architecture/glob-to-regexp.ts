/**
 * Shared glob → anchored RegExp compiler (FIX-3, de-dup).
 *
 * Previously copy-pasted into `check-evaluator.ts` and `project-catalog.ts`
 * with DIVERGENT escape sets — the evaluator copy did NOT escape `/`, so a
 * literal `/` in a fileGlob compiled to an un-escaped regex `/` (harmless in
 * JS `RegExp`, but inconsistent and brittle if the pattern ever carried a
 * char both sets disagreed on). This is the single, more-correct
 * implementation (the `project-catalog.ts` escape set, which escapes `/`).
 *
 * Glob semantics (matches what the catalog actually uses):
 *   - a double-star followed by a slash matches zero or more leading path
 *     segments, INCLUDING none, so the pattern `servers/` + double-star +
 *     `/*.ts` matches both `servers/foo.ts` and `servers/a/b.ts`;
 *   - a double-star not followed by a slash matches across path separators
 *     (any subtree);
 *   - `*`  matches within a single path segment (no `/`);
 *   - every other regex-special character is escaped to a literal.
 *
 * The result is anchored to the whole path (`^…$`).
 */

/** Regex-special chars escaped to literals (excludes `*` and `/`, handled below). */
const REGEX_SPECIAL = '\\^$.|?+()[]{}';

/**
 * Convert a glob-ish pattern to an anchored RegExp.
 *
 *   - a double-star followed by a slash matches zero or more leading path
 *     segments (including none);
 *   - a double-star not followed by a slash matches across path separators;
 *   - `*`  matches within a single path segment (no `/`);
 *   - `/`  is escaped to a literal separator;
 *   - all other regex-special characters are escaped literally.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? '';
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++; // consume the second `*`
        if (pattern[i + 1] === '/') {
          // `**/` — zero or more leading path segments, INCLUDING none, so
          // `servers/**/*.ts` also matches `servers/foo.ts`. A bare `.*\/`
          // would have required at least one nested segment.
          i++; // consume the `/`
          out += '(?:.*\\/)?';
        } else {
          out += '.*'; // bare `**` — match across separators.
        }
      } else {
        out += '[^/]*'; // single `*` — match within a segment.
      }
    } else if (REGEX_SPECIAL.includes(ch)) {
      out += `\\${ch}`;
    } else if (ch === '/') {
      out += '\\/';
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}
