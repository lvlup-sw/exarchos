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
  /** True when the working tree has no uncommitted changes. */
  readonly clean: boolean;
  /** Files reported by `git status --porcelain` (empty in clean-tree branch). */
  readonly uncommittedFiles: readonly string[];
  // T05 will extend with: indexStale, detachedHead.
}

// ─── detectDrift ────────────────────────────────────────────────────────────

/**
 * Detect working-tree drift relative to HEAD.
 *
 * T04 scope: clean-tree branch only. When `git status --porcelain` returns
 * empty stdout we report `clean: true` and an empty `uncommittedFiles`
 * list. Parsing of dirty-tree porcelain output, stale-index detection, and
 * detached-HEAD reporting are deferred to T05.
 */
export function detectDrift(
  gitExec: GitExec,
  repoRoot: string = process.cwd(),
): DriftResult {
  const status = gitExec(repoRoot, ['status', '--porcelain']);
  const trimmed = status.stdout.trim();
  const clean = trimmed.length === 0;
  const uncommittedFiles: readonly string[] = [];
  return { clean, uncommittedFiles };
}
