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
});
