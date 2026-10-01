// Unit tests for tools/eslint-rules/no-handler-throw.js.
//
// The suite uses the ESLint `Linter`, not `RuleTester`. `RuleTester` needs an exact,
// ordered match of each diagnostic from one code string, and each fixture holds many
// scenarios. The suite lints each fixture one time and asserts a focused slice per
// test, through the same type-aware rule, parser and config.
//
// Run: `node tools/eslint-rules/no-handler-throw.test.js`. The Node test runner needs no flag.

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

/**
 * Lints a fixture under `__fixtures__/` and returns the messages of the rule.
 * A parser or config failure gives a message with no `ruleId`, and the function fails on it.
 */
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
  const configErrors = messages.filter(m => m.ruleId === null);
  assert.deepEqual(
    configErrors,
    [],
    `fixture ${name} failed to lint cleanly (parser/config error): ${JSON.stringify(configErrors)}`,
  );
  return messages.filter(m => m.ruleId === RULE_ID);
}

/** Type-aware linting is slow, so each fixture gets one lint, which the tests share. */
const violating = lintFixture('handler-throw.violating.ts');
const compliant = lintFixture('handler-throw.compliant.ts');
const unresolved = lintFixture('handler-throw.unresolved.ts');
const unattributed = lintFixture('handler-throw.unattributed.ts');

function findByName(messages, name) {
  return messages.find(m => m.message.includes(`'${name}'`));
}

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

/**
 * The zero-arg factory shape of `setup_worktree: adaptSetupWorktree()`, a call with no
 * arguments. The rule resolves the callee and unwraps the closure that its body returns.
 */
test('noHandlerThrow_ZeroArgFactoryHandlerThrow_IsReported', () => {
  const hit = findByName(violating, 'zero_arg_factory_throw');
  assert.ok(hit, 'expected a violation found via zero-arg-factory-return unwrap');
  assert.equal(hit.messageId, 'abnormalThrow');
});

/** The `prune_stale_workflows: handlePruneStaleWorkflows as ActionHandler` shape, pinned as a regression guard. */
test('noHandlerThrow_AsCastHandlerThrow_IsReported', () => {
  const hit = findByName(violating, 'as_cast_throw');
  assert.ok(hit, 'expected a violation for the `as ActionHandler` identifier-cast shape');
});

/**
 * A destructured first parameter gives no `argsParamName`, so the guard exemption must
 * not apply. Domain-input validation in such a handler stays a violation.
 */
test('noHandlerThrow_DestructuredParamValidationThrow_IsReported', () => {
  const hit = findByName(violating, 'destructured_param_throw');
  assert.ok(hit, 'expected a destructured-param validation throw to be reported, not exempted');
});

/**
 * Kill probe for the derived census. `handleAmend` is in no hand-written roster.
 * Only the `if (action === 'invariants_amend')` dispatch branch names it.
 */
test('noHandlerThrow_SpecialBranchHandlerAbsentFromAnyRoster_IsReported', () => {
  const hit = findByName(violating, 'invariants_amend');
  assert.ok(
    hit,
    'expected the derived census to scan a special branch whose handler is in no hand-written roster',
  );
  assert.equal(hit.messageId, 'abnormalThrow');
});

/**
 * Guards against under- and over-reporting. The nine are `handleTopLevelThrow` (1),
 * `handleCatchRethrow` (2), `handleDoctor` (1) and the `args` throw of `inline_arrow_throw` (1).
 * `zero_arg_factory_throw`, `as_cast_throw`, `destructured_param_throw` and
 * `invariants_amend` give one each. The `ctx` guard of `inline_arrow_throw` stays exempt.
 */
test('noHandlerThrow_ViolatingFixture_ReportsExactlyNineAbnormalThrows', () => {
  assert.equal(
    violating.length,
    9,
    `expected exactly 9 violations, got ${violating.length}: ${JSON.stringify(violating.map(m => m.message))}`,
  );
});

test('noHandlerThrow_CompliantFixture_ReportsNothing', () => {
  assert.deepEqual(
    compliant,
    [],
    `expected zero violations, got: ${JSON.stringify(compliant.map(m => m.message))}`,
  );
});

/** `assertValidId()` is not in `ACTION_HANDLERS` or a special branch, so it is out of the registration set. */
test('noHandlerThrow_ExemptDeepHelperThrow_IsNotReported', () => {
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

/** The not-exempt default for a destructured first parameter must not cause a false positive when the handler has no throw. */
test('noHandlerThrow_DestructuredParamClean_IsNotReported', () => {
  assert.equal(findByName(compliant, 'destructured_param_clean'), undefined);
});

/**
 * A zero-arg factory that returns the result of another call matches no known shape.
 * The rule reports the map entry and does not skip it.
 */
test('noHandlerThrow_UnresolvableFactoryReturnShape_ReportsUnresolvedHandler', () => {
  const hit = findByName(unresolved, 'indirect_factory_return');
  assert.ok(hit, `expected an unresolvedHandler report for the map entry: ${JSON.stringify(unresolved)}`);
  assert.equal(hit.messageId, 'unresolvedHandler');
});

/**
 * The branch names an action, so the census sees the registration but cannot scan it.
 * The rule reports it as it reports an `ACTION_HANDLERS` entry.
 */
test('noHandlerThrow_UnresolvableSpecialBranchHandler_ReportsUnresolvedHandler', () => {
  const hit = findByName(unresolved, 'unresolved_branch');
  assert.ok(hit, `expected an unresolvedHandler report for the branch: ${JSON.stringify(unresolved)}`);
  assert.equal(hit.messageId, 'unresolvedHandler');
});

test('noHandlerThrow_UnresolvedFixture_ReportsExactlyTwoDiagnostics', () => {
  assert.equal(
    unresolved.length,
    2,
    `expected exactly 2 diagnostics, got: ${JSON.stringify(unresolved.map(m => m.message))}`,
  );
});

/**
 * No dispatch branch selects this envelope-wrapped call to a named handler, so the
 * census cannot attribute it to an action. The rule reports the hole.
 */
test('noHandlerThrow_NamedHandlerDispatchOutsideAnyBranch_ReportsUnattributedDispatch', () => {
  assert.equal(
    unattributed.length,
    1,
    `expected exactly 1 diagnostic, got: ${JSON.stringify(unattributed.map(m => m.message))}`,
  );
  assert.equal(unattributed[0].messageId, 'unattributedDispatch');
  assert.match(unattributed[0].message, /handleUnbranched/);
});

/**
 * Two shapes reach a real handler: the member callee in
 * `envelopeWrap(await handlers.handleX(…))` and the plain alias `const handler = handleX`.
 * Each hides a handler from the census, so the rule reports both.
 */
test('noHandlerThrow_UnscannableDispatchShapes_AreReportedNotExempted', () => {
  const unscannable = lintFixture('handler-throw.unscannable.ts');
  assert.equal(
    unscannable.length,
    2,
    `expected exactly 2 diagnostics, got: ${JSON.stringify(unscannable.map(m => m.message))}`,
  );
  for (const message of unscannable) {
    assert.equal(message.messageId, 'unattributedDispatch');
  }
  assert.match(unscannable.map(m => m.message).join('\n'), /handlers\.handleNamespaced/);
  assert.match(unscannable.map(m => m.message).join('\n'), /handler/);
});

/**
 * The `const handler = ACTION_HANDLERS[action]` tail of the compliant fixture. The map
 * walk covers it, so the derivation must not report it. This shape decides whether the
 * attribution check over-selects.
 */
test('noHandlerThrow_TableDispatchThroughLocalHandlerConst_IsNotReported', () => {
  assert.equal(findByName(compliant, 'handler'), undefined);
});
