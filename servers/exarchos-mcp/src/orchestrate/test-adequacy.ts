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

import type { GitExec } from './pure/execute-merge.js';

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

// ─── snapshot / revert / restore (task 012, INV-14) ──────────────────────────
//
// The probe MUST be able to restore the working tree to exactly what it was
// before the mutation, even if the test-run step throws. We capture the tree
// with `git stash create` (object-only — it produces a commit object and
// mutates NO ref, so it is NOT the banned `stash push`/`stash pop`). Reverting
// source files is a targeted `git checkout <base> -- <files>` (never
// `reset --hard`). Restore re-checks-out the snapshot tree.
//
// All three are total: they translate git failures into structured discriminants
// rather than throwing, so the orchestrator can run them under a finally and
// always reach restore.

/** Discriminants for the gate's failure modes (carried on the result). */
export type AdequacyDiscriminant = 'no-new-tests' | 'revert-conflict' | 'restore-failed';

export type SnapshotResult =
  | { readonly stashSha: string }
  | { readonly error: string };

export type RevertResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly discriminant: 'revert-conflict'; readonly detail: string };

export interface RestoreResult {
  readonly restored: boolean;
  readonly detail?: string;
}

/**
 * Capture the current working tree as an object-only snapshot.
 *
 * `git stash create` writes a commit object whose tree is the dirty working
 * tree and returns its sha WITHOUT touching `refs/stash` or any other ref —
 * the refuse-to-discard property INV-14 requires (no `stash push`/`pop`, which
 * mutate shared stash storage across worktrees). On a clean tree it returns
 * empty stdout; we fall back to HEAD's own tree so restore is always
 * well-defined.
 */
export function snapshotWorkingTree(gitExec: GitExec, repoRoot: string): SnapshotResult {
  try {
    const created = gitExec(repoRoot, ['stash', 'create']);
    if (created.exitCode !== 0) {
      return { error: `git stash create exited ${created.exitCode}: ${created.stdout.trim()}` };
    }
    const sha = created.stdout.trim();
    if (sha) {
      return { stashSha: sha };
    }
    // Clean tree — snapshot HEAD (its commit sha is a valid restore source).
    const head = gitExec(repoRoot, ['rev-parse', 'HEAD']);
    if (head.exitCode !== 0) {
      return { error: `git rev-parse HEAD exited ${head.exitCode}: ${head.stdout.trim()}` };
    }
    const headSha = head.stdout.trim();
    if (!headSha) return { error: 'empty sha from git rev-parse HEAD' };
    return { stashSha: headSha };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Revert ONLY the given source files to their state at `baseRef` via a targeted
 * `git checkout <baseRef> -- <files...>`. Never `reset --hard`. A non-zero exit
 * (e.g. a path absent at base, or a checkout conflict) surfaces as a structured
 * `revert-conflict` discriminant — never a throw or a silent no-op.
 */
export function revertSourceFiles(
  gitExec: GitExec,
  repoRoot: string,
  baseRef: string,
  sourceFiles: readonly string[],
): RevertResult {
  if (sourceFiles.length === 0) {
    // Nothing to revert is not a conflict — caller decides whether that's a
    // probe-skip; here it is trivially successful.
    return { ok: true };
  }
  try {
    const result = gitExec(repoRoot, ['checkout', baseRef, '--', ...sourceFiles]);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        discriminant: 'revert-conflict',
        detail: `git checkout ${baseRef} -- <source> exited ${result.exitCode}: ${result.stdout.trim()}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      discriminant: 'revert-conflict',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Restore the working tree to the snapshot captured by
 * {@link snapshotWorkingTree}. Re-checks-out every tracked path from the
 * snapshot commit's tree (`git checkout <stashSha> -- .`), undoing the targeted
 * source revert. Total: returns `{ restored: false, detail }` on any git
 * failure so the orchestrator can fold a restore failure into a
 * `restore-failed` discriminant rather than crashing the gate.
 */
export function restoreWorkingTree(
  gitExec: GitExec,
  repoRoot: string,
  stashSha: string,
): RestoreResult {
  try {
    const result = gitExec(repoRoot, ['checkout', stashSha, '--', '.']);
    if (result.exitCode !== 0) {
      return {
        restored: false,
        detail: `git checkout ${stashSha} -- . exited ${result.exitCode}: ${result.stdout.trim()}`,
      };
    }
    return { restored: true };
  } catch (err) {
    return { restored: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
