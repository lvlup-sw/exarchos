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
      if (args[0] === 'reset' && args[1] === '--hard') {
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
    expect(gitCalls).toContainEqual(['reset', '--hard', 'abc']);
  });

  it('executeMerge_VerificationFails_ReasonVerificationFailed', async () => {
    // Categorization convention: err.message matches /verification/i.
    const gitExec: GitExec = vi.fn((_repoRoot: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: 'abc\n', exitCode: 0 };
      }
      if (args[0] === 'reset' && args[1] === '--hard') {
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
      if (args[0] === 'reset' && args[1] === '--hard') {
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
    // Ordering: git reset --hard <sha> must execute BEFORE the rolled-back result is returned.
    const calls: string[] = [];
    const gitExec: GitExec = vi.fn((_repoRoot: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        calls.push('rev-parse-HEAD');
        return { stdout: 'abc\n', exitCode: 0 };
      }
      if (args[0] === 'reset' && args[1] === '--hard') {
        calls.push(`reset-hard-${args[2]}`);
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

    // Reset must happen before the result is finalized.
    const resetIdx = calls.indexOf('reset-hard-abc');
    const mergeIdx = calls.indexOf('vcsMerge-rejects');
    expect(resetIdx).toBeGreaterThan(-1);
    expect(mergeIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeGreaterThan(mergeIdx);
    expect(result.phase).toBe('rolled-back');
    if (result.phase === 'rolled-back') {
      expect(result.rollbackSha).toBe('abc');
    }
  });

  it('executeMerge_ResetExitsNonZero_SurfacesRollbackError', async () => {
    // When the rollback `git reset --hard` itself fails, the working tree is
    // stranded. The handler must NOT silently return phase: 'rolled-back' as
    // if rollback succeeded — it must surface a `rollbackError` field so the
    // caller can escalate to operator intervention.
    const gitExec: GitExec = vi.fn((_repoRoot: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: 'abc\n', exitCode: 0 };
      }
      if (args[0] === 'reset' && args[1] === '--hard') {
        return { stdout: '', exitCode: 128 };
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
      expect(result.rollbackError).toMatch(/exited 128/);
    }
  });

  it('executeMerge_ResetThrows_SurfacesRollbackError', async () => {
    // Same contract as above when gitExec throws (rather than returns a
    // non-zero exitCode).
    const gitExec: GitExec = vi.fn((_repoRoot: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: 'abc\n', exitCode: 0 };
      }
      if (args[0] === 'reset' && args[1] === '--hard') {
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
      expect(result.rollbackError).toMatch(/git binary missing/);
    }
  });
});
