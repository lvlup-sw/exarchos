// ─── check_test_adequacy — kill-probe gate ───────────────────────────────────
//
// Verification-ladder slice 1, Bundle B2. Proves a task's tests are NOT vacuous
// using "mutation testing at N=1": revert ONLY the task's SOURCE hunks (keeping
// the test hunks), re-run the new/changed tests, and assert at least one goes
// red. A test that survives the source revert asserted nothing about the change.
//
// This module is built bottom-up across tasks 011–013:
//   • task 011 — splitHunks (pure file-level test/source classification)
//
// `splitHunks` is exported cleanly so a sibling bundle (mock-boundary) can reuse
// the same classification without re-deriving the test globs.
// ────────────────────────────────────────────────────────────────────────────

// ─── splitHunks (task 011) ───────────────────────────────────────────────────

/**
 * Default test-file globs when the resolved toolchain/config supplies none.
 * Co-located convention: `*.test.*`, `*.spec.*`, and anything under a
 * `__tests__/` directory. Matched against the full (repo-relative) path.
 */
export const DEFAULT_TEST_GLOBS: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
];

export interface SplitHunksOptions {
  /**
   * Test-file globs from the resolved toolchain/config. When provided these
   * REPLACE the co-located defaults (the toolchain is authoritative about what
   * a "test file" is for that project). When omitted, {@link DEFAULT_TEST_GLOBS}
   * is used.
   */
  readonly testGlobs?: readonly string[];
}

export interface SplitHunksResult {
  /** Changed files classified as tests, in input order. */
  readonly testFiles: string[];
  /** Changed files classified as source (everything not a test), in input order. */
  readonly sourceFiles: string[];
}

/**
 * Translate a single glob into a RegExp anchored to the whole path.
 *
 * Supported tokens (sufficient for the co-located test conventions and simple
 * toolchain-supplied globs — NOT a full glob engine):
 *   • `**` (optionally followed by `/`) → any number of path segments
 *   • `*`                               → any run of non-`/` characters
 *   • every other character is matched literally
 */
function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` consumes zero-or-more leading segments; bare `**` matches all.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    // Escape regex metacharacters so the rest is matched literally.
    out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  out += '$';
  return new RegExp(out);
}

/**
 * Classify a task diff's changed files into test vs source at the FILE level
 * (a file is wholly test or wholly source — never split mid-file). Pure: takes
 * the changed-file list and optional test globs, returns the partition. No git
 * calls, no fs access.
 *
 * @param changedFiles - repo-relative paths changed by the task diff
 * @param options.testGlobs - optional override for the test-file globs
 */
export function splitHunks(
  changedFiles: readonly string[],
  options?: SplitHunksOptions,
): SplitHunksResult {
  const globs = options?.testGlobs ?? DEFAULT_TEST_GLOBS;
  const matchers = globs.map(globToRegExp);

  const testFiles: string[] = [];
  const sourceFiles: string[] = [];

  for (const file of changedFiles) {
    const isTest = matchers.some((re) => re.test(file));
    if (isTest) {
      testFiles.push(file);
    } else {
      sourceFiles.push(file);
    }
  }

  return { testFiles, sourceFiles };
}
