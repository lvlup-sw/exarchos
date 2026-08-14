// Unit tests for tools/eslint-rules/no-handler-throw.js (#1706 DR-1/DR-2).
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
// Run directly: `node tools/eslint-rules/no-handler-throw.test.js` (Node's
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
const unresolved = lintFixture('handler-throw.unresolved.ts');

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

// ─── Review fix M1: zero-arg-factory + `as ActionHandler` cast resolution ──

test('noHandlerThrow_ZeroArgFactoryHandlerThrow_IsReported', () => {
  // composite.ts's real `setup_worktree: adaptSetupWorktree()` shape — a
  // CallExpression with NO arguments. Before the fix, `resolveHandlerFnNode`
  // took `arguments[last]` (undefined for a 0-arg call) and this entry was
  // silently dropped from the census (never scanned). The fix resolves the
  // callee to its declaration and unwraps the closure ITS body returns.
  const hit = findByName(violating, 'zero_arg_factory_throw');
  assert.ok(hit, 'expected a violation found via zero-arg-factory-return unwrap');
  assert.equal(hit.messageId, 'abnormalThrow');
});

test('noHandlerThrow_AsCastHandlerThrow_IsReported', () => {
  // composite.ts's real `prune_stale_workflows: handlePruneStaleWorkflows as
  // ActionHandler` shape — already resolved correctly pre-fix (TSAsExpression
  // → Identifier), but pinned here as a regression guard for M1.
  const hit = findByName(violating, 'as_cast_throw');
  assert.ok(hit, 'expected a violation for the `as ActionHandler` identifier-cast shape');
});

// ─── Review fix M2: destructured-first-param guard exemption ───────────────

test('noHandlerThrow_DestructuredParamValidationThrow_IsReported', () => {
  // Before the fix, `isFailLoudPreconditionGuard` returned `true` (EXEMPT)
  // whenever `argsParamName` was undefined — which a destructured first
  // param (`{ id }: { id?: string }`) always produces, since
  // `firstParamName` only names a plain Identifier param. That fail-opened
  // EVERY sole-`if` throw in such a handler, including genuine domain-input
  // validation. The fix defaults to NON-exempt for this shape.
  const hit = findByName(violating, 'destructured_param_throw');
  assert.ok(hit, 'expected a destructured-param validation throw to be reported, not exempted');
});

test('noHandlerThrow_ViolatingFixture_ReportsExactlyEightAbnormalThrows', () => {
  // Guards against both under- and over-reporting. 8: the original 5
  // (handleTopLevelThrow ×1, handleCatchRethrow ×2, handleDoctor ×1,
  // inline_arrow_throw's args-derived throw ×1 — its ctx-guard throw stays
  // exempt) plus the 3 new M1/M2 fixture cases (zero_arg_factory_throw,
  // as_cast_throw, destructured_param_throw), each contributing exactly one.
  assert.equal(
    violating.length,
    8,
    `expected exactly 8 violations, got ${violating.length}: ${JSON.stringify(violating.map(m => m.message))}`,
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

test('noHandlerThrow_ZeroArgFactoryHandlerClean_IsNotReported', () => {
  assert.equal(findByName(compliant, 'zero_arg_factory_clean'), undefined);
});

test('noHandlerThrow_AsCastHandlerClean_IsNotReported', () => {
  assert.equal(findByName(compliant, 'as_cast_clean'), undefined);
});

test('noHandlerThrow_DestructuredParamClean_IsNotReported', () => {
  // The NON-exempt default for a destructured first param must not itself
  // cause a false positive when the handler genuinely has no throw.
  assert.equal(findByName(compliant, 'destructured_param_clean'), undefined);
});

// ─── Review fix M1: fail-loud on a genuinely unresolvable map entry ────────

test('noHandlerThrow_UnresolvableFactoryReturnShape_ReportsUnresolvedHandler', () => {
  // A zero-arg factory whose body returns the RESULT of calling another
  // function (not a function/arrow literal directly) cannot be resolved by
  // any known shape. Before the fix this silently `continue`d past the map
  // entry (fail-open); the fix reports a rule error on it instead
  // (fail-closed) so an unscannable registered handler is never mistaken for
  // "nothing to report".
  assert.equal(unresolved.length, 1, `expected exactly 1 diagnostic, got: ${JSON.stringify(unresolved)}`);
  assert.equal(unresolved[0].messageId, 'unresolvedHandler');
  assert.match(unresolved[0].message, /indirect_factory_return/);
});
