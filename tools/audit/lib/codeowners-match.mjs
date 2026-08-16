// @ts-check
/**
 * CODEOWNERS prefix matcher shared by the architecture measurer and the
 * conformance census. A leading slash means "from the repo root" and is
 * stripped. Unsupported gitignore forms match nothing so a hole reports
 * dead rather than assumed live.
 *
 * @param {string} pattern
 * @param {string} rel
 * @returns {boolean}
 */
export function codeownersMatches(pattern, rel) {
  if (pattern === '*') return true;
  const bare = pattern.replace(/^\//, '');
  if (bare.endsWith('/')) return rel.startsWith(bare);
  return rel === bare || rel.startsWith(`${bare}/`);
}

/**
 * @param {string} pattern
 * @returns {(rel: string) => boolean}
 */
export function codeownersMatcher(pattern) {
  return (rel) => codeownersMatches(pattern, rel);
}
