// ─── execute-merge: pure helpers for autonomous merge orchestrator ─────────
//
// T08 — `recordRollbackPoint`: capture HEAD sha as a rollback anchor *before*
// merge execution. Pure (DI'd `gitExec`), total (never throws), structured
// error returns.
//
// T09 — `executeMerge` happy path: composes `recordRollbackPoint` with a
// DI'd `vcsMerge` adapter and `persistState` callback. Records the rollback
// sha, persists the `executing` intermediate state, then invokes the merge
// adapter and returns `{ phase: 'completed', mergeSha, rollbackSha }`.
//
// T10 — rollback paths: on `vcsMerge` rejection, `git reset --hard <rollbackSha>`
// and return `{ phase: 'rolled-back', rollbackSha, reason }`. The reason is
// categorized as 'timeout' | 'verification-failed' | 'merge-failed'.
//
// Implements: DR-MO-2 (merge execution with rollback).
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

// ─── executeMerge (T09 happy path) ─────────────────────────────────────────

export type MergeStrategy = 'squash' | 'rebase' | 'merge';

export interface ExecuteMergeArgs {
  sourceBranch: string;
  targetBranch: string;
  strategy: MergeStrategy;
  gitExec: GitExec;
  vcsMerge: (args: {
    sourceBranch: string;
    targetBranch: string;
    strategy: MergeStrategy;
  }) => Promise<{ mergeSha: string }>;
  persistState: (state: {
    phase: 'executing';
    rollbackSha: string;
  }) => Promise<void> | void;
  repoRoot?: string;
}

export type RollbackReason = 'merge-failed' | 'verification-failed' | 'timeout';

export type ExecuteMergeResult =
  | { phase: 'completed'; mergeSha: string; rollbackSha: string }
  | {
      phase: 'rolled-back';
      rollbackSha: string;
      reason: RollbackReason;
      /**
       * Set when `git reset --hard <rollbackSha>` itself failed during the
       * rollback path. The working tree is in an indeterminate state and
       * requires operator intervention. Absent when rollback succeeded.
       */
      rollbackError?: string;
    };

// Categorization convention: timeout = err.name === 'TimeoutError' OR (err as any).code === 'ETIMEDOUT';
// verification-failed = err.message matches /verification/i; otherwise merge-failed.
function categorizeFailure(err: unknown): RollbackReason {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    if (err.name === 'TimeoutError' || code === 'ETIMEDOUT') return 'timeout';
    if (/verification/i.test(err.message)) return 'verification-failed';
  }
  return 'merge-failed';
}

/**
 * Execute a merge with a recorded rollback anchor.
 *
 * Happy path only (T09): records rollback sha, persists `executing` state,
 * invokes the VCS merge adapter, returns `phase: 'completed'`. Rollback /
 * failure handling lands in T10.
 */
export async function executeMerge(
  args: ExecuteMergeArgs,
): Promise<ExecuteMergeResult> {
  // 1) record rollback point
  const rollback = recordRollbackPoint(args.gitExec, args.repoRoot);
  if ('error' in rollback) {
    throw new Error(`rollback record failed: ${rollback.error}`);
  }
  const rollbackSha = rollback.sha;

  // 2) persist intermediate state so a crash here is recoverable
  await args.persistState({ phase: 'executing', rollbackSha });

  // 3) call vcs merge — on rejection, reset to rollback sha and categorize.
  try {
    const { mergeSha } = await args.vcsMerge({
      sourceBranch: args.sourceBranch,
      targetBranch: args.targetBranch,
      strategy: args.strategy,
    });
    return { phase: 'completed', mergeSha, rollbackSha };
  } catch (err) {
    const reason = categorizeFailure(err);
    // Inspect the reset result so a stranded working tree is surfaced to
    // callers rather than silently masked under `phase: 'rolled-back'`.
    let rollbackError: string | undefined;
    try {
      const reset = args.gitExec(
        args.repoRoot ?? process.cwd(),
        ['reset', '--hard', rollbackSha],
      );
      if (reset.exitCode !== 0) {
        rollbackError = `git reset --hard ${rollbackSha} exited ${reset.exitCode}`;
      }
    } catch (resetErr) {
      rollbackError = resetErr instanceof Error ? resetErr.message : String(resetErr);
    }
    return rollbackError === undefined
      ? { phase: 'rolled-back', rollbackSha, reason }
      : { phase: 'rolled-back', rollbackSha, reason, rollbackError };
  }
}
