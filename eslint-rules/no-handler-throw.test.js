// Unit tests for eslint-rules/no-handler-throw.js (#1706 DR-1/DR-2).
//
// Uses ESLint's own `Linter` (the same engine `RuleTester` wraps) rather than
// `RuleTester` itself: `RuleTester`'s `errors` assertion requires an exact,
// order-sensitive match of EVERY diagnostic produced from one `code` string,
// which does not compose well with MSO-style per-scenario test names against
// the two shared fixture files (each fixture packs multiple scenarios, per
// the task's file list). Linting each fixture ONCE and asserting a focused
// slice per test gives named, independent failures while still exercising
// the exact same type-aware rule/parser/config path `RuleTester` would.
//
// Run directly: `node eslint-rules/no-handler-throw.test.js` (Node's
// built-in test runner needs no extra dependency, no `--test` flag required).
//
// MSO-style test names (Method_Scenario_Outcome) per the task spec.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import tseslint from 'typescript-eslint';
import noHandlerThrow from './no-handler-throw.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, '__fixtures__');
const FIXTURES_PROJECT = path.join(HERE, 'tsconfig.json');

const RULE_ID = 'envelopes/no-handler-throw';

/** Lints a fixture file (by name, under __fixtures__/) and returns messages. */
function lintFixture(name) {
  const filename = path.join(FIXTURES_DIR, name);
  const code = readFileSync(filename, 'utf8');
  const linter = new Linter({ configType: 'flat' });
  const messages = linter.verify(
    code,
    {
      files: ['**/*.ts'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: {
          project: FIXTURES_PROJECT,
          tsconfigRootDir: HERE,
        },
      },
      plugins: { envelopes: { rules: { 'no-handler-throw': noHandlerThrow } } },
      rules: { [RULE_ID]: 'error' },
    },
    { filename },
  );
  // A parser/config-level failure (e.g. a syntax error, or the file falling
  // outside the tsconfig's `include`) surfaces as a message with no `ruleId`
  // — fail loudly instead of silently treating it as "no violations".
  const configErrors = messages.filter(m => m.ruleId === null);
  assert.deepEqual(
    configErrors,
    [],
    `fixture ${name} failed to lint cleanly (parser/config error): ${JSON.stringify(configErrors)}`,
  );
  return messages.filter(m => m.ruleId === RULE_ID);
}

// Type-aware linting is not cheap — lint each fixture exactly once, reuse the
// result across every focused assertion below.
const violating = lintFixture('handler-throw.violating.ts');
const compliant = lintFixture('handler-throw.compliant.ts');

function findByName(messages, name) {
  return messages.find(m => m.message.includes(`'${name}'`));
}

// ─── Violating fixture: every abnormal-completion shape is reported ────────

test('noHandlerThrow_TopLevelThrowInRegisteredHandler_IsReported', () => {
  const hit = findByName(violating, 'top_level_throw');
  assert.ok(hit, 'expected a violation for the top_level_throw action (top-level throw)');
  assert.equal(hit.messageId, 'abnormalThrow');
});

test('noHandlerThrow_UnrecaughtCatchClauseThrow_IsReported', () => {
  const hit = findByName(violating, 'catch_rethrow');
  assert.ok(hit, 'expected a violation for the catch_rethrow action (catch-clause re-throw)');
});

test('noHandlerThrow_SpecialBranchHandlerThrow_IsReported', () => {
  const hit = findByName(violating, 'doctor');
  assert.ok(hit, 'expected a violation for the special-cased "doctor" branch handler');
});

test('noHandlerThrow_InlineArrowHandlerThrow_IsReported', () => {
  const hit = findByName(violating, 'inline_arrow_throw');
  assert.ok(
    hit,
    'expected a violation for the inline-arrow handler value (create_issue-style), for its args-derived throw',
  );
});

test('noHandlerThrow_ViolatingFixture_ReportsExactlyFiveAbnormalThrows', () => {
  // Guards against both under- and over-reporting. 5, not 4: handleCatchRethrow
  // contributes TWO — its own `throw err` re-throw in the catch clause, AND
  // the inner `throw new Error(...)` in the try block, because that try's
  // catch does NOT return a ToolResult (it unconditionally re-throws), so the
  // "a try whose catch returns a ToolResult" exclusion does not apply to
  // EITHER throw. Fixing the catch to `return {success:false, ...}` instead
  // of rethrowing would silence both at once. The inline_arrow_throw handler
  // ALSO contains an exempt fail-loud guard that must not inflate this count.
  assert.equal(
    violating.length,
    5,
    `expected exactly 5 violations, got ${violating.length}: ${JSON.stringify(violating.map(m => m.message))}`,
  );
});

// ─── Compliant fixture + exemption classes: nothing is reported ────────────

test('noHandlerThrow_CompliantFixture_ReportsNothing', () => {
  assert.deepEqual(
    compliant,
    [],
    `expected zero violations, got: ${JSON.stringify(compliant.map(m => m.message))}`,
  );
});

test('noHandlerThrow_ExemptDeepHelperThrow_IsNotReported', () => {
  // assertValidId() is never referenced by ACTION_HANDLERS or a special
  // branch — out of the registration set entirely.
  assert.equal(findByName(compliant, 'assertValidId'), undefined);
});

test('noHandlerThrow_TryCatchReturningToolResult_IsNotReported', () => {
  assert.equal(findByName(compliant, 'try_catch_returns'), undefined);
});

test('noHandlerThrow_FailLoudPreconditionGuard_IsNotReported', () => {
  assert.equal(findByName(compliant, 'with_guard'), undefined);
});

test('noHandlerThrow_AbortErrorRethrowInCatch_IsNotReported', () => {
  assert.equal(findByName(compliant, 'with_abort_support'), undefined);
});

test('noHandlerThrow_CompliantSpecialBranchHandler_IsNotReported', () => {
  assert.equal(findByName(compliant, 'onboard'), undefined);
});
