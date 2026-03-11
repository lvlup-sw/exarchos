import { describe, it, expect } from 'vitest';
import { checkPostMerge } from './post-merge.js';
import type { CommandResult } from './post-merge.js';

/**
 * Behavioral parity tests for post-merge.ts against the original
 * scripts/check-post-merge.sh bash script.
 *
 * Bash script behavior:
 *   - exit 0 → CI green + test suite pass → PASS (2/2 checks passed)
 *   - exit 1 → CI fail or test fail → FAIL (1/2 checks failed)
 */

const PR_URL = 'https://github.com/org/repo/pull/42';
const MERGE_SHA = 'abc1234def5678';

function makeAllPassRunner(): (cmd: string, args: readonly string[]) => CommandResult {
  return (cmd: string, args: readonly string[]): CommandResult => {
    if (cmd === 'gh') {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          { name: 'build', state: 'SUCCESS' },
          { name: 'test', state: 'SUCCESS' },
        ]),
        stderr: '',
      };
    }
    if (cmd === 'npm') {
      return { exitCode: 0, stdout: 'Tests passed\n', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

function makeCiFailRunner(): (cmd: string, args: readonly string[]) => CommandResult {
  return (cmd: string, args: readonly string[]): CommandResult => {
    if (cmd === 'gh') {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          { name: 'build', state: 'SUCCESS' },
          { name: 'lint', state: 'FAILURE' },
        ]),
        stderr: '',
      };
    }
    if (cmd === 'npm') {
      return { exitCode: 0, stdout: 'Tests passed\n', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

function makeTestFailRunner(): (cmd: string, args: readonly string[]) => CommandResult {
  return (cmd: string, args: readonly string[]): CommandResult => {
    if (cmd === 'gh') {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          { name: 'build', state: 'SUCCESS' },
          { name: 'test', state: 'SUCCESS' },
        ]),
        stderr: '',
      };
    }
    if (cmd === 'npm') {
      return { exitCode: 1, stdout: '', stderr: 'Test failures\n' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('behavioral parity with check-post-merge.sh', () => {
  it('all pass — CI green + test suite pass yields PASS (2/2 checks passed)', () => {
    const result = checkPostMerge({
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      runCommand: makeAllPassRunner(),
    });

    expect(result.status).toBe('pass');
    expect(result.passCount).toBe(2);
    expect(result.failCount).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.report).toContain('**Result: PASS** (2/2 checks passed)');
  });

  it('CI fail — failed CI check yields FAIL (1/2 checks failed)', () => {
    const result = checkPostMerge({
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      runCommand: makeCiFailRunner(),
    });

    expect(result.status).toBe('fail');
    expect(result.passCount).toBe(1);
    expect(result.failCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toContain('ci-green');
    expect(result.findings[0]).toContain('lint (FAILURE)');
    expect(result.report).toContain('**Result: FAIL** (1/2 checks failed)');
  });

  it('test fail — test suite failure yields FAIL (1/2 checks failed)', () => {
    const result = checkPostMerge({
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      runCommand: makeTestFailRunner(),
    });

    expect(result.status).toBe('fail');
    expect(result.passCount).toBe(1);
    expect(result.failCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toContain('test-suite');
    expect(result.report).toContain('**Result: FAIL** (1/2 checks failed)');
  });

  it('report contains structured markdown with PR URL and merge SHA', () => {
    const result = checkPostMerge({
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      runCommand: makeAllPassRunner(),
    });

    expect(result.report).toContain('## Post-Merge Regression Report');
    expect(result.report).toContain(`\`${PR_URL}\``);
    expect(result.report).toContain(`\`${MERGE_SHA}\``);
    expect(result.prUrl).toBe(PR_URL);
    expect(result.mergeSha).toBe(MERGE_SHA);
  });
});
