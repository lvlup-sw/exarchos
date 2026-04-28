/**
 * Merge Preflight — pure helpers for the autonomous merge orchestrator.
 *
 * Implements pieces of DR-MO-4 (drift detection). This module is split
 * across multiple TDD tasks:
 *
 *   T04 — detectDrift clean-tree path (this commit)
 *   T05 — detectDrift dirty-tree / stale-index / detached-HEAD extensions
 *   T06 — composed mergePreflight entry point
 *
 * The `GitExec` injection point keeps the module unit-testable: callers
 * supply a function that runs `git` with a repo root and arg array and
 * returns the captured `{ stdout, exitCode }`. T05 needs `exitCode` to
 * distinguish detached HEAD from other failures, which is why this
 * contract is richer than the bare-string `gitExec` used by
 * `setup-worktree.ts` / `dispatch-guard.ts`.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GitExecResult {
  readonly stdout: string;
  readonly exitCode: number;
}

export type GitExec = (
  repoRoot: string,
  args: readonly string[],
) => GitExecResult;

export interface DriftResult {
  /** True when the working tree has no uncommitted changes, the index is
   * not stale, and HEAD is on a named branch. */
  readonly clean: boolean;
  /** Files reported by `git status --porcelain`. */
  readonly uncommittedFiles: readonly string[];
  /** True when `git diff --cached --quiet` reports staged-but-uncommitted
   * changes (exit code != 0). */
  readonly indexStale: boolean;
  /** True when HEAD is detached (i.e., `git rev-parse --abbrev-ref HEAD`
   * returns the literal string "HEAD"). */
  readonly detachedHead: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse `git status --porcelain` output into a list of paths.
 *
 * Each non-empty line has the form `XY <path>` where XY is two status
 * characters followed by a space. We slice from index 3 to extract the
 * path. Renames (`R  old -> new`) are reported via the full segment as a
 * v1 minimal-handling decision; callers only care that the working tree
 * is dirty, not the exact file accounting.
 */
function parsePorcelainPaths(stdout: string): readonly string[] {
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3));
}

// ─── detectDrift ────────────────────────────────────────────────────────────

/**
 * Detect working-tree drift relative to HEAD.
 *
 * Reports three independent drift signals:
 *   1. `uncommittedFiles` — paths from `git status --porcelain`.
 *   2. `indexStale` — `git diff --cached --quiet` exited non-zero (staged
 *      changes present that aren't yet committed).
 *   3. `detachedHead` — `git rev-parse --abbrev-ref HEAD` returned `HEAD`.
 *
 * `clean` is true only when all three signals are absent. Per DR-MO-4,
 * this is fail-only — no auto-recovery is attempted here.
 */
export function detectDrift(
  gitExec: GitExec,
  repoRoot: string = process.cwd(),
): DriftResult {
  const status = gitExec(repoRoot, ['status', '--porcelain']);
  const uncommittedFiles = parsePorcelainPaths(status.stdout);

  const cached = gitExec(repoRoot, ['diff', '--cached', '--quiet']);
  const indexStale = cached.exitCode !== 0;

  const head = gitExec(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const detachedHead = head.stdout.trim() === 'HEAD';

  const clean =
    uncommittedFiles.length === 0 && !indexStale && !detachedHead;

  return { clean, uncommittedFiles, indexStale, detachedHead };
}
