// ─── execute-merge: pure helpers for autonomous merge orchestrator ─────────
//
// T08 — `recordRollbackPoint`: capture HEAD sha as a rollback anchor *before*
// merge execution. Pure (DI'd `gitExec`), total (never throws), structured
// error returns. T09/T10 will compose `executeMerge` on top of this helper.
//
// Implements: DR-MO-2 (merge execution with rollback) — rollback-point
// recorder slice only.
// ───────────────────────────────────────────────────────────────────────────

export type GitExec = (
  repoRoot: string,
  args: readonly string[],
) => { stdout: string; exitCode: number };

export type RollbackPoint = { sha: string } | { error: string };

/**
 * Capture the current HEAD sha so a downstream merge step can roll back.
 * Never throws — all failure modes return `{ error }`.
 */
export function recordRollbackPoint(
  gitExec: GitExec,
  repoRoot: string = process.cwd(),
): RollbackPoint {
  try {
    const result = gitExec(repoRoot, ['rev-parse', 'HEAD']);
    if (result.exitCode !== 0) {
      return { error: `git rev-parse HEAD exited ${result.exitCode}` };
    }
    const sha = result.stdout.trim();
    if (!sha) {
      return { error: 'empty sha from git rev-parse' };
    }
    return { sha };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
