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
  readonly testGlobs?: readonly string[] | undefined;
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
    const ch = glob[i] ?? '';
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
 * Revert ONLY the given source files to their state at `baseRef`. Paths present
 * at the base are restored via targeted checkout; task-added tracked paths are
 * removed from the index/worktree so the probe faithfully recreates the base
 * even when the implementation introduces a new module. Never `reset --hard`.
 * Unknown paths and git failures surface as `revert-conflict`.
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
    const verifiedBase = gitExec(repoRoot, [
      'rev-parse',
      '--verify',
      `${baseRef}^{commit}`,
    ]);
    if (verifiedBase.exitCode !== 0) {
      return {
        ok: false,
        discriminant: 'revert-conflict',
        detail: `git rev-parse ${baseRef} exited ${verifiedBase.exitCode}: ${verifiedBase.stdout.trim()}`,
      };
    }

    const basePaths: string[] = [];
    const taskAddedPaths: string[] = [];
    for (const sourceFile of sourceFiles) {
      const atBase = gitExec(repoRoot, [
        'cat-file',
        '-e',
        `${baseRef}:${sourceFile}`,
      ]);
      if (atBase.exitCode === 0) {
        basePaths.push(sourceFile);
        continue;
      }

      // A path absent from the base is a valid task addition only when it is
      // tracked in the current index. A typo/nonexistent path remains a
      // conflict rather than being silently accepted.
      const trackedNow = gitExec(repoRoot, [
        'ls-files',
        '--error-unmatch',
        '--',
        sourceFile,
      ]);
      if (trackedNow.exitCode !== 0) {
        return {
          ok: false,
          discriminant: 'revert-conflict',
          detail: `source path is absent from both ${baseRef} and the current index: ${sourceFile}`,
        };
      }
      taskAddedPaths.push(sourceFile);
    }

    if (basePaths.length > 0) {
      const checkout = gitExec(repoRoot, [
        'checkout',
        baseRef,
        '--',
        ...basePaths,
      ]);
      if (checkout.exitCode !== 0) {
        return {
          ok: false,
          discriminant: 'revert-conflict',
          detail: `git checkout ${baseRef} -- <source> exited ${checkout.exitCode}: ${checkout.stdout.trim()}`,
        };
      }
    }

    if (taskAddedPaths.length > 0) {
      const remove = gitExec(repoRoot, [
        'rm',
        '--force',
        '--',
        ...taskAddedPaths,
      ]);
      if (remove.exitCode !== 0) {
        return {
          ok: false,
          discriminant: 'revert-conflict',
          detail: `git rm -- <task-added-source> exited ${remove.exitCode}: ${remove.stdout.trim()}`,
        };
      }
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

// ─── runProbe (task 013) ─────────────────────────────────────────────────────
//
// The orchestration that ties the kill probe together: split the task diff,
// snapshot the worktree, revert ONLY the source hunks, run the new/changed
// tests, observe whether they go red, and ALWAYS restore. The test runner and
// the changed-file list are injected so this composition is unit-testable
// without shelling out to a real test command.

/** Result of running the (scoped) test command during the probe. */
export interface TestRunResult {
  /** True when the scoped test run PASSED (all green). */
  readonly passed: boolean;
  /** Optional human-readable output for diagnostics. */
  readonly output?: string;
}

/**
 * Injected runner that executes the resolved test command, scoped to the
 * new/changed test files where the runner allows. Async to match real
 * shell-outs; receives the repo + the test files to scope to.
 */
export type TestRunFn = (input: {
  readonly repoRoot: string;
  readonly testFiles: readonly string[];
}) => Promise<TestRunResult>;

export interface ProbeArgs {
  readonly gitExec: GitExec;
  readonly repoRoot: string;
  /** The base ref the task diff is measured against (revert target). */
  readonly baseRef: string;
  /** Repo-relative files changed by the task diff. */
  readonly changedFiles: readonly string[];
  /** Runs the scoped test command; returns pass/fail. */
  readonly runTests: TestRunFn;
  /** Optional test-glob override forwarded to {@link splitHunks}. */
  readonly testGlobs?: readonly string[];
}

export interface ProbeResult {
  /**
   * The gate verdict. PASS means the probe proved the tests are non-vacuous:
   * at least one test went red when the source was reverted AND the worktree
   * was restored cleanly afterward.
   */
  readonly passed: boolean;
  /** The classified test files the probe ran. */
  readonly probedTests: string[];
  /** True when the scoped tests FAILED on the reverted source (the kill). */
  readonly redObserved: boolean;
  /** True when the working tree was restored to its pre-probe snapshot. */
  readonly restoredClean: boolean;
  /** Set on a non-PASS that is not simply "tests stayed green". */
  readonly discriminant?: AdequacyDiscriminant;
  /**
   * Human-readable diagnosis carried for the advisory discriminants (currently
   * `no-new-tests`), so the verdict is self-explanatory in the gate.executed
   * payload and the handler response. Absent for the ordinary pass/kill paths.
   */
  readonly report?: string;
}

/**
 * Run the kill probe.
 *
 * Sequence (with INV-14 restore in a finally — restore ALWAYS runs):
 *   1. split the diff into test vs source files
 *   2. if there are no new/changed test files → `no-new-tests` (nothing run)
 *   3. snapshot the working tree (object-only)
 *   4. revert the source files to `baseRef`; on conflict → restore + `revert-conflict`
 *   5. run the scoped tests; `redObserved = !passed`
 *   6. restore the working tree; `restoredClean = restore.restored`
 *
 * PASS iff `redObserved && restoredClean`. A clean revert whose tests stayed
 * green is a NON-vacuous-proof failure (`passed:false`) with NO discriminant —
 * the tests simply did not exercise the change. A restore failure is reported
 * as `restore-failed`.
 *
 * FIX-1b (INV-4 degrade discipline, mirroring contract-drift's no-tool skip): a
 * task whose diff adds NO new/changed tests has nothing to probe. That is an
 * ADVISORY skip — `passed:true` with the `no-new-tests` discriminant and a
 * self-explanatory report — NOT a blocking `passed:false`. The verification
 * ladder routes test-less low-tier tasks through typecheck+lint only; a missing
 * kill probe must never block them.
 */
export async function runProbe(args: ProbeArgs): Promise<ProbeResult> {
  const { gitExec, repoRoot, baseRef, changedFiles, runTests, testGlobs } = args;

  const { testFiles, sourceFiles } = splitHunks(changedFiles, { testGlobs });

  // No new/changed tests — the probe has nothing to kill. Advisory skip (INV-4),
  // not a blocking failure: a task that adds no tests is not "vacuous", it is
  // simply out of this gate's scope.
  if (testFiles.length === 0) {
    return {
      passed: true,
      probedTests: [],
      redObserved: false,
      restoredClean: true,
      discriminant: 'no-new-tests',
      report: 'nothing to probe — task adds no tests',
    };
  }

  const snap = snapshotWorkingTree(gitExec, repoRoot);
  if ('error' in snap) {
    // Could not snapshot — refuse to mutate a tree we cannot restore.
    return {
      passed: false,
      probedTests: testFiles,
      redObserved: false,
      restoredClean: false,
      discriminant: 'restore-failed',
    };
  }
  const stashSha = snap.stashSha;

  let redObserved = false;
  let revertConflict = false;
  // Default to a not-restored result so that if the finally never assigns it
  // (it always does, but the type system needs an initializer) the gate fails
  // safe as restore-failed rather than falsely reporting a clean restore.
  let restore: RestoreResult = { restored: false, detail: 'restore did not run' };

  try {
    // Mutation step: revert ONLY source. If there is no source to revert the
    // probe still runs (a test-only task can still be vacuous), but with
    // nothing reverted the tests cannot go red on the mutation — handled below.
    if (sourceFiles.length > 0) {
      const reverted = revertSourceFiles(gitExec, repoRoot, baseRef, sourceFiles);
      if (!reverted.ok) {
        revertConflict = true;
      }
    }

    if (!revertConflict) {
      const runResult = await runTests({ repoRoot, testFiles });
      redObserved = !runResult.passed;
    }
  } finally {
    // INV-14: restore ALWAYS runs, even if the test run threw.
    restore = restoreWorkingTree(gitExec, repoRoot, stashSha);
  }

  const restoredClean = restore.restored;

  if (revertConflict) {
    return {
      passed: false,
      probedTests: testFiles,
      redObserved: false,
      restoredClean,
      discriminant: 'revert-conflict',
    };
  }

  if (!restoredClean) {
    return {
      passed: false,
      probedTests: testFiles,
      redObserved,
      restoredClean,
      discriminant: 'restore-failed',
    };
  }

  return {
    passed: redObserved && restoredClean,
    probedTests: testFiles,
    redObserved,
    restoredClean,
  };
}
