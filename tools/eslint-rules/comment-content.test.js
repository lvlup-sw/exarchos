// Unit tests for tools/eslint-rules/comment-content.js.
//
// Uses ESLint's own `Linter` rather than `RuleTester`, following the house
// idiom established by `no-handler-throw.test.js`: `RuleTester`'s `errors`
// assertion demands an exact, order-sensitive match of every diagnostic from
// one `code` string, which composes badly with fixtures that pack several
// scenarios each.
//
// The rule needs no type information, so this runs on the default parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import commentContent from './comment-content.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const RULE_ID = 'comments/comment-content';

function lint(code, filename = 'a.js') {
  const linter = new Linter({ configType: 'flat' });
  const messages = linter.verify(
    code,
    {
      // The shared fixtures are `.ts`, but they carry no type syntax — comments
      // plus `export const` — so the default parser reads them and the rule
      // sees exactly the corpus the gate sees.
      files: ['**/*.js', '**/*.ts'],
      languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
      // The directive fixtures below carry real `eslint-disable` comments that
      // suppress nothing, and an unused-directive warning shares `ruleId: null`
      // with a genuine config error — which the assertion below must keep
      // treating as fatal.
      linterOptions: { reportUnusedDisableDirectives: 'off' },
      plugins: { comments: { rules: { 'comment-content': commentContent } } },
      rules: { [RULE_ID]: 'error' },
    },
    { filename },
  );
  const configErrors = messages.filter((m) => m.ruleId === null);
  assert.deepEqual(
    configErrors,
    [],
    `failed to lint cleanly: ${JSON.stringify(configErrors)}`,
  );
  return messages;
}

test('Rule_OrdinalInLineComment_Reported', () => {
  const messages = lint('// DR-7: fsync before rename\nconst a = 1;\n');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, RULE_ID);
  assert.match(messages[0].message, /DR-7/);
});

test('Rule_Report_NamesTheRemedy', () => {
  // The rule's value is telling the author what to write instead; a bare
  // "forbidden" verdict would leave the rewrite unguided.
  const messages = lint('// DR-7: fsync before rename\n');

  assert.match(messages[0].message, /State the constraint/i);
});

test('Rule_Report_CarriesTheCommentLocation', () => {
  // Comments are not nodes, so the location has to be reported explicitly or
  // every finding lands at line 1.
  const messages = lint('const a = 1;\n\n// governed by INV-2 at the seam\n');

  assert.equal(messages[0].line, 3);
});

test('Rule_BlockComment_Reported', () => {
  const messages = lint('/*\n * wrapped\n * DR-12 governs this\n */\nconst a = 1;\n');

  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /DR-12/);
});

test('Rule_CleanComment_NotReported', () => {
  assert.deepEqual(
    lint('// the retry budget is fixed at three attempts\nconst a = 1;\n'),
    [],
  );
});

test('Rule_DirectiveComment_Skipped', () => {
  // A directive's content is fixed by whoever consumes it, so an author cannot
  // rewrite one to satisfy this rule.
  const directives = [
    '// eslint-disable-next-line no-console',
    '/* eslint-disable */',
    '// @ts-expect-error DR-7 not resolvable here',
    '// prettier-ignore',
    '/* istanbul ignore next */',
    '// biome-ignore lint: task 014',
  ];

  for (const directive of directives) {
    assert.deepEqual(lint(`${directive}\nconst a = 1;\n`), [], `directive reported: ${directive}`);
  }
});

test('Rule_AllowedReference_NotReported', () => {
  assert.deepEqual(lint('// see https://example.com/x#DR-7 for context\n'), []);
  assert.deepEqual(lint('// fixed in lvlup-sw/exarchos#1755\n'), []);
});

test('Rule_ChangelogNarration_Reported', () => {
  const messages = lint('// this used to be a map\n');

  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /present behavior/i);
});

test('Rule_MeasuredOffenderFixture_Reported', () => {
  // The same verbatim corpus the gate uses, so the two consumers cannot drift
  // in what they consider a violation.
  const fixture = path.join(REPO_ROOT, 'tools/audit/__fixtures__/comment-hygiene/offenders.ts');
  const messages = lint(readFileSync(fixture, 'utf8'), fixture);

  assert.ok(messages.length >= 10, `expected the offender corpus to report; got ${messages.length}`);
});

test('Rule_PermittedFixture_NotReported', () => {
  const fixture = path.join(REPO_ROOT, 'tools/audit/__fixtures__/comment-hygiene/permitted.ts');
  const messages = lint(readFileSync(fixture, 'utf8'), fixture);

  assert.deepEqual(
    messages.map((m) => `${m.line}: ${m.message}`),
    [],
  );
});

test('Rule_Source_ContainsNoLiteralPolicyPattern', () => {
  // The datum is the only authority. A pattern literal here would be a second
  // one, and this is the cheap standing check for it.
  const source = readFileSync(path.join(HERE, 'comment-content.js'), 'utf8');

  for (const forbidden of ['DR-', 'INV-', 'wave ', 'slice ', 'used to be', 'formerly']) {
    assert.ok(
      !source.includes(`\\b${forbidden}`),
      `rule source carries a policy pattern literal: ${forbidden}`,
    );
  }
});
