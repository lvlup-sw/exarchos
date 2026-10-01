/**
 * Pure helpers for the autonomous merge orchestrator. Each helper takes its git and VCS access as injected functions.
 * - `recordRecoveryPoint` captures the `HEAD` sha before a merge. It never throws.
 * - `executeMerge` records the recovery point, persists the `executing` state, and calls the VCS merge adapter.
 *   On a failure, it runs the recovery ladder and returns `phase: 'rolled-back'`.
 *
 * The recovery ladder runs `git merge --abort`, then `git reset --keep <recoveryPointSha>`. It never uses `--hard`.
 * `recoveryError` marks a recovery that did not land cleanly on the recovery point.
 */

export type GitExec = (
  repoRoot: string,
  args: readonly string[],
) => { stdout: string; exitCode: number };

/** Max retries after the initial attempt → `MAX_MERGE_RETRIES + 1` total `vcsMerge` calls. */
export const MAX_MERGE_RETRIES = 2;
/** Base backoff delay (ms) before the first retry. */
export const RETRY_BASE_DELAY_MS = 1000;
/** Exponential growth factor applied per retry: `base * factor^(attempt-1)`. */
export const RETRY_BACKOFF_FACTOR = 2.0;
/** Symmetric jitter band as a fraction of the computed delay (±25%). */
export const RETRY_JITTER_FRACTION = 0.25;

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
  /**
   * Jitter source for the retry backoff. It returns a signed fraction in `[-1, 1]`.
   * The delay is `base * (1 + RETRY_JITTER_FRACTION * jitter())`. The default derives from `Math.random()`.
   * The source is injected, so the retry path stays deterministic in tests.
   */
  jitter?: () => number;
  /**
   * Delay function, called with the backoff in ms before each retry.
   * Tests inject it to skip the real wait. The default uses `setTimeout`.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called once per retry, before the backoff wait, so the handler can emit a `merge.retry_attempt` event.
   * `attempt` is the 1-based retry number, and `delayMs` is the backoff that comes before that retry.
   * The function awaits the callback, so the event order is observable.
   */
  onRetryAttempt?: (info: {
    attempt: number;
    delayMs: number;
    reason: 'timeout';
  }) => Promise<void> | void;
}

export type RecoveryReason = 'merge-failed' | 'verification-failed' | 'timeout';

/** Outcomes of a recovery that did not land cleanly, so callers see a stranded worktree and not a silent success. */
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
       * Absent when recovery landed the worktree cleanly on `recoveryPointSha`.
       * Otherwise it names the outcome, so callers escalate and do not treat a stranded tree as a clean recovery.
       */
      recoveryError?: RecoveryError;
      /** Human-readable detail for `recoveryError`. Absent on a clean recovery. */
      recoveryErrorDetail?: string;
    };

/**
 * A failure is `timeout` when the error name is `TimeoutError` or its code is `ETIMEDOUT`.
 * It is `verification-failed` when the message matches `/verification/i`. Every other failure is `merge-failed`.
 */
function categorizeFailure(err: unknown): RecoveryReason {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    if (err.name === 'TimeoutError' || code === 'ETIMEDOUT') return 'timeout';
    if (/verification/i.test(err.message)) return 'verification-failed';
  }
  return 'merge-failed';
}

/**
 * Executes a merge with a recorded recovery point.
 * It persists the `executing` state before the merge, so a crash after that point is recoverable.
 * Only a `timeout` failure is retried, up to `MAX_MERGE_RETRIES` times, with exponential backoff and jitter.
 * Any other failure, or a timeout after the last retry, goes to the recovery ladder.
 * The result then carries the category of the last failure.
 * @throws When the recovery point cannot be recorded.
 */
export async function executeMerge(
  args: ExecuteMergeArgs,
): Promise<ExecuteMergeResult> {
  const recoveryPoint = recordRecoveryPoint(args.gitExec, args.repoRoot);
  if ('error' in recoveryPoint) {
    throw new Error(`recovery point record failed: ${recoveryPoint.error}`);
  }
  const recoveryPointSha = recoveryPoint.sha;

  await args.persistState({ phase: 'executing', recoveryPointSha });

  const jitter = args.jitter ?? (() => Math.random() * 2 - 1);
  const sleep =
    args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_MERGE_RETRIES; attempt += 1) {
    try {
      const { mergeSha } = await args.vcsMerge({
        sourceBranch: args.sourceBranch,
        targetBranch: args.targetBranch,
        strategy: args.strategy,
      });
      return { phase: 'completed', mergeSha, recoveryPointSha };
    } catch (err) {
      lastErr = err;
      const isTimeout = categorizeFailure(err) === 'timeout';
      const retriesRemain = attempt < MAX_MERGE_RETRIES;
      if (!isTimeout || !retriesRemain) {
        break;
      }
      const baseDelay = RETRY_BASE_DELAY_MS * RETRY_BACKOFF_FACTOR ** attempt;
      const delayMs = Math.round(baseDelay * (1 + RETRY_JITTER_FRACTION * jitter()));
      if (args.onRetryAttempt) {
        await args.onRetryAttempt({ attempt: attempt + 1, delayMs, reason: 'timeout' });
      }
      await sleep(delayMs);
    }
  }

  {
    const err = lastErr;
    const reason = categorizeFailure(err);
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
 * Recovery ladder for a failed merge. It returns `undefined` when the worktree lands cleanly on `recoveryPointSha`.
 * 1. `git merge --abort` is best effort. It fails when no merge is in progress, and the function ignores that failure.
 * 2. `git reset --keep <recoveryPointSha>` rewinds, but refuses to discard local work. The ladder never uses `--hard`, which discards uncommitted work.
 * 3. A `rev-parse HEAD` check confirms that the worktree is on the recovery point.
 *
 * A refused reset gives `reset-keep-blocked`. It is not destructive, but the tree is indeterminate.
 */
function recoverToAnchor(
  gitExec: GitExec,
  repoRoot: string,
  recoveryPointSha: string,
): { code: RecoveryError; detail: string } | undefined {
  try {
    gitExec(repoRoot, ['merge', '--abort']);
  } catch {
  }

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
    return {
      code: 'reset-keep-blocked',
      detail: `git reset --keep ${recoveryPointSha} exited ${reset.exitCode}${reset.stdout ? `: ${reset.stdout.trim()}` : ''}`,
    };
  }

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
