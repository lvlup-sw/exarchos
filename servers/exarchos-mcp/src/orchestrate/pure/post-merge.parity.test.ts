import { describe, it, expect, vi } from 'vitest';
import { checkPostMerge } from './post-merge.js';
import type { CommandResult } from './post-merge.js';
import type { VcsProvider, CiStatus } from '../../vcs/provider.js';

/**
 * Behavioral parity tests for post-merge.ts against the original
 * scripts/check-post-merge.sh bash script.
 *
 * Migrated to use VcsProvider for CI status instead of runCommand('gh', ...).
 *
 * Bash script behavior:
 *   - 2 checks: CI green (gh pr checks) + test suite (npm run test:run)
 *   - exit 0 -> PASS (2/2), exit 1 -> FAIL (N/2)
 *   - CI passing states: SUCCESS, NEUTRAL (bash); pass, skipped (VcsProvider)
 */

const PR_URL = 'https://github.com/org/repo/pull/42';
const MERGE_SHA = 'abc1234def5678';

function createMockProvider(ciStatus: CiStatus): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn<(prId: string) => Promise<CiStatus>>().mockResolvedValue(ciStatus),
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

function makeTestPassRunner(): (cmd: string, args: readonly string[]) => CommandResult {
  return (): CommandResult => ({ exitCode: 0, stdout: 'Tests passed\n', stderr: '' });
}

function makeTestFailRunner(): (cmd: string, args: readonly string[]) => CommandResult {
  return (): CommandResult => ({ exitCode: 1, stdout: '', stderr: 'Test failures\n' });
}

describe('behavioral parity with check-post-merge.sh', () => {
  it('all pass — CI green + tests pass yields PASS (2/2)', async () => {
    const provider = createMockProvider({
      status: 'pass',
      checks: [
        { name: 'build', status: 'pass' },
        { name: 'test', status: 'pass' },
      ],
    });

    expect(await checkPostMerge({
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      runCommand: makeTestPassRunner(),
      provider,
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

  it('CI fail — lint FAILURE yields FAIL (1/2)', async () => {
    const provider = createMockProvider({
      status: 'fail',
      checks: [
        { name: 'build', status: 'pass' },
        { name: 'lint', status: 'fail' },
      ],
    });

    expect(await checkPostMerge({
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      runCommand: makeTestPassRunner(),
      provider,
    })).toEqual({
      status: 'fail',
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      passCount: 1,
      failCount: 1,
      results: [
        '- **FAIL**: CI green -- Failed checks: lint (FAIL)',
        '- **PASS**: Test suite (npm run test:run passed)',
      ],
      findings: [
        'FINDING [D4] [HIGH] criterion="ci-green" evidence="Failed checks: lint (FAIL)"',
      ],
      report: [
        '## Post-Merge Regression Report',
        '',
        `**PR:** \`${PR_URL}\``,
        `**Merge SHA:** \`${MERGE_SHA}\``,
        '',
        '- **FAIL**: CI green -- Failed checks: lint (FAIL)',
        '- **PASS**: Test suite (npm run test:run passed)',
        '',
        '---',
        '',
        '**Result: FAIL** (1/2 checks failed)',
      ].join('\n'),
    });
  });

  it('test fail — test suite failure yields FAIL (1/2)', async () => {
    const provider = createMockProvider({
      status: 'pass',
      checks: [
        { name: 'build', status: 'pass' },
        { name: 'test', status: 'pass' },
      ],
    });

    expect(await checkPostMerge({
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      runCommand: makeTestFailRunner(),
      provider,
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

  it('both fail — CI + test failures yield FAIL (0/2)', async () => {
    const provider = createMockProvider({
      status: 'fail',
      checks: [
        { name: 'build', status: 'pass' },
        { name: 'lint', status: 'fail' },
      ],
    });

    expect(await checkPostMerge({
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      runCommand: makeTestFailRunner(),
      provider,
    })).toEqual({
      status: 'fail',
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      passCount: 0,
      failCount: 2,
      results: [
        '- **FAIL**: CI green -- Failed checks: lint (FAIL)',
        '- **FAIL**: Test suite -- npm run test:run failed',
      ],
      findings: [
        'FINDING [D4] [HIGH] criterion="ci-green" evidence="Failed checks: lint (FAIL)"',
        `FINDING [D4] [HIGH] criterion="test-suite" evidence="npm run test:run failed (merge-sha: ${MERGE_SHA})"`,
      ],
      report: [
        '## Post-Merge Regression Report',
        '',
        `**PR:** \`${PR_URL}\``,
        `**Merge SHA:** \`${MERGE_SHA}\``,
        '',
        '- **FAIL**: CI green -- Failed checks: lint (FAIL)',
        '- **FAIL**: Test suite -- npm run test:run failed',
        '',
        '---',
        '',
        '**Result: FAIL** (2/2 checks failed)',
      ].join('\n'),
    });
  });

  it('SKIPPED CI state — treated as passing', async () => {
    const provider = createMockProvider({
      status: 'pass',
      checks: [
        { name: 'build', status: 'pass' },
        { name: 'optional', status: 'skipped' },
      ],
    });

    expect(await checkPostMerge({
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      runCommand: makeTestPassRunner(),
      provider,
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
