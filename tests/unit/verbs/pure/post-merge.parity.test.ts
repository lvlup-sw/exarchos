// Behavioral parity of `checkPostMerge` with the test-suite leg of `check-post-merge.sh`.
// The CI-status leg is gone, so the gate has one check and reports PASS only when the
// test suite passes. The exact report lines stay as they were for that leg.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPostMerge } from '../../../../src/verbs/pure/post-merge.js';
import type { CommandResult } from '../../../../src/verbs/pure/post-merge.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

const PR_URL = 'https://github.com/org/repo/pull/42';
const MERGE_SHA = 'abc1234def5678';

function makeTestPassRunner(): (cmd: string, args: readonly string[]) => CommandResult {
  return (): CommandResult => ({ exitCode: 0, stdout: 'Tests passed\n', stderr: '' });
}

function makeTestFailRunner(): (cmd: string, args: readonly string[]) => CommandResult {
  return (): CommandResult => ({ exitCode: 1, stdout: '', stderr: 'Test failures\n' });
}

/** The node fixture repo makes the resolved test command `npm run test:run`. */
describe('behavioral parity with check-post-merge.sh', () => {
  let nodeRepo: string;

  beforeAll(() => {
    nodeRepo = mkdtempSync(join(tmpdir(), 'post-merge-parity-'));
    writeFileSync(join(nodeRepo, 'package.json'), JSON.stringify({ scripts: { 'test:run': 'vitest run' } }));
  });

  afterAll(() => {
    rmrf(nodeRepo);
  });

  it('tests pass yields PASS (1/1)', async () => {
    expect(await checkPostMerge({
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      repoRoot: nodeRepo,
      runCommand: makeTestPassRunner(),
    })).toEqual({
      status: 'pass',
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      passCount: 1,
      failCount: 0,
      results: [
        '- **PASS**: Test suite (npm run test:run passed)',
      ],
      findings: [],
      report: [
        '## Post-Merge Regression Report',
        '',
        `**PR:** \`${PR_URL}\``,
        `**Merge SHA:** \`${MERGE_SHA}\``,
        '',
        '- **PASS**: Test suite (npm run test:run passed)',
        '',
        '---',
        '',
        '**Result: PASS** (1/1 checks passed)',
      ].join('\n'),
    });
  });

  it('test fail — test suite failure yields FAIL (1/1)', async () => {
    expect(await checkPostMerge({
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      repoRoot: nodeRepo,
      runCommand: makeTestFailRunner(),
    })).toEqual({
      status: 'fail',
      prUrl: PR_URL,
      mergeSha: MERGE_SHA,
      passCount: 0,
      failCount: 1,
      results: [
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
        '- **FAIL**: Test suite -- npm run test:run failed',
        '',
        '---',
        '',
        '**Result: FAIL** (1/1 checks failed)',
      ].join('\n'),
    });
  });
});
