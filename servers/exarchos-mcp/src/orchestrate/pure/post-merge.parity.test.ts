import { describe, it, expect } from 'vitest';
import { checkPostMerge } from './post-merge.js';
import type { CommandResult } from './post-merge.js';

/**
 * Behavioral parity tests for post-merge.ts against the original
 * scripts/check-post-merge.sh bash script.
 *
 * Bash script behavior:
 *   - 2 checks: CI green (gh pr checks) + test suite (npm run test:run)
 *   - exit 0 → PASS (2/2), exit 1 → FAIL (N/2)
 *   - CI passing states: SUCCESS, NEUTRAL (bash); SUCCESS, SKIPPED, NEUTRAL (TS)
 */

const PR_URL = 'https://github.com/org/repo/pull/42';
const MERGE_SHA = 'abc1234def5678';

function makeAllPassRunner(): (cmd: string, args: readonly string[]) => CommandResult {
  return (cmd: string): CommandResult => {
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
  return (cmd: string): CommandResult => {
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
  return (cmd: string): CommandResult => {
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

function makeBothFailRunner(): (cmd: string, args: readonly string[]) => CommandResult {
  return (cmd: string): CommandResult => {
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
      return { exitCode: 1, stdout: '', stderr: 'Test failures\n' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

function makeSkippedCiRunner(): (cmd: string, args: readonly string[]) => CommandResult {
  return (cmd: string): CommandResult => {
    if (cmd === 'gh') {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          { name: 'build', state: 'SUCCESS' },
          { name: 'optional', state: 'SKIPPED' },
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

describe('behavioral parity with check-post-merge.sh', () => {
  it('all pass — CI green + tests pass yields PASS (2/2)', () => {
    expect(checkPostMerge({
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      runCommand: makeAllPassRunner(),
    })).toEqual({
      status: 'pass',
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      passCount: 2,
      failCount: 0,
      results: [
        '- **PASS**: CI green (all checks SUCCESS, SKIPPED, or NEUTRAL)',
        '- **PASS**: Test suite (npm run test:run passed)',
      ],
      findings: [],
      report: [
        '## Post-Merge Regression Report',
        '',
        `**PR:** \`${PR_URL}\``,
        `**Merge SHA:** \`${MERGE_SHA}\``,
        '',
        '- **PASS**: CI green (all checks SUCCESS, SKIPPED, or NEUTRAL)',
        '- **PASS**: Test suite (npm run test:run passed)',
        '',
        '---',
        '',
        '**Result: PASS** (2/2 checks passed)',
      ].join('\n'),
    });
  });

  it('CI fail — lint FAILURE yields FAIL (1/2)', () => {
    expect(checkPostMerge({
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      runCommand: makeCiFailRunner(),
    })).toEqual({
      status: 'fail',
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      passCount: 1,
      failCount: 1,
      results: [
        '- **FAIL**: CI green -- Failed checks: lint (FAILURE)',
        '- **PASS**: Test suite (npm run test:run passed)',
      ],
      findings: [
        'FINDING [D4] [HIGH] criterion="ci-green" evidence="Failed checks: lint (FAILURE)"',
      ],
      report: [
        '## Post-Merge Regression Report',
        '',
        `**PR:** \`${PR_URL}\``,
        `**Merge SHA:** \`${MERGE_SHA}\``,
        '',
        '- **FAIL**: CI green -- Failed checks: lint (FAILURE)',
        '- **PASS**: Test suite (npm run test:run passed)',
        '',
        '---',
        '',
        '**Result: FAIL** (1/2 checks failed)',
      ].join('\n'),
    });
  });

  it('test fail — test suite failure yields FAIL (1/2)', () => {
    expect(checkPostMerge({
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      runCommand: makeTestFailRunner(),
    })).toEqual({
      status: 'fail',
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      passCount: 1,
      failCount: 1,
      results: [
        '- **PASS**: CI green (all checks SUCCESS, SKIPPED, or NEUTRAL)',
        '- **FAIL**: Test suite -- npm run test:run failed',
      ],
      findings: [
        `FINDING [D4] [HIGH] criterion="test-suite" evidence="npm run test:run failed (merge-sha: ${MERGE_SHA})"`,
      ],
      report: [
        '## Post-Merge Regression Report',
        '',
        `**PR:** \`${PR_URL}\``,
        `**Merge SHA:** \`${MERGE_SHA}\``,
        '',
        '- **PASS**: CI green (all checks SUCCESS, SKIPPED, or NEUTRAL)',
        '- **FAIL**: Test suite -- npm run test:run failed',
        '',
        '---',
        '',
        '**Result: FAIL** (1/2 checks failed)',
      ].join('\n'),
    });
  });

  it('both fail — CI + test failures yield FAIL (0/2)', () => {
    expect(checkPostMerge({
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      runCommand: makeBothFailRunner(),
    })).toEqual({
      status: 'fail',
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      passCount: 0,
      failCount: 2,
      results: [
        '- **FAIL**: CI green -- Failed checks: lint (FAILURE)',
        '- **FAIL**: Test suite -- npm run test:run failed',
      ],
      findings: [
        'FINDING [D4] [HIGH] criterion="ci-green" evidence="Failed checks: lint (FAILURE)"',
        `FINDING [D4] [HIGH] criterion="test-suite" evidence="npm run test:run failed (merge-sha: ${MERGE_SHA})"`,
      ],
      report: [
        '## Post-Merge Regression Report',
        '',
        `**PR:** \`${PR_URL}\``,
        `**Merge SHA:** \`${MERGE_SHA}\``,
        '',
        '- **FAIL**: CI green -- Failed checks: lint (FAILURE)',
        '- **FAIL**: Test suite -- npm run test:run failed',
        '',
        '---',
        '',
        '**Result: FAIL** (2/2 checks failed)',
      ].join('\n'),
    });
  });

  it('SKIPPED CI state — treated as passing (GitHub treats SKIPPED as successful)', () => {
    expect(checkPostMerge({
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      runCommand: makeSkippedCiRunner(),
    })).toEqual({
      status: 'pass',
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      passCount: 2,
      failCount: 0,
      results: [
        '- **PASS**: CI green (all checks SUCCESS, SKIPPED, or NEUTRAL)',
        '- **PASS**: Test suite (npm run test:run passed)',
      ],
      findings: [],
      report: [
        '## Post-Merge Regression Report',
        '',
        `**PR:** \`${PR_URL}\``,
        `**Merge SHA:** \`${MERGE_SHA}\``,
        '',
        '- **PASS**: CI green (all checks SUCCESS, SKIPPED, or NEUTRAL)',
        '- **PASS**: Test suite (npm run test:run passed)',
        '',
        '---',
        '',
        '**Result: PASS** (2/2 checks passed)',
      ].join('\n'),
    });
  });
});
