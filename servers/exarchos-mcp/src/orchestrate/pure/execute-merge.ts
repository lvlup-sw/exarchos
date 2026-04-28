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
// T10 will widen `ExecuteMergeResult` with rollback / failure variants.
//
// Implements: DR-MO-2 (merge execution with rollback) — happy path slice.
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
    strategy: string;
  }) => Promise<{ mergeSha: string }>;
  persistState: (state: {
    phase: 'executing';
    rollbackSha: string;
  }) => Promise<void> | void;
  repoRoot?: string;
}

// T10 will widen this with: { phase: 'rolled-back'; rollbackSha: string; reason: ... }
export type ExecuteMergeResult = {
  phase: 'completed';
  mergeSha: string;
  rollbackSha: string;
};

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

  // 3) call vcs merge (T10 will catch rejections and roll back)
  const { mergeSha } = await args.vcsMerge({
    sourceBranch: args.sourceBranch,
    targetBranch: args.targetBranch,
    strategy: args.strategy,
  });

  // 4) return completed
  return { phase: 'completed', mergeSha, rollbackSha };
}
