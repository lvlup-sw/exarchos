// ─── execute-merge: recordRecoveryPoint tests ──────────────────────────────
//
// T08 — pure helper that captures HEAD sha as a rollback point before merge
// execution (T09/T10 compose executeMerge on top). Must NEVER throw — all
// failure modes return a structured `{ error }` result.
// ───────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { recordRecoveryPoint, executeMerge, type GitExec } from './execute-merge.js';

describe('recordRecoveryPoint', () => {
  it('recordRecoveryPoint_HappyPath_ReturnsHeadSha', () => {
    const gitExec: GitExec = vi.fn((_repoRoot: string, args: readonly string[]) => {
      expect(args).toEqual(['rev-parse', 'HEAD']);
      return { stdout: 'abc1234567890\n', exitCode: 0 };
    });

    const result = recordRecoveryPoint(gitExec, '/some/repo');

    expect(result).toEqual({ sha: 'abc1234567890' });
    expect(gitExec).toHaveBeenCalledTimes(1);
  });

  it('recordRecoveryPoint_GitFails_ReturnsStructuredError', () => {
    const gitExec: GitExec = vi.fn(() => ({ stdout: '', exitCode: 128 }));

    const result = recordRecoveryPoint(gitExec, '/some/repo');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('recordRecoveryPoint_GitThrows_ReturnsStructuredError_DoesNotThrow', () => {
    const gitExec: GitExec = vi.fn(() => {
      throw new Error('spawn ENOENT');
    });

    expect(() => recordRecoveryPoint(gitExec, '/some/repo')).not.toThrow();
    const result = recordRecoveryPoint(gitExec, '/some/repo');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('spawn ENOENT');
    }
  });

  it('recordRecoveryPoint_EmptyStdout_ReturnsStructuredError', () => {
    const gitExec: GitExec = vi.fn(() => ({ stdout: '   \n', exitCode: 0 }));

    const result = recordRecoveryPoint(gitExec, '/some/repo');

    expect('error' in result).toBe(true);
  });
});

describe('executeMerge', () => {
  it('executeMerge_MergeSucceeds_ReturnsMergeShaAndPhaseCompleted', async () => {
    const gitExec: GitExec = vi.fn((_repoRoot: string, args: readonly string[]) => {
      expect(args).toEqual(['rev-parse', 'HEAD']);
      return { stdout: 'rollback-sha-abc\n', exitCode: 0 };
    });
    const vcsMerge = vi.fn(async () => ({ mergeSha: 'merge-sha-xyz' }));
    const persistState = vi.fn(async () => {});

    const result = await executeMerge({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      strategy: 'squash',
      gitExec,
      vcsMerge,
      persistState,
    });

    expect(result).toEqual({
      phase: 'completed',
      mergeSha: 'merge-sha-xyz',
      recoveryPointSha: 'rollback-sha-abc',
    });
    expect(vcsMerge).toHaveBeenCalledWith({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      strategy: 'squash',
    });
  });

  it('executeMerge_RecordsRollbackShaBeforeMergeCall_OrderingPreserved', async () => {
    const calls: string[] = [];

    const gitExec: GitExec = vi.fn((_repoRoot: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        calls.push('rev-parse-HEAD');
        return { stdout: 'rollback-sha-abc\n', exitCode: 0 };
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    const persistState = vi.fn(async (state: { phase: 'executing'; recoveryPointSha: string }) => {
      calls.push(`persistState({phase:${state.phase},recoveryPointSha:${state.recoveryPointSha}})`);
    });

    const vcsMerge = vi.fn(async () => {
      calls.push('vcsMerge');
      return { mergeSha: 'merge-sha-xyz' };
    });

    const result = await executeMerge({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      strategy: 'squash',
      gitExec,
      vcsMerge,
      persistState,
    });

    expect(calls).toEqual([
      'rev-parse-HEAD',
      'persistState({phase:executing,recoveryPointSha:rollback-sha-abc})',
      'vcsMerge',
    ]);
    expect(result.phase).toBe('completed');
  });

  // ─── T10: rollback paths ────────────────────────────────────────────────

  it('executeMerge_VcsMergeRejects_ResetsToRollbackShaWithReasonMergeFailed', async () => {
    const gitCalls: Array<readonly string[]> = [];
    const gitExec: GitExec = vi.fn((_repoRoot: string, args: readonly string[]) => {
      gitCalls.push(args);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: 'abc\n', exitCode: 0 };
      }
      if (args[0] === 'merge' && args[1] === '--abort') {
        return { stdout: '', exitCode: 0 };
      }
      if (args[0] === 'reset' && args[1] === '--keep') {
        return { stdout: '', exitCode: 0 };
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });
    const vcsMerge = vi.fn(async () => {
      throw new Error('merge conflict in foo.ts');
    });
    const persistState = vi.fn(async () => {});

    const result = await executeMerge({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      strategy: 'squash',
      gitExec,
      vcsMerge,
      persistState,
      repoRoot: '/some/repo',
    });

    expect(result).toEqual({
      phase: 'rolled-back',
      recoveryPointSha: 'abc',
      reason: 'merge-failed',
    });
    // INV-14: native primitive first (`git merge --abort`), then refuse-to-discard
    // substrate undo (`git reset --keep`). NEVER the destructive `--hard`.
    expect(gitCalls).toContainEqual(['merge', '--abort']);
    expect(gitCalls).toContainEqual(['reset', '--keep', 'abc']);
    expect(gitCalls.some((c) => c[0] === 'reset' && c[1] === '--hard')).toBe(false);
  });

  it('executeMerge_VerificationFails_ReasonVerificationFailed', async () => {
    // Categorization convention: err.message matches /verification/i.
    const gitExec: GitExec = vi.fn((_repoRoot: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: 'abc\n', exitCode: 0 };
      }
      if (args[0] === 'merge' && args[1] === '--abort') {
        return { stdout: '', exitCode: 0 };
      }
      if (args[0] === 'reset' && args[1] === '--keep') {
        return { stdout: '', exitCode: 0 };
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });
    const vcsMerge = vi.fn(async () => {
      throw new Error('post-merge verification failed: tests red');
    });
    const persistState = vi.fn(async () => {});

    const result = await executeMerge({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      strategy: 'squash',
      gitExec,
      vcsMerge,
      persistState,
      repoRoot: '/some/repo',
    });

    expect(result).toEqual({
      phase: 'rolled-back',
      recoveryPointSha: 'abc',
      reason: 'verification-failed',
    });
  });

  it('executeMerge_GitTimeout_ReasonTimeout', async () => {
    // Categorization convention: err.name === 'TimeoutError' OR (err as any).code === 'ETIMEDOUT'.
    const gitExec: GitExec = vi.fn((_repoRoot: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: 'abc\n', exitCode: 0 };
      }
      if (args[0] === 'merge' && args[1] === '--abort') {
        return { stdout: '', exitCode: 0 };
      }
      if (args[0] === 'reset' && args[1] === '--keep') {
        return { stdout: '', exitCode: 0 };
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });
    const vcsMerge = vi.fn(async () => {
      const err = new Error('operation timed out');
      (err as Error & { code?: string }).code = 'ETIMEDOUT';
      throw err;
    });
    const persistState = vi.fn(async () => {});

    const result = await executeMerge({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      strategy: 'squash',
      gitExec,
      vcsMerge,
      persistState,
      repoRoot: '/some/repo',
      // T09 (#1308): a timeout now triggers the bounded retry loop before
      // recovery. Inject a no-op sleep + zero jitter so this assertion still
      // exercises the timeout→exhaustion→recovery path without paying the
      // real backoff wall time. The retry mechanics themselves are covered by
      // the dedicated `ExecuteMerge_Timeout*` tests below.
      sleep: async () => {},
      jitter: () => 0,
    });

    // After exhausting the timeout retries, vcsMerge was called 3 times
    // (1 initial + MAX_MERGE_RETRIES) and the executor recovers with reason
    // 'timeout'.
    expect(vcsMerge).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      phase: 'rolled-back',
      recoveryPointSha: 'abc',
      reason: 'timeout',
    });
  });

  it('executeMerge_RollbackPath_AfterReset_PhaseRolledBack', async () => {
    // INV-14 ordering: `git merge --abort` (native primitive) then
    // `git reset --keep <sha>` (substrate undo) must run BEFORE the rolled-back
    // result is returned — and `--hard` must never be invoked.
    const calls: string[] = [];
    const gitExec: GitExec = vi.fn((_repoRoot: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        calls.push('rev-parse-HEAD');
        return { stdout: 'abc\n', exitCode: 0 };
      }
      if (args[0] === 'merge' && args[1] === '--abort') {
        calls.push('merge-abort');
        return { stdout: '', exitCode: 0 };
      }
      if (args[0] === 'reset' && args[1] === '--keep') {
        calls.push(`reset-keep-${args[2]}`);
        return { stdout: '', exitCode: 0 };
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });
    const vcsMerge = vi.fn(async () => {
      calls.push('vcsMerge-rejects');
      throw new Error('boom');
    });
    const persistState = vi.fn(async (state: { phase: 'executing'; recoveryPointSha: string }) => {
      calls.push(`persistState({phase:${state.phase}})`);
    });

    const result = await executeMerge({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      strategy: 'squash',
      gitExec,
      vcsMerge,
      persistState,
      repoRoot: '/some/repo',
    });

    // Recovery happens before finalize; native primitive precedes substrate undo.
    const abortIdx = calls.indexOf('merge-abort');
    const resetIdx = calls.indexOf('reset-keep-abc');
    const mergeIdx = calls.indexOf('vcsMerge-rejects');
    expect(mergeIdx).toBeGreaterThan(-1);
    expect(abortIdx).toBeGreaterThan(mergeIdx);
    expect(resetIdx).toBeGreaterThan(abortIdx);
    expect(result.phase).toBe('rolled-back');
    if (result.phase === 'rolled-back') {
      expect(result.recoveryPointSha).toBe('abc');
    }
  });

  it('executeMerge_ResetKeepExitsNonZero_SurfacesResetKeepBlocked', async () => {
    // When `git reset --keep` refuses (exits non-zero) rather than discard
    // local work, the worktree is indeterminate but NON-destructive. INV-14's
    // 'reset-keep-blocked' case — surfaced so callers escalate, not silently
    // treated as a clean rollback.
    const gitExec: GitExec = vi.fn((_repoRoot: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: 'abc\n', exitCode: 0 };
      }
      if (args[0] === 'merge' && args[1] === '--abort') {
        return { stdout: '', exitCode: 0 };
      }
      if (args[0] === 'reset' && args[1] === '--keep') {
        return { stdout: 'error: would overwrite untracked file', exitCode: 128 };
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });
    const vcsMerge = vi.fn(async () => {
      throw new Error('merge conflict');
    });
    const persistState = vi.fn(async () => {});

    const result = await executeMerge({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      strategy: 'squash',
      gitExec,
      vcsMerge,
      persistState,
      repoRoot: '/some/repo',
    });

    expect(result.phase).toBe('rolled-back');
    if (result.phase === 'rolled-back') {
      expect(result.recoveryPointSha).toBe('abc');
      expect(result.reason).toBe('merge-failed');
      expect(result.recoveryError).toBe('reset-keep-blocked');
      expect(result.recoveryErrorDetail).toMatch(/exited 128/);
    }
  });

  it('executeMerge_ResetKeepThrows_SurfacesResetFailed', async () => {
    // When `git reset --keep` itself throws (e.g. git missing), the worktree is
    // indeterminate — INV-14's 'reset-failed' case.
    const gitExec: GitExec = vi.fn((_repoRoot: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: 'abc\n', exitCode: 0 };
      }
      if (args[0] === 'merge' && args[1] === '--abort') {
        return { stdout: '', exitCode: 0 };
      }
      if (args[0] === 'reset' && args[1] === '--keep') {
        throw new Error('git binary missing');
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });
    const vcsMerge = vi.fn(async () => {
      throw new Error('boom');
    });
    const persistState = vi.fn(async () => {});

    const result = await executeMerge({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      strategy: 'squash',
      gitExec,
      vcsMerge,
      persistState,
      repoRoot: '/some/repo',
    });

    expect(result.phase).toBe('rolled-back');
    if (result.phase === 'rolled-back') {
      expect(result.recoveryError).toBe('reset-failed');
      expect(result.recoveryErrorDetail).toMatch(/git binary missing/);
    }
  });

  it('executeMerge_RecoveryLeavesDrift_SurfacesUnexpectedMidMergeDrift', async () => {
    // `git merge --abort` + `git reset --keep` both report success (exit 0) but
    // HEAD does NOT land on the rollback anchor — INV-14's indeterminate
    // post-recovery case. First rev-parse records the anchor; the post-recovery
    // drift check sees a different sha.
    let headCall = 0;
    const gitExec: GitExec = vi.fn((_repoRoot: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        headCall += 1;
        return { stdout: headCall === 1 ? 'abc\n' : 'deadbeef\n', exitCode: 0 };
      }
      if (args[0] === 'merge' && args[1] === '--abort') {
        return { stdout: '', exitCode: 0 };
      }
      if (args[0] === 'reset' && args[1] === '--keep') {
        return { stdout: '', exitCode: 0 };
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });
    const vcsMerge = vi.fn(async () => {
      throw new Error('merge conflict');
    });
    const persistState = vi.fn(async () => {});

    const result = await executeMerge({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      strategy: 'squash',
      gitExec,
      vcsMerge,
      persistState,
      repoRoot: '/some/repo',
    });

    expect(result.phase).toBe('rolled-back');
    if (result.phase === 'rolled-back') {
      expect(result.recoveryError).toBe('unexpected-mid-merge-drift');
    }
  });

  // ─── T09 (#1308): bounded timeout-retry with backoff + jitter ────────────
  //
  // ONLY a `'timeout'`-categorized failure enters the retry loop (max 2 retries
  // → 3 total vcsMerge calls). Each retry reports its attempt/delay via the
  // injected `onRetryAttempt` seam (the handler emits `merge.retry_attempt`).
  // The jitter source is INJECTED (workflow-determinism invariant) so tests
  // pin a deterministic value rather than relying on Math.random(). `sleep` is
  // injected too so tests don't actually wait out the backoff.

  // A signed jitter source pinned to 0 → no jitter (delay == base * factor^n).
  const zeroJitter = () => 0;
  // No-op sleep so tests don't pay the real backoff wall time.
  const noSleep = async () => {};

  function makeTimeoutError(message = 'operation timed out'): Error {
    const err = new Error(message);
    (err as Error & { code?: string }).code = 'ETIMEDOUT';
    return err;
  }

  function happyGitExec(): GitExec {
    return vi.fn((_repoRoot: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: 'abc\n', exitCode: 0 };
      }
      // merge --abort / reset --keep both succeed via this catch-all.
      return { stdout: '', exitCode: 0 };
    });
  }

  it('ExecuteMerge_TimeoutOnceThenSuccess_EmitsOneRetryThenExecuted', async () => {
    // vcsMerge times out on the first call, then succeeds. The executor retries
    // exactly ONCE, reports exactly ONE retry attempt, and returns
    // `phase: 'completed'` — NO recovery/rollback ladder runs.
    let call = 0;
    const vcsMerge = vi.fn(async () => {
      call += 1;
      if (call === 1) throw makeTimeoutError();
      return { mergeSha: 'merge-sha-xyz' };
    });
    const persistState = vi.fn(async () => {});
    const retries: Array<{ attempt: number; delayMs: number; reason: string }> = [];
    const onRetryAttempt = vi.fn((info: { attempt: number; delayMs: number; reason: string }) => {
      retries.push(info);
    });
    const gitExec = happyGitExec();

    const result = await executeMerge({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      strategy: 'squash',
      gitExec,
      vcsMerge,
      persistState,
      repoRoot: '/some/repo',
      jitter: zeroJitter,
      sleep: noSleep,
      onRetryAttempt,
    });

    // Completed — no rollback.
    expect(result).toEqual({
      phase: 'completed',
      mergeSha: 'merge-sha-xyz',
      recoveryPointSha: 'abc',
    });
    // Exactly two vcsMerge calls: the timeout + the successful retry.
    expect(vcsMerge).toHaveBeenCalledTimes(2);
    // Exactly ONE retry attempt reported, ordinal 1, reason 'timeout',
    // delay = base (1000) * factor^0 with zero jitter.
    expect(onRetryAttempt).toHaveBeenCalledTimes(1);
    expect(retries).toEqual([{ attempt: 1, delayMs: 1000, reason: 'timeout' }]);
    // No recovery ladder — `git merge --abort` / `git reset --keep` never ran.
    const gitCalls = (gitExec as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1] as readonly string[],
    );
    expect(gitCalls.some((a) => a[0] === 'merge' && a[1] === '--abort')).toBe(false);
    expect(gitCalls.some((a) => a[0] === 'reset')).toBe(false);
  });

  it('ExecuteMerge_NonTimeoutFailure_DoesNotRetry_RecoversImmediately', async () => {
    // A non-timeout failure (default 'merge-failed' bucket) must NOT enter the
    // retry loop — it recovers immediately on the first failure. This guards
    // the T10/T11 exhaustion behavior from being implemented here while
    // confirming the existing immediate-recovery path still fires.
    const vcsMerge = vi.fn(async () => {
      throw new Error('merge conflict in foo.ts');
    });
    const persistState = vi.fn(async () => {});
    const onRetryAttempt = vi.fn();

    const result = await executeMerge({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      strategy: 'squash',
      gitExec: happyGitExec(),
      vcsMerge,
      persistState,
      repoRoot: '/some/repo',
      jitter: zeroJitter,
      sleep: noSleep,
      onRetryAttempt,
    });

    expect(vcsMerge).toHaveBeenCalledTimes(1);
    expect(onRetryAttempt).not.toHaveBeenCalled();
    expect(result).toEqual({
      phase: 'rolled-back',
      recoveryPointSha: 'abc',
      reason: 'merge-failed',
    });
  });

  it('ExecuteMerge_VerificationFailed_NoRetry', async () => {
    // T11: a verification-failed (non-transient) outcome must NOT enter the
    // retry loop — exactly one vcsMerge attempt, zero retries reported, then
    // immediate recovery with reason 'verification-failed'. Only 'timeout' retries.
    const vcsMerge = vi.fn(async () => {
      throw new Error('post-merge verification failed: tests red');
    });
    const persistState = vi.fn(async () => {});
    const onRetryAttempt = vi.fn();

    const result = await executeMerge({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      strategy: 'squash',
      gitExec: happyGitExec(),
      vcsMerge,
      persistState,
      repoRoot: '/some/repo',
      jitter: zeroJitter,
      sleep: noSleep,
      onRetryAttempt,
    });

    expect(vcsMerge).toHaveBeenCalledTimes(1);
    expect(onRetryAttempt).not.toHaveBeenCalled();
    expect(result).toEqual({
      phase: 'rolled-back',
      recoveryPointSha: 'abc',
      reason: 'verification-failed',
    });
  });

  it('ExecuteMerge_TimeoutExhaustsRetries_RecoversWithTimeoutReason', async () => {
    // Persistent timeout: 3 total vcsMerge calls (initial + 2 retries), 2 retry
    // attempts reported, then recovery with reason 'timeout'. Backoff grows by
    // the configured factor (1000 → 2000 with zero jitter).
    const vcsMerge = vi.fn(async () => {
      throw makeTimeoutError();
    });
    const persistState = vi.fn(async () => {});
    const retries: Array<{ attempt: number; delayMs: number; reason: string }> = [];
    const onRetryAttempt = vi.fn((info: { attempt: number; delayMs: number; reason: string }) => {
      retries.push(info);
    });

    const result = await executeMerge({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      strategy: 'squash',
      gitExec: happyGitExec(),
      vcsMerge,
      persistState,
      repoRoot: '/some/repo',
      jitter: zeroJitter,
      sleep: noSleep,
      onRetryAttempt,
    });

    // 1 initial + 2 retries = 3 total attempts.
    expect(vcsMerge).toHaveBeenCalledTimes(3);
    expect(onRetryAttempt).toHaveBeenCalledTimes(2);
    expect(retries).toEqual([
      { attempt: 1, delayMs: 1000, reason: 'timeout' },
      { attempt: 2, delayMs: 2000, reason: 'timeout' },
    ]);
    expect(result.phase).toBe('rolled-back');
    if (result.phase === 'rolled-back') {
      expect(result.reason).toBe('timeout');
    }
  });

  it('ExecuteMerge_JitterApplied_WidensDelayWithinBand', async () => {
    // The injected jitter source perturbs the delay by ±25%. A pinned +1
    // signed-jitter value yields base * (1 + 0.25) = 1250 on the first retry;
    // -1 yields base * (1 - 0.25) = 750. Proves the jitter seam is wired and
    // applied to the computed backoff (not a hard-coded inline Math.random).
    const vcsMerge = vi.fn(async () => {
      throw makeTimeoutError();
    });
    const persistState = vi.fn(async () => {});
    const retries: number[] = [];
    const onRetryAttempt = vi.fn((info: { attempt: number; delayMs: number; reason: string }) => {
      retries.push(info.delayMs);
    });

    await executeMerge({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      strategy: 'squash',
      gitExec: happyGitExec(),
      vcsMerge,
      persistState,
      repoRoot: '/some/repo',
      jitter: () => 1, // max positive jitter
      sleep: noSleep,
      onRetryAttempt,
    });

    // attempt 1: 1000 * (1 + 0.25) = 1250; attempt 2: 2000 * 1.25 = 2500.
    expect(retries).toEqual([1250, 2500]);
  });
});
