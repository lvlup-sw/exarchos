/**
 * @fileoverview Tests for the `comments/comment-prose` ESLint rule.
 */
import { it, expect, afterEach } from 'vitest';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import commentProse from '../../../tools/eslint-rules/comment-prose.js';
import { resetCaches } from '../../../tools/eslint-rules/comment-context.js';
import { fingerprint } from '../../../tools/audit/lib/comment-baseline.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const RULE_ID = 'comments/comment-prose';
const OFFENDER = '/** The cache should be cleared; it is stale. */';

afterEach(() => {
  delete process.env.EXARCHOS_COMMENT_BASELINE;
  resetCaches();
});

/** Lint `code` with only the prose rule on. */
function lint(code: string, filename = 'src/a.ts'): Linter.LintMessage[] {
  const linter = new Linter({ configType: 'flat', cwd: REPO_ROOT });
  return linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { comments: { rules: { 'comment-prose': commentProse } } },
        rules: { [RULE_ID]: 'error' },
      },
    ],
    { filename: path.join(REPO_ROOT, filename) },
  );
}

it('ProseRule_DescriptionWithViolations_ReportsEachCheckAtTheBlock', () => {
  const messages = lint(`export const x = 1;\n${OFFENDER}\nexport const cache = new Map();\n`);

  expect(messages.map((m) => [m.ruleId, m.line])).toEqual([
    [RULE_ID, 2],
    [RULE_ID, 2],
  ]);
  expect(messages.map((m) => m.message)).toEqual([expect.stringMatching(/\(STE 8\.1\)$/), expect.stringMatching(/\(STE 3\.2\)$/)]);
});

it('ProseRule_PlainDescription_IsNotReported', () => {
  expect(lint('/** About this file. */\n\nimport x from "x";\n\n/** The cache holds one entry per key. */\nexport const a = x;\n')).toEqual([]);
});

/** The placement rule reports a comment in a body. The prose rule reads only headers and descriptions. */
it('ProseRule_CommentInsideAFunction_IsNotReported', () => {
  expect(lint('export function f() {\n  // it should work; really\n  return 1;\n}\n')).toEqual([]);
});

it('ProseRule_BaselinedBlock_IsNotReported', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'comment-baseline-')), 'baseline.tsv');
  fs.writeFileSync(file, `src/a.ts\t${fingerprint(OFFENDER)}\t1\n`);
  process.env.EXARCHOS_COMMENT_BASELINE = file;
  resetCaches();

  expect(lint(`export const x = 1;\n${OFFENDER}\nexport const cache = new Map();\n`)).toEqual([]);
});

it('ProseRule_ExemptPath_IsNotReported', () => {
  expect(lint(`export const x = 1;\n${OFFENDER}\nexport const cache = 1;\n`, 'tools/audit/__fixtures__/comment-hygiene/offenders.ts')).toEqual([]);
});
