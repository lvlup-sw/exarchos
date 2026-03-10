import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkPostMerge, type PostMergeResult } from './post-merge.js';

/**
 * Type for the command runner dependency injection.
 * Maps command descriptions to { exitCode, stdout, stderr } outcomes.
 */
type CommandResult = { exitCode: number; stdout: string; stderr: string };

function createCommandRunner(results: Record<string, CommandResult>): (
  cmd: string,
  args: readonly string[]
) => CommandResult {
  return (cmd: string, args: readonly string[]) => {
    const key = [cmd, ...args].join(' ');
    // Match by checking if any registered key is a prefix of the actual command
    for (const [registeredKey, result] of Object.entries(results)) {
      if (key.includes(registeredKey)) {
        return result;
      }
    }
    // Default: command not found
    return { exitCode: 1, stdout: '', stderr: 'command not found' };
  };
}

describe('checkPostMerge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('clean merge (all checks pass) returns pass', () => {
    const runner = createCommandRunner({
      'gh pr checks': {
        exitCode: 0,
        stdout: JSON.stringify([
          { name: 'build', state: 'SUCCESS' },
          { name: 'test', state: 'SUCCESS' },
          { name: 'lint', state: 'NEUTRAL' },
        ]),
        stderr: '',
      },
      'npm run test:run': {
        exitCode: 0,
        stdout: 'All tests passed',
        stderr: '',
      },
    });

    const result = checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      runCommand: runner,
    });

    expect(result.status).toBe('pass');
    expect(result.passCount).toBe(2);
    expect(result.failCount).toBe(0);
  });

  it('CI failure after merge returns fail', () => {
    const runner = createCommandRunner({
      'gh pr checks': {
        exitCode: 0,
        stdout: JSON.stringify([
          { name: 'build', state: 'SUCCESS' },
          { name: 'test', state: 'FAILURE' },
          { name: 'lint', state: 'SUCCESS' },
        ]),
        stderr: '',
      },
      'npm run test:run': {
        exitCode: 0,
        stdout: 'All tests passed',
        stderr: '',
      },
    });

    const result = checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      runCommand: runner,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBeGreaterThanOrEqual(1);
    // Should mention the failing check
    expect(result.report).toContain('test');
    expect(result.report).toContain('FAILURE');
  });

  it('test regression after merge returns fail', () => {
    const runner = createCommandRunner({
      'gh pr checks': {
        exitCode: 0,
        stdout: JSON.stringify([
          { name: 'build', state: 'SUCCESS' },
          { name: 'test', state: 'SUCCESS' },
        ]),
        stderr: '',
      },
      'npm run test:run': {
        exitCode: 1,
        stdout: '',
        stderr: 'FAIL: some test broke',
      },
    });

    const result = checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      runCommand: runner,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBeGreaterThanOrEqual(1);
    expect(result.report).toContain('FAIL');
  });

  it('both CI and tests fail returns fail with two findings', () => {
    const runner = createCommandRunner({
      'gh pr checks': {
        exitCode: 0,
        stdout: JSON.stringify([
          { name: 'build', state: 'FAILURE' },
          { name: 'test', state: 'FAILURE' },
        ]),
        stderr: '',
      },
      'npm run test:run': {
        exitCode: 1,
        stdout: '',
        stderr: 'FAIL: regression',
      },
    });

    const result = checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      runCommand: runner,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBe(2);
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
  });

  it('gh CLI not available reports failure', () => {
    const runner = createCommandRunner({
      'gh pr checks': {
        exitCode: 127,
        stdout: '',
        stderr: 'command not found: gh',
      },
      'npm run test:run': {
        exitCode: 0,
        stdout: 'All tests passed',
        stderr: '',
      },
    });

    const result = checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      runCommand: runner,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBeGreaterThanOrEqual(1);
  });

  it('report output is structured markdown', () => {
    const runner = createCommandRunner({
      'gh pr checks': {
        exitCode: 0,
        stdout: JSON.stringify([
          { name: 'build', state: 'SUCCESS' },
        ]),
        stderr: '',
      },
      'npm run test:run': {
        exitCode: 0,
        stdout: 'All tests passed',
        stderr: '',
      },
    });

    const result = checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      runCommand: runner,
    });

    expect(result.report).toContain('## Post-Merge Regression Report');
    expect(result.report).toContain('**PR:**');
    expect(result.report).toContain('**Merge SHA:**');
    expect(result.report).toContain('**Result: PASS**');
  });

  it('gh pr checks command failure reports as finding', () => {
    const runner = createCommandRunner({
      'gh pr checks': {
        exitCode: 1,
        stdout: '',
        stderr: 'error: could not fetch checks',
      },
      'npm run test:run': {
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
      },
    });

    const result = checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      runCommand: runner,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBe(1);
  });

  it('invalid JSON from gh pr checks reports as finding', () => {
    const runner = createCommandRunner({
      'gh pr checks': {
        exitCode: 0,
        stdout: 'not valid json {{{',
        stderr: '',
      },
      'npm run test:run': {
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
      },
    });

    const result = checkPostMerge({
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeSha: 'abc1234',
      runCommand: runner,
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBe(1);
  });
});
