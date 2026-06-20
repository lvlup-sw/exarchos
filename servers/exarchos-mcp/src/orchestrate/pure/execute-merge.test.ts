// ─── execute-merge: recordRollbackPoint tests ──────────────────────────────
//
// T08 — pure helper that captures HEAD sha as a rollback point before merge
// execution (T09/T10 compose executeMerge on top). Must NEVER throw — all
// failure modes return a structured `{ error }` result.
// ───────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { recordRollbackPoint, executeMerge, type GitExec } from './execute-merge.js';

describe('recordRollbackPoint', () => {
  it('recordRollbackPoint_HappyPath_ReturnsHeadSha', () => {
    const gitExec: GitExec = vi.fn((_repoRoot: string, args: readonly string[]) => {
      expect(args).toEqual(['rev-parse', 'HEAD']);
      return { stdout: 'abc1234567890\n', exitCode: 0 };
    });

    const result = recordRollbackPoint(gitExec, '/some/repo');

    expect(result).toEqual({ sha: 'abc1234567890' });
    expect(gitExec).toHaveBeenCalledTimes(1);
  });

  it('recordRollbackPoint_GitFails_ReturnsStructuredError', () => {
    const gitExec: GitExec = vi.fn(() => ({ stdout: '', exitCode: 128 }));

    const result = recordRollbackPoint(gitExec, '/some/repo');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('recordRollbackPoint_GitThrows_ReturnsStructuredError_DoesNotThrow', () => {
    const gitExec: GitExec = vi.fn(() => {
      throw new Error('spawn ENOENT');
    });

    expect(() => recordRollbackPoint(gitExec, '/some/repo')).not.toThrow();
    const result = recordRollbackPoint(gitExec, '/some/repo');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('spawn ENOENT');
    }
  });

  it('recordRollbackPoint_EmptyStdout_ReturnsStructuredError', () => {
    const gitExec: GitExec = vi.fn(() => ({ stdout: '   \n', exitCode: 0 }));

    const result = recordRollbackPoint(gitExec, '/some/repo');

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
      rollbackSha: 'rollback-sha-abc',
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

    const persistState = vi.fn(async (state: { phase: 'executing'; rollbackSha: string }) => {
      calls.push(`persistState({phase:${state.phase},rollbackSha:${state.rollbackSha}})`);
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
      'persistState({phase:executing,rollbackSha:rollback-sha-abc})',
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
      rollbackSha: 'abc',
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
      rollbackSha: 'abc',
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
    });

    expect(result).toEqual({
      phase: 'rolled-back',
      rollbackSha: 'abc',
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
    const persistState = vi.fn(async (state: { phase: 'executing'; rollbackSha: string }) => {
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
      expect(result.rollbackSha).toBe('abc');
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
      expect(result.rollbackSha).toBe('abc');
      expect(result.reason).toBe('merge-failed');
      expect(result.recoveryError).toBe('reset-keep-blocked');
      expect(result.rollbackError).toMatch(/exited 128/);
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
      expect(result.rollbackError).toMatch(/git binary missing/);
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
});
