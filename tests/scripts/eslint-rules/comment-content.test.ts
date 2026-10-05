/**
 * @fileoverview Tests for the `comments/comment-content` ESLint rule.
 *
 * They use ESLint's own `Linter`, because `RuleTester` demands an exact, ordered match of every
 * diagnostic, which composes badly with fixtures that hold several cases each.
 */
import { it, expect, afterEach } from 'vitest';
import { Linter } from 'eslint';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import commentContent from '../../../tools/eslint-rules/comment-content.js';
import { resetCaches } from '../../../tools/eslint-rules/comment-context.js';
import { fingerprint } from '../../../tools/audit/lib/comment-baseline.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const RULE_ID = 'comments/comment-content';

afterEach(() => {
  delete process.env.EXARCHOS_COMMENT_BASELINE;
  resetCaches();
});

/** Lint `code` with only the content rule on. Config errors fail the test. */
function lint(code: string, filename = 'src/a.ts'): Linter.LintMessage[] {
  const linter = new Linter({ configType: 'flat', cwd: REPO_ROOT });
  const messages = linter.verify(
    code,
    [
      {
        files: ['**/*.{js,ts}'],
        languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
        linterOptions: { reportUnusedDisableDirectives: 'off' },
        plugins: { comments: { rules: { 'comment-content': commentContent } } },
        rules: { [RULE_ID]: 'error' },
      },
    ],
    { filename: path.join(REPO_ROOT, filename) },
  );
  expect(messages.filter((m) => m.ruleId === null), 'failed to lint cleanly').toEqual([]);
  return messages;
}

/** Point the rule at a scratch baseline that holds these lines. */
function useBaseline(lines: string[]): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'comment-baseline-')), 'baseline.tsv');
  fs.writeFileSync(file, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
  process.env.EXARCHOS_COMMENT_BASELINE = file;
  resetCaches();
}

it('Rule_OrdinalInLineComment_Reported', () => {
  const messages = lint('// DR-7: fsync before rename\nconst a = 1;\n');

  expect(messages).toHaveLength(1);
  expect(messages[0]?.ruleId).toBe(RULE_ID);
  expect(messages[0]?.message).toMatch(/DR-7/);
});

it('Rule_Report_NamesTheRemedy', () => {
  expect(lint('// DR-7: fsync before rename\n')[0]?.message).toMatch(/State the constraint/i);
});

it('Rule_Report_CarriesTheCommentLocation', () => {
  expect(lint('const a = 1;\n\n// governed by INV-2 at the seam\n')[0]?.line).toBe(3);
});

it('Rule_BlockComment_Reported', () => {
  const messages = lint('/*\n * wrapped\n * DR-12 governs this\n */\nconst a = 1;\n');

  expect(messages).toHaveLength(1);
  expect(messages[0]?.message).toMatch(/DR-12/);
});

it('Rule_CleanComment_NotReported', () => {
  expect(lint('// the retry budget is fixed at three attempts\nconst a = 1;\n')).toEqual([]);
});

it('Rule_DirectiveComment_Skipped', () => {
  const directives = [
    '// eslint-disable-next-line no-console',
    '/* eslint-disable */',
    '// @ts-expect-error DR-7 not resolvable here',
    '// prettier-ignore',
    '/* istanbul ignore next */',
    '// biome-ignore lint: task 014',
  ];

  for (const directive of directives) {
    expect(lint(`${directive}\nconst a = 1;\n`), directive).toEqual([]);
  }
});

it('Rule_AllowedReference_NotReported', () => {
  expect(lint('// see https://example.com/x#DR-7 for context\n')).toEqual([]);
  expect(lint('// fixed in lvlup-sw/exarchos#1755\n')).toEqual([]);
});

it('Rule_ChangelogNarration_Reported', () => {
  const messages = lint('// this used to be a map\n');

  expect(messages).toHaveLength(1);
  expect(messages[0]?.message).toMatch(/present behavior/i);
});

it('Rule_MeasuredOffenderFixture_Reported', () => {
  const fixture = fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/__fixtures__/comment-hygiene/offenders.ts'), 'utf8');

  expect(lint(fixture, 'src/offenders.ts').length).toBeGreaterThanOrEqual(10);
});

it('Rule_PermittedFixture_NotReported', () => {
  const fixture = fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/__fixtures__/comment-hygiene/permitted.ts'), 'utf8');

  expect(lint(fixture, 'src/permitted.ts').map((m) => `${m.line}: ${m.message}`)).toEqual([]);
});

it('Rule_Source_ContainsNoLiteralPolicyPattern', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'tools/eslint-rules/comment-content.js'), 'utf8');

  for (const forbidden of ['DR-', 'INV-', 'wave ', 'slice ', 'used to be', 'formerly']) {
    expect(source.includes(`\\b${forbidden}`), `rule source carries a policy pattern literal: ${forbidden}`).toBe(false);
  }
});

it('Rule_ExemptPath_NotReported', () => {
  const rel = 'tools/audit/__fixtures__/comment-hygiene/offenders.ts';

  expect(lint(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'), rel)).toEqual([]);
});

it('Rule_WrappedLineComments_AreOneBlockAndReportOnce', () => {
  expect(lint('// the parent must be\n// synced first, per DR-16\nconst a = 1;\n')).toHaveLength(1);
});

it('Rule_BaselinedBlock_NotReported', () => {
  useBaseline([`src/a.ts\t${fingerprint('// DR-7: fsync before rename')}\t1`]);

  expect(lint('// DR-7: fsync before rename\nconst a = 1;\n')).toEqual([]);
});

it('Rule_EditedBaselinedBlock_Reported', () => {
  useBaseline([`src/a.ts\t${fingerprint('// DR-7: fsync before rename')}\t1`]);

  expect(lint('// DR-7: fsync the file before rename\nconst a = 1;\n')).toHaveLength(1);
});

it('Rule_SecondCopyOfBaselinedBlock_Reported', () => {
  useBaseline([`src/a.ts\t${fingerprint('// DR-7: fsync before rename')}\t1`]);
  const messages = lint('// DR-7: fsync before rename\nconst a = 1;\n// DR-7: fsync before rename\nconst b = 2;\n');

  expect(messages.map((m) => m.line)).toEqual([3]);
});

it('Rule_BaselineForAnotherFile_DoesNotSuppress', () => {
  useBaseline([`src/other.ts\t${fingerprint('// DR-7: fsync before rename')}\t1`]);

  expect(lint('// DR-7: fsync before rename\n')).toHaveLength(1);
});
