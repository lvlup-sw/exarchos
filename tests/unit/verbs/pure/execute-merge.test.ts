/**
 * Tests for `recordRecoveryPoint` and `executeMerge`.
 *
 * `recordRecoveryPoint` captures the HEAD sha as a rollback point before a merge.
 * It never throws: each failure returns a structured `{ error }` result.
 */

import { describe, it, expect, vi } from 'vitest';
import { recordRecoveryPoint, executeMerge, type GitExec } from '../../../../src/verbs/pure/execute-merge.js';

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

/**
 * Only a failure in the `timeout` category enters the retry loop, with at most two retries.
 * Each retry reports its attempt and delay through the `onRetryAttempt` seam.
 * The retry tests inject the jitter source and `sleep`, so the delays are fixed and the tests do not wait.
 */
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

  /**
   * Recovery runs the native `git merge --abort` first and then `git reset --keep`, which refuses to discard work.
   * It never runs `git reset --hard`.
   */
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
    expect(gitCalls).toContainEqual(['merge', '--abort']);
    expect(gitCalls).toContainEqual(['reset', '--keep', 'abc']);
    expect(gitCalls.some((c) => c[0] === 'reset' && c[1] === '--hard')).toBe(false);
  });

  /** A failure whose message matches `/verification/i` is in the `verification-failed` category. */
  it('executeMerge_VerificationFails_ReasonVerificationFailed', async () => {
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

  /**
   * A failure with the name `TimeoutError` or the code `ETIMEDOUT` is in the `timeout` category, so it starts the retry loop.
   * The no-op `sleep` and zero jitter keep the test fast. The `ExecuteMerge_Timeout*` tests cover the retry details.
   */
  it('executeMerge_GitTimeout_ReasonTimeout', async () => {
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
      sleep: async () => {},
      jitter: () => 0,
    });

    expect(vcsMerge).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      phase: 'rolled-back',
      recoveryPointSha: 'abc',
      reason: 'timeout',
    });
  });

  /** `git merge --abort` and then `git reset --keep <sha>` run before the executor returns the rolled-back result. */
  it('executeMerge_RollbackPath_AfterReset_PhaseRolledBack', async () => {
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

  /**
   * When `git reset --keep` refuses to discard local work, the tree is indeterminate but intact.
   * The result reports `reset-keep-blocked`, so the caller can escalate.
   */
  it('executeMerge_ResetKeepExitsNonZero_SurfacesResetKeepBlocked', async () => {
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

  /** When `git reset --keep` throws, the tree is indeterminate and the result reports `reset-failed`. */
  it('executeMerge_ResetKeepThrows_SurfacesResetFailed', async () => {
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

  /**
   * Both recovery commands exit 0, but HEAD does not return to the rollback anchor.
   * The drift check after recovery sees a different sha.
   */
  it('executeMerge_RecoveryLeavesDrift_SurfacesUnexpectedMidMergeDrift', async () => {
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

  const zeroJitter = () => 0;
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
      return { stdout: '', exitCode: 0 };
    });
  }

  /**
   * The first call times out and the retry succeeds.
   * The executor reports one retry and does not run the recovery commands.
   */
  it('ExecuteMerge_TimeoutOnceThenSuccess_EmitsOneRetryThenExecuted', async () => {
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

    expect(result).toEqual({
      phase: 'completed',
      mergeSha: 'merge-sha-xyz',
      recoveryPointSha: 'abc',
    });
    expect(vcsMerge).toHaveBeenCalledTimes(2);
    expect(onRetryAttempt).toHaveBeenCalledTimes(1);
    expect(retries).toEqual([{ attempt: 1, delayMs: 1000, reason: 'timeout' }]);
    const gitCalls = (gitExec as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1] as readonly string[],
    );
    expect(gitCalls.some((a) => a[0] === 'merge' && a[1] === '--abort')).toBe(false);
    expect(gitCalls.some((a) => a[0] === 'reset')).toBe(false);
  });

  /** A failure outside the `timeout` category does not retry and recovers at once. */
  it('ExecuteMerge_NonTimeoutFailure_DoesNotRetry_RecoversImmediately', async () => {
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

  /** A verification failure does not retry. Only a timeout retries. */
  it('ExecuteMerge_VerificationFailed_NoRetry', async () => {
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

  /** A persistent timeout gives three calls and two reported retries, and the delay grows from 1000 to 2000 ms. */
  it('ExecuteMerge_TimeoutExhaustsRetries_RecoversWithTimeoutReason', async () => {
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

  /**
   * The jitter source moves the delay by up to 25 percent.
   * A pinned value of 1 gives 1.25 times the backoff delay of each retry.
   */
  it('ExecuteMerge_JitterApplied_WidensDelayWithinBand', async () => {
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
      jitter: () => 1,
      sleep: noSleep,
      onRetryAttempt,
    });

    expect(retries).toEqual([1250, 2500]);
  });
});
