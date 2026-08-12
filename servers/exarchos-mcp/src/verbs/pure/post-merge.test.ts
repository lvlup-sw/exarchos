import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkPostMerge } from './post-merge.js';
import type { VcsProvider, CiStatus, CiCheck } from '../../vcs/provider.js';

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
});
