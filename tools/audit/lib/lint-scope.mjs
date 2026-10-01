// @ts-check
/**
 * @fileoverview The files that the shared ESLint run reads.
 *
 * Three consumers use this scope: the `files` key in `eslint.config.js`, the `lint` script in
 * `package.json`, and the guard-liveness measurer. A test compares the script with these globs.
 * The globs use brace sets, so `globsMatch` expands them before it compares a path.
 */

/** The top-level directories that the lint run reads. */
export const LINT_ROOTS = Object.freeze(['src', 'tools', 'tests']);

/** The JavaScript and TypeScript file extensions that the lint run reads. */
export const LINT_EXTENSIONS = Object.freeze(['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']);

/** The CLI globs, in the order that the `lint` script gives them. */
export const LINT_GLOBS = Object.freeze([
  `{${LINT_ROOTS.join(',')}}/**/*.{${LINT_EXTENSIONS.join(',')}}`,
  `*.{${LINT_EXTENSIONS.join(',')}}`,
]);

/** Paths that the lint run never reads. Seeded-defect fixtures are broken on purpose. */
export const LINT_IGNORES = Object.freeze(['tools/evals/evals/benchmarks/seeded-defects/fixtures/**']);

/**
 * Expand every `{a,b}` set in a glob into separate globs.
 *
 * @param {string} glob
 * @returns {string[]}
 */
export function expandBraces(glob) {
  const match = /\{([^{}]*)\}/.exec(glob);
  if (match === null) return [glob];
  const head = glob.slice(0, match.index);
  const tail = glob.slice(match.index + match[0].length);
  return (match[1] ?? '').split(',').flatMap((option) => expandBraces(`${head}${option}${tail}`));
}

/**
 * Translate one brace-free glob into an anchored expression. `**` crosses directories and `*` does not.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob.charAt(i);
    if (ch === '*' && glob.charAt(i + 1) === '*') {
      out += glob.charAt(i + 2) === '/' ? '(?:.*/)?' : '.*';
      i += glob.charAt(i + 2) === '/' ? 2 : 1;
    } else if (ch === '*') {
      out += '[^/]*';
    } else {
      out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Whether a repository-relative POSIX path matches one of the globs.
 *
 * @param {readonly string[]} globs
 * @param {string} relPath
 * @returns {boolean}
 */
export function globsMatch(globs, relPath) {
  return globs.flatMap(expandBraces).some((glob) => globToRegExp(glob).test(relPath));
}

/**
 * Whether the lint run reads this repository-relative POSIX path.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
export function isInLintScope(relPath) {
  return globsMatch(LINT_GLOBS, relPath) && !globsMatch(LINT_IGNORES, relPath);
}
