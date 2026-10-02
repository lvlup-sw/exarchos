// Type test: the closed edge-condition algebra survives the authoring builder.
// Each `@ts-expect-error` below asserts that an escape hatch is a type error: a closure, a raw string, a raw object, or a forged brand.
// If the builder accepts one, its directive becomes unused and `tsc` fails with TS2578.
// The positive controls at the end carry no directive, so they must compile.
// `tests/tsconfig.json` excludes `unit/**`, so `npm run typecheck` does not check this file.
// Vitest strips types and runs only the anchor test.

import { it, expect } from 'vitest';

import {
  all,
  any,
  approval,
  compare,
  equals,
  event,
  gate,
  not,
  present,
  type ConditionSpec,
  type ObligationSpec,
} from '../../../../src/workflow/admission/workflow-builder.js';

// @ts-expect-error — a function is not a FactScalar; no executable escape hatch.
equals('validation.testsPass', () => true);

// @ts-expect-error — a FactScalar is string | number | boolean, never an object.
equals('track', { expression: 'a && b' });

// @ts-expect-error — `all` accepts ConditionSpec operands, not a string.
all('planReview.approved === true');

// @ts-expect-error — `any` accepts ConditionSpec operands, not a predicate fn.
any(() => true);

// @ts-expect-error — a bare node object is not the branded ConditionSpec.
all({ kind: 'factPresent', field: 'artifacts.plan' });

// @ts-expect-error — `not` requires a ConditionSpec, not an arbitrary value.
not(() => false);

// @ts-expect-error — `gate` presence must be a ConditionSpec, not a string.
gate('plan-artifact', 'artifacts.plan != null');

// @ts-expect-error — `approval` presence must be a ConditionSpec, not a fn.
approval('plan-review', () => true);

// @ts-expect-error — the brand is unconstructable outside the combinators.
const _forged: ConditionSpec = { kind: 'factPresent', field: 'artifacts.plan' };
void _forged;

// @ts-expect-error — the brand is unconstructable outside the combinators.
const _forgedObl: ObligationSpec = { kind: 'none' };
void _forgedObl;

/** The positive controls start here. Each supported authoring form must compile. */
const _leafOk: ConditionSpec = present('artifacts.plan');
const _boolOk: ConditionSpec = equals('planReview.approved', true);
const _strOk: ConditionSpec = equals('track', 'thorough');
const _numOk: ConditionSpec = compare('planReview.revisionCount', 'gte', 1);
const _connOk: ConditionSpec = all(_leafOk, any(_boolOk, _strOk), not(_numOk));
const _evtOk: ConditionSpec = event('synthesize.requested');
const _gateOk: ObligationSpec = gate('plan-artifact', _leafOk);
const _approvalOk: ObligationSpec = approval('plan-review', _boolOk, 2);
void _connOk;
void _evtOk;
void _gateOk;
void _approvalOk;

it('workflow-builder closure type-test anchor', () => {
  expect(typeof present).toBe('function');
});
