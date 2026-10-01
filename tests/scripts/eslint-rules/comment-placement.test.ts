/**
 * @fileoverview Tests for the `comments/comment-placement` ESLint rule.
 */
import { it, expect, afterEach } from 'vitest';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import commentPlacement, { toJsdoc } from '../../../tools/eslint-rules/comment-placement.js';
import { resetCaches } from '../../../tools/eslint-rules/comment-context.js';
import { fingerprint } from '../../../tools/audit/lib/comment-baseline.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const RULE_ID = 'comments/comment-placement';

afterEach(() => {
  delete process.env.EXARCHOS_COMMENT_BASELINE;
  resetCaches();
});

/** Lint `code` with only the placement rule on. */
function lint(code: string, filename = 'src/a.ts'): Linter.LintMessage[] {
  const linter = new Linter({ configType: 'flat', cwd: REPO_ROOT });
  return linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { comments: { rules: { 'comment-placement': commentPlacement } } },
        rules: { [RULE_ID]: 'error' },
      },
    ],
    { filename: path.join(REPO_ROOT, filename) },
  );
}

it('PlacementRule_CommentInsideAFunction_IsReportedAtTheBlock', () => {
  const messages = lint('export function f() {\n  // step one\n  return 1;\n}\n');

  expect(messages.map((m) => [m.ruleId, m.line])).toEqual([[RULE_ID, 2]]);
  expect(messages[0]?.message).toMatch(/inside a function body/);
});

it('PlacementRule_HeaderAndDescriptions_AreNotReported', () => {
  expect(lint('/** About this file. */\n\nimport x from "x";\n\n/** The answer. */\nexport const a = x;\n')).toEqual([]);
});

it('PlacementRule_LineDescription_OffersAJsdocSuggestion', () => {
  const code = 'export const x = 1;\n// The answer.\nexport const a = 42;\n';
  const [message] = lint(code);
  const fix = message?.suggestions?.[0]?.fix;

  expect(message?.message).toMatch(/Write it as a/);
  expect(fix).toBeDefined();
  expect(code.slice(0, fix!.range[0]) + fix!.text + code.slice(fix!.range[1])).toBe('export const x = 1;\n/** The answer. */\nexport const a = 42;\n');
});

it('PlacementRule_OtherChecks_OfferNoSuggestion', () => {
  expect(lint('export const a = 1; // trailing\n')[0]?.suggestions ?? []).toEqual([]);
});

it('PlacementRule_BaselinedBlock_IsNotReported', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'comment-baseline-')), 'baseline.tsv');
  fs.writeFileSync(file, `src/a.ts\t${fingerprint('// step one')}\t1\n`);
  process.env.EXARCHOS_COMMENT_BASELINE = file;
  resetCaches();

  expect(lint('export function f() {\n  // step one\n  return 1;\n}\n')).toEqual([]);
});

it('PlacementRule_ExemptPath_IsNotReported', () => {
  expect(lint('export function f() {\n  // step one\n}\n', 'tools/audit/__fixtures__/comment-hygiene/offenders.ts')).toEqual([]);
});

it('ToJsdoc_MultiLineBlock_KeepsTheIndentation', () => {
  expect(toJsdoc('// one\n  // two', '  ')).toBe('/**\n   * one\n   * two\n   */');
  expect(toJsdoc('/* single */', '')).toBe('/** single */');
});
