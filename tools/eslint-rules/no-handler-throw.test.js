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
const unattributed = lintFixture('handler-throw.unattributed.ts');

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

// ─── Derived special-branch census (task 082 / DR-9) ──────────────────────

test('noHandlerThrow_SpecialBranchHandlerAbsentFromAnyRoster_IsReported', () => {
  // KILL PROBE for the derivation. `handleAmend` is dispatched from an
  // `if (action === 'invariants_amend')` branch and appears in no
  // hand-written handler roster — exactly the state the real
  // `invariants_amend` verb shipped in. With the census derived from the
  // dispatch branches it is scanned like any other special branch; with the
  // old `SPECIAL_BRANCH_ACTIONS` map this handler was invisible and its
  // throw went unreported.
  const hit = findByName(violating, 'invariants_amend');
  assert.ok(
    hit,
    'expected the derived census to scan a special branch whose handler is in no hand-written roster',
  );
  assert.equal(hit.messageId, 'abnormalThrow');
});

test('noHandlerThrow_ViolatingFixture_ReportsExactlyNineAbnormalThrows', () => {
  // Guards against both under- and over-reporting. 9: the original 5
  // (handleTopLevelThrow ×1, handleCatchRethrow ×2, handleDoctor ×1,
  // inline_arrow_throw's args-derived throw ×1 — its ctx-guard throw stays
  // exempt), the 3 M1/M2 fixture cases (zero_arg_factory_throw,
  // as_cast_throw, destructured_param_throw), and the derived-census kill
  // case (invariants_amend), each contributing exactly one.
  assert.equal(
    violating.length,
    9,
    `expected exactly 9 violations, got ${violating.length}: ${JSON.stringify(violating.map(m => m.message))}`,
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
  const hit = findByName(unresolved, 'indirect_factory_return');
  assert.ok(hit, `expected an unresolvedHandler report for the map entry: ${JSON.stringify(unresolved)}`);
  assert.equal(hit.messageId, 'unresolvedHandler');
});

// ─── Task 082 / DR-9: BOTH special-branch silent returns are now loud ──────

test('noHandlerThrow_UnresolvableSpecialBranchHandler_ReportsUnresolvedHandler', () => {
  // The `if (!fnNode) return;` hole. The branch NAMES an action, so the
  // census can see the registration — it just cannot scan it. Silently
  // skipping made an unscannable special branch indistinguishable from a
  // clean one; it is reported now, the same way an ACTION_HANDLERS entry is.
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

test('noHandlerThrow_NamedHandlerDispatchOutsideAnyBranch_ReportsUnattributedDispatch', () => {
  // The `if (!actionName) return;` hole. An envelope-wrapped call to a named
  // handler that no dispatch branch selects cannot be attributed to an
  // action — which is exactly what an unrostered handler name looked like
  // before. It is a census hole, so it is reported rather than skipped.
  assert.equal(
    unattributed.length,
    1,
    `expected exactly 1 diagnostic, got: ${JSON.stringify(unattributed.map(m => m.message))}`,
  );
  assert.equal(unattributed[0].messageId, 'unattributedDispatch');
  assert.match(unattributed[0].message, /handleUnbranched/);
});

test('noHandlerThrow_UnscannableDispatchShapes_AreReportedNotExempted', () => {
  // Two shapes that reached a real handler and were silently skipped:
  //   1. `envelopeWrap(await handlers.handleX(…))` — a member-expression callee
  //      the resolver could not name, which the caller read as "pre-built
  //      envelope, nothing dispatched here";
  //   2. `const handler = handleX` — a plain alias that satisfied the
  //      table-dispatch exemption merely by being function-local.
  // Either one hides a handler from the census entirely, which is the hole this
  // rule exists to close.
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

test('noHandlerThrow_TableDispatchThroughLocalHandlerConst_IsNotReported', () => {
  // The compliant fixture's `const handler = ACTION_HANDLERS[action]` tail —
  // an INDIRECTION whose census is the map walk, not the branch derivation.
  // Reporting it would make the loud attribution check unusable on the real
  // dispatcher, so the derivation must leave it alone. (Subsumed by
  // CompliantFixture_ReportsNothing; pinned separately because it is the one
  // shape that decides whether the fail-loud arm over-selects.)
  assert.equal(findByName(compliant, 'handler'), undefined);
});
