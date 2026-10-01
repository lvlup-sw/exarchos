/**
 * Compiles a glob pattern to a RegExp anchored to the whole path (`^…$`). The architecture
 * catalog, the check evaluator and the team verbs share this one compiler.
 */

/** Regex-special chars escaped to literals (excludes `*` and `/`, handled below). */
const REGEX_SPECIAL = '\\^$.|?+()[]{}';

/**
 * Converts a glob pattern to an anchored RegExp:
 *
 *   - A double-star followed by a slash matches zero or more leading path segments. Thus the
 *     pattern `servers/`, double-star, `/*.ts` also matches `servers/foo.ts`.
 *   - A double-star not followed by a slash matches across path separators.
 *   - `*` matches within one path segment.
 *   - `/` and every other regex-special character become literals.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? '';
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          out += '(?:.*\\/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
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
