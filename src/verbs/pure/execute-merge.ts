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

// ─── Bounded timeout-retry tuning (T09 #1308) ──────────────────────────────
//
// ONLY a `'timeout'`-categorized `vcsMerge` failure is retried — non-transient
// failures fall straight through to the INV-14 recovery ladder. Backoff is
// exponential with bounded jitter; the jitter source is INJECTED (not an inline
// `Math.random()`) to preserve the workflow-determinism invariant, so tests
// pin a deterministic value.

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
  /**
   * Injected jitter source for the bounded timeout-retry backoff (T09 #1308).
   * Returns a signed fraction in `[-1, 1]`; the effective delay is
   * `base * (1 + RETRY_JITTER_FRACTION * jitter())`. INJECTED rather than an
   * inline `Math.random()` so the retry path stays deterministic under test
   * (workflow-determinism invariant). Defaults to a uniform signed
   * `Math.random()`-derived value.
   */
  jitter?: () => number;
  /**
   * Injected delay seam — invoked with the computed backoff (ms) before each
   * retry. Injected so tests skip the real wall-clock wait. Defaults to a real
   * `setTimeout`-based sleep.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Invoked once per retry attempt, BEFORE the re-attempt's `vcsMerge` call, so
   * the handler can emit a `merge.retry_attempt` audit event. `attempt` is the
   * 1-based retry ordinal; `delayMs` is the backoff already applied; `reason`
   * is the transient-failure category that triggered the retry (always
   * `'timeout'` today). Awaited so emission ordering is observable.
   */
  onRetryAttempt?: (info: {
    attempt: number;
    delayMs: number;
    reason: 'timeout';
  }) => Promise<void> | void;
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

  // 3) call vcs merge with a bounded timeout-retry loop (T09 #1308). Only a
  //    `'timeout'`-categorized failure is retried (max MAX_MERGE_RETRIES, so
  //    MAX_MERGE_RETRIES + 1 total attempts); any other failure — or a timeout
  //    after exhausting retries — falls through to the INV-14 recovery ladder.
  //    The jitter source and sleep are injected so the retry path is
  //    deterministic and instant under test.
  const jitter = args.jitter ?? (() => Math.random() * 2 - 1);
  const sleep =
    args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastErr: unknown;
  // attempt index: 0 = initial, 1..MAX_MERGE_RETRIES = retries.
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
        // Non-transient, or out of retry budget → exit the loop and recover.
        break;
      }
      // Exponential backoff with bounded symmetric jitter. The next retry's
      // 1-based ordinal is `attempt + 1`; its base delay is
      // `RETRY_BASE_DELAY_MS * RETRY_BACKOFF_FACTOR^attempt`.
      const baseDelay = RETRY_BASE_DELAY_MS * RETRY_BACKOFF_FACTOR ** attempt;
      const delayMs = Math.round(baseDelay * (1 + RETRY_JITTER_FRACTION * jitter()));
      if (args.onRetryAttempt) {
        await args.onRetryAttempt({ attempt: attempt + 1, delayMs, reason: 'timeout' });
      }
      await sleep(delayMs);
    }
  }

  // Retries exhausted (or non-timeout failure): recover to the anchor and
  // categorize the *last* observed failure.
  {
    const err = lastErr;
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
