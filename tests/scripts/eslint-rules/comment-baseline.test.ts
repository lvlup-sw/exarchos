/**
 * @fileoverview Tests for the `comments/comment-baseline` ESLint rule, which reports stale entries.
 */
import { it, expect, afterEach } from 'vitest';
import { Linter } from 'eslint';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import commentBaseline from '../../../tools/eslint-rules/comment-baseline.js';
import { resetCaches } from '../../../tools/eslint-rules/comment-context.js';
import { fingerprint } from '../../../tools/audit/lib/comment-baseline.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const RULE_ID = 'comments/comment-baseline';
const OFFENDER = '// DR-7: fsync before rename';

afterEach(() => {
  delete process.env.EXARCHOS_COMMENT_BASELINE;
  resetCaches();
});

/** Lint `code` as `src/a.ts` with only the baseline rule on, against a scratch baseline. */
function lintWithBaseline(code: string, lines: string[]): Linter.LintMessage[] {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'comment-baseline-')), 'baseline.tsv');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  process.env.EXARCHOS_COMMENT_BASELINE = file;
  resetCaches();
  const linter = new Linter({ configType: 'flat', cwd: REPO_ROOT });
  return linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        plugins: { comments: { rules: { 'comment-baseline': commentBaseline } } },
        rules: { [RULE_ID]: 'error' },
      },
    ],
    { filename: path.join(REPO_ROOT, 'src/a.ts') },
  );
}

it('BaselineRule_EntryThatStillMatches_NotReported', () => {
  expect(lintWithBaseline(`${OFFENDER}\n`, [`src/a.ts\t${fingerprint(OFFENDER)}\t1`])).toEqual([]);
});

it('BaselineRule_FixedBlock_ReportsTheStaleEntry', () => {
  const messages = lintWithBaseline('// fsync before rename\n', [`src/a.ts\t${fingerprint(OFFENDER)}\t1`]);

  expect(messages).toHaveLength(1);
  expect(messages[0]?.message).toMatch(/lists 1 block\(s\).*but 0 still break/);
});

it('BaselineRule_CountAboveTheViolatingCopies_ReportsTheStaleEntry', () => {
  const messages = lintWithBaseline(`${OFFENDER}\n`, [`src/a.ts\t${fingerprint(OFFENDER)}\t2`]);

  expect(messages[0]?.message).toMatch(/lists 2 block\(s\).*but 1 still break/);
});

it('BaselineRule_EntryForAnExemptFile_IsStale', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'comment-baseline-')), 'baseline.tsv');
  const rel = 'tools/audit/__fixtures__/comment-hygiene/offenders.ts';
  fs.writeFileSync(file, `${rel}\t${fingerprint(OFFENDER)}\t1\n`);
  process.env.EXARCHOS_COMMENT_BASELINE = file;
  resetCaches();
  const linter = new Linter({ configType: 'flat', cwd: REPO_ROOT });
  const messages = linter.verify(
    `${OFFENDER}\n`,
    [{ files: ['**/*.ts'], plugins: { comments: { rules: { 'comment-baseline': commentBaseline } } }, rules: { [RULE_ID]: 'error' } }],
    { filename: path.join(REPO_ROOT, rel) },
  );

  expect(messages).toHaveLength(1);
});
