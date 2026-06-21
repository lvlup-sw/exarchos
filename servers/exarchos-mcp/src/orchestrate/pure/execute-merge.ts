// ─── execute-merge: pure helpers for autonomous merge orchestrator ─────────
//
// T08 — `recordRecoveryPoint`: capture HEAD sha as a recovery point *before*
// merge execution. Pure (DI'd `gitExec`), total (never throws), structured
// error returns.
//
// T09 — `executeMerge` happy path: composes `recordRecoveryPoint` with a
// DI'd `vcsMerge` adapter and `persistState` callback. Records the recovery
// point sha, persists the `executing` intermediate state, then invokes the merge
// adapter and returns `{ phase: 'completed', mergeSha, recoveryPointSha }`.
//
// T10 — recovery paths: on `vcsMerge` rejection, run the INV-14 recovery ladder
// (`git merge --abort` → `git reset --keep <recoveryPointSha>`, never `--hard`) and
// return `{ phase: 'rolled-back', recoveryPointSha, reason, recoveryError? }`. The
// reason is categorized as 'timeout' | 'verification-failed' | 'merge-failed';
// `recoveryError` discriminates a non-clean recovery (INV-14).
//
// Implements: DR-MO-2 (merge execution with recovery).
// ───────────────────────────────────────────────────────────────────────────

export type GitExec = (
  repoRoot: string,
  args: readonly string[],
) => { stdout: string; exitCode: number };

export type RecoveryPoint = { sha: string } | { error: string };

/**
 * Capture the current HEAD sha so a downstream merge step can recover to it.
 * Never throws — all failure modes return `{ error }`.
 */
export function recordRecoveryPoint(
  gitExec: GitExec,
  repoRoot: string = process.cwd(),
): RecoveryPoint {
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
    recoveryPointSha: string;
  }) => Promise<void> | void;
  repoRoot?: string;
}

export type RecoveryReason = 'merge-failed' | 'verification-failed' | 'timeout';

/**
 * INV-14 recovery-outcome discriminator: the three indeterminate cases the
 * invariant names, so callers see a stranded worktree explicitly rather than as
 * a silent success.
 */
export type RecoveryError =
  | 'reset-keep-blocked'
  | 'reset-failed'
  | 'unexpected-mid-merge-drift';

export type ExecuteMergeResult =
  | { phase: 'completed'; mergeSha: string; recoveryPointSha: string }
  | {
      phase: 'rolled-back';
      recoveryPointSha: string;
      reason: RecoveryReason;
      /**
       * INV-14 recovery-outcome discriminator. Absent when recovery landed the
       * worktree cleanly on `recoveryPointSha`. Otherwise classifies the
       * indeterminate outcome so callers escalate instead of treating a
       * stranded tree as a clean recovery.
       */
      recoveryError?: RecoveryError;
      /** Human-readable detail for `recoveryError`; absent on clean recovery. */
      recoveryErrorDetail?: string;
    };

// Categorization convention: timeout = err.name === 'TimeoutError' OR (err as any).code === 'ETIMEDOUT';
// verification-failed = err.message matches /verification/i; otherwise merge-failed.
function categorizeFailure(err: unknown): RecoveryReason {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    if (err.name === 'TimeoutError' || code === 'ETIMEDOUT') return 'timeout';
    if (/verification/i.test(err.message)) return 'verification-failed';
  }
  return 'merge-failed';
}

/**
 * Execute a merge with a recorded recovery point.
 *
 * Happy path only (T09): records recovery point sha, persists `executing` state,
 * invokes the VCS merge adapter, returns `phase: 'completed'`. Recovery /
 * failure handling lands in T10.
 */
export async function executeMerge(
  args: ExecuteMergeArgs,
): Promise<ExecuteMergeResult> {
  // 1) record recovery point
  const recoveryPoint = recordRecoveryPoint(args.gitExec, args.repoRoot);
  if ('error' in recoveryPoint) {
    throw new Error(`recovery point record failed: ${recoveryPoint.error}`);
  }
  const recoveryPointSha = recoveryPoint.sha;

  // 2) persist intermediate state so a crash here is recoverable
  await args.persistState({ phase: 'executing', recoveryPointSha });

  // 3) call vcs merge — on rejection, reset to recovery point sha and categorize.
  try {
    const { mergeSha } = await args.vcsMerge({
      sourceBranch: args.sourceBranch,
      targetBranch: args.targetBranch,
      strategy: args.strategy,
    });
    return { phase: 'completed', mergeSha, recoveryPointSha };
  } catch (err) {
    const reason = categorizeFailure(err);
    // INV-14: reverse via the operation's own recovery primitive first, then a
    // refuse-to-discard substrate undo — never a destructive `git reset --hard`.
    // A non-clean outcome is surfaced (recoveryError + detail) rather than
    // silently masked under `phase: 'rolled-back'`.
    const recovery = recoverToAnchor(args.gitExec, args.repoRoot ?? process.cwd(), recoveryPointSha);
    return recovery === undefined
      ? { phase: 'rolled-back', recoveryPointSha, reason }
      : {
          phase: 'rolled-back',
          recoveryPointSha,
          reason,
          recoveryError: recovery.code,
          recoveryErrorDetail: recovery.detail,
        };
  }
}

/**
 * INV-14 recovery ladder for a failed merge. Reverses to `recoveryPointSha` using,
 * in order: (1) `git merge --abort` — the operation's own recovery primitive,
 * best-effort (a no-op exit when no merge is in progress is expected and
 * ignored); (2) `git reset --keep <recoveryPointSha>` — a refuse-to-discard substrate
 * undo (NEVER `--hard`, which would silently destroy uncommitted work). Returns
 * `undefined` when the worktree lands cleanly on the anchor, or a discriminated
 * `recoveryError` + human-readable `detail` when the outcome is indeterminate.
 */
function recoverToAnchor(
  gitExec: GitExec,
  repoRoot: string,
  recoveryPointSha: string,
): { code: RecoveryError; detail: string } | undefined {
  // 1) Native primitive first. Best-effort: a non-zero exit means "no merge in
  //    progress", which the authoritative reset below handles.
  try {
    gitExec(repoRoot, ['merge', '--abort']);
  } catch {
    // Ignore — `git merge --abort` failing (e.g. nothing to abort) is expected
    // for non-conflict reversals; the reset is the authoritative rewind.
  }

  // 2) Substrate undo, refuse-to-discard. NEVER `--hard`.
  let reset: { stdout: string; exitCode: number };
  try {
    reset = gitExec(repoRoot, ['reset', '--keep', recoveryPointSha]);
  } catch (resetErr) {
    return {
      code: 'reset-failed',
      detail: resetErr instanceof Error ? resetErr.message : String(resetErr),
    };
  }
  if (reset.exitCode !== 0) {
    // `--keep` refuses rather than discard local work: non-destructive but
    // indeterminate. Distinct from a hard failure so callers can page operators.
    return {
      code: 'reset-keep-blocked',
      detail: `git reset --keep ${recoveryPointSha} exited ${reset.exitCode}${reset.stdout ? `: ${reset.stdout.trim()}` : ''}`,
    };
  }

  // 3) Drift check: confirm the worktree actually landed on the anchor.
  let head: { stdout: string; exitCode: number };
  try {
    head = gitExec(repoRoot, ['rev-parse', 'HEAD']);
  } catch (headErr) {
    return {
      code: 'reset-failed',
      detail: `post-recovery rev-parse HEAD failed: ${headErr instanceof Error ? headErr.message : String(headErr)}`,
    };
  }
  if (head.exitCode !== 0 || head.stdout.trim() !== recoveryPointSha) {
    return {
      code: 'unexpected-mid-merge-drift',
      detail: `worktree HEAD ${head.stdout.trim() || '(unknown)'} != recovery anchor ${recoveryPointSha} after merge --abort + reset --keep`,
    };
  }

  return undefined;
}
