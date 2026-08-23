import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPostMerge } from '../../../../src/verbs/pure/post-merge.js';
import type { VcsProvider, CiStatus, CiCheck } from '../../../../src/vcs/provider.js';

// ─── Mock VcsProvider Helper ────────────────────────────────────────────────

function createMockProvider(overrides: {
  checkCi?: CiStatus;
  checkCiError?: Error;
} = {}): VcsProvider {
  const defaultCi: CiStatus = { status: 'pass', checks: [] };

  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: overrides.checkCiError
      ? vi.fn().mockRejectedValue(overrides.checkCiError)
      : vi.fn<(prId: string) => Promise<CiStatus>>().mockResolvedValue(overrides.checkCi ?? defaultCi),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    listPrs: vi.fn(),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    getRepository: vi.fn(),
  };
}

/**
 * Type for the command runner dependency injection (for test suite only).
 */
type CommandResult = { exitCode: number; stdout: string; stderr: string };

function createCommandRunner(results: Record<string, CommandResult>): (
  cmd: string,
  args: readonly string[]
) => CommandResult {
  return (cmd: string, args: readonly string[]) => {
    const key = [cmd, ...args].join(' ');
    for (const [registeredKey, result] of Object.entries(results)) {
      if (key.includes(registeredKey)) {
        return result;
      }
    }
    return { exitCode: 1, stdout: '', stderr: 'command not found' };
  };
}

describe('checkPostMerge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ─── VcsProvider integration ──────────────────────────────────────────

  it('clean merge (all checks pass via provider) returns pass', async () => {
    const provider = createMockProvider({
      checkCi: {
        status: 'pass',
        checks: [
          { name: 'build', status: 'pass' },
          { name: 'test', status: 'pass' },
          { name: 'lint', status: 'skipped' },
        ],
      },
    });

    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 0, stdout: 'All tests passed', stderr: '' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      runCommand: testRunner,
      provider,
    });

    expect(result.status).toBe('pass');
    expect(result.passCount).toBe(2);
    expect(result.failCount).toBe(0);
    expect(provider.checkCi).toHaveBeenCalledWith('https://github.com/org/repo/pull/42');
  });

  it('CI failure after merge via provider returns fail', async () => {
    const provider = createMockProvider({
      checkCi: {
        status: 'fail',
        checks: [
          { name: 'build', status: 'pass' },
          { name: 'test', status: 'fail' },
          { name: 'lint', status: 'pass' },
        ],
      },
    });

    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 0, stdout: 'All tests passed', stderr: '' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      runCommand: testRunner,
      provider,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBeGreaterThanOrEqual(1);
    expect(result.report).toContain('test');
  });

  it('test regression after merge returns fail', async () => {
    const provider = createMockProvider({
      checkCi: {
        status: 'pass',
        checks: [
          { name: 'build', status: 'pass' },
          { name: 'test', status: 'pass' },
        ],
      },
    });

    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 1, stdout: '', stderr: 'FAIL: some test broke' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      runCommand: testRunner,
      provider,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBeGreaterThanOrEqual(1);
    expect(result.report).toContain('FAIL');
  });

  it('both CI and tests fail returns fail with two findings', async () => {
    const provider = createMockProvider({
      checkCi: {
        status: 'fail',
        checks: [
          { name: 'build', status: 'fail' },
          { name: 'test', status: 'fail' },
        ],
      },
    });

    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 1, stdout: '', stderr: 'FAIL: regression' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      runCommand: testRunner,
      provider,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBe(2);
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
  });

  it('provider error reports failure', async () => {
    const provider = createMockProvider({
      checkCiError: new Error('command not found: gh'),
    });

    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 0, stdout: 'All tests passed', stderr: '' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      runCommand: testRunner,
      provider,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBeGreaterThanOrEqual(1);
  });

  it('report output is structured markdown', async () => {
    const provider = createMockProvider({
      checkCi: {
        status: 'pass',
        checks: [{ name: 'build', status: 'pass' }],
      },
    });

    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 0, stdout: 'All tests passed', stderr: '' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      runCommand: testRunner,
      provider,
    });

    expect(result.report).toContain('## Post-Merge Regression Report');
    expect(result.report).toContain('**PR:**');
    expect(result.report).toContain('**Merge SHA:**');
    expect(result.report).toContain('**Result: PASS**');
  });

  it('pending CI checks are treated as non-passing', async () => {
    const provider = createMockProvider({
      checkCi: {
        status: 'pending',
        checks: [{ name: 'build', status: 'pending' }],
      },
    });

    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 0, stdout: 'ok', stderr: '' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      runCommand: testRunner,
      provider,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBe(1);
  });

  it('empty checks from provider returns pass for CI', async () => {
    const provider = createMockProvider({
      checkCi: { status: 'pass', checks: [] },
    });

    const testRunner = createCommandRunner({
      'npm run test:run': { exitCode: 0, stdout: 'ok', stderr: '' },
    });

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      runCommand: testRunner,
      provider,
    });

    expect(result.status).toBe('pass');
    expect(result.passCount).toBe(2);
  });

  // ─── The test command comes from the toolchain, not from a literal ────

  it('PostMerge_UsesResolvedCommand', async () => {
    const provider = createMockProvider({ checkCi: { status: 'pass', checks: [] } });
    const spawned: { cmd: string; args: readonly string[] }[] = [];
    const testRunner = (cmd: string, args: readonly string[]) => {
      spawned.push({ cmd, args });
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    };

    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      // This repository resolves through the toolchain registry's node entry.
      repoRoot: process.cwd(),
      runCommand: testRunner,
      provider,
    });

    expect(result.status).toBe('pass');
    expect(spawned).toEqual([{ cmd: 'npm', args: ['run', 'test:run'] }]);
  });

  it('PostMerge_UnresolvedRuntime_IsIndeterminate_NotPass', async () => {
    const provider = createMockProvider({ checkCi: { status: 'pass', checks: [] } });
    const runner = vi.fn(() => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
    const emptyTree = mkdtempSync(join(tmpdir(), 'post-merge-empty-'));

    try {
      const result = await checkPostMerge({
        prUrl: 'https://github.com/org/repo/pull/42',
        mergeSha: 'abc1234',
        repoRoot: emptyTree,
        runCommand: runner,
        provider,
      });

      // Nothing was spawned, so nothing was verified — and the carrier says so
      // instead of reporting a clean regression check.
      expect(runner).not.toHaveBeenCalled();
      expect(result.status).toBe('indeterminate');
      expect(result.reason).toBeTruthy();
      expect(result.report).toContain('INDETERMINATE');
    } finally {
      rmSync(emptyTree, { recursive: true, force: true });
    }
  });

  // ─── A run that produced no verdict is not a regression ───────────────

  it('PostMerge_RunnerNeverStarts_IsIndeterminate_NotARegression', async () => {
    const provider = createMockProvider({ checkCi: { status: 'pass', checks: [] } });
    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      repoRoot: process.cwd(),
      runCommand: () => ({
        exitCode: 127,
        stdout: '',
        stderr: '',
        spawnError: 'ENOENT: spawnSync npm ENOENT',
      }),
      provider,
    });

    expect(result.status).toBe('indeterminate');
    expect(result.reason).toContain('ENOENT');
    // Discriminating: no D4 finding is minted from a check that never ran.
    expect(result.findings).toEqual([]);
    expect(result.report).toContain('INDETERMINATE');
  });

  it('PostMerge_RunnerTimesOut_IsIndeterminate_NotARegression', async () => {
    const provider = createMockProvider({ checkCi: { status: 'pass', checks: [] } });
    const result = await checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      repoRoot: process.cwd(),
      // A killed runner: the non-zero status belongs to the kill, and the
      // truncated stdout says nothing about the suite.
      runCommand: () => ({ exitCode: 124, stdout: 'partial', stderr: '', timedOut: true }),
      provider,
    });

    expect(result.status).toBe('indeterminate');
    expect(result.reason).toContain('time limit');
    expect(result.findings).toEqual([]);
  });
});
