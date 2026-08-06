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
} from './workflow-builder.js';

// ─── P07-03 exit-proof (c) — the closure property survives the builder ────────
//
// The REAL gate for this file is `tsc --noEmit`: `.type-test.ts` is deliberately
// named to dodge the tsconfig `**/*.test.ts` exclude, so the compiler checks it.
// Every `@ts-expect-error` below asserts that a would-be ESCAPE HATCH is a TYPE
// ERROR — if the builder ever widened to accept a raw string expression, a
// closure, an arbitrary predicate, or a raw AST node, the corresponding
// `@ts-expect-error` would become UNUSED and `tsc` would fail (TS2578). So this
// file passing tsc is the standing proof that the closed edge-condition algebra
// cannot be smuggled around through the authoring API.

// ── 1. A leaf value may not be a closure ──────────────────────────────────────
// @ts-expect-error — a function is not a FactScalar; no executable escape hatch.
equals('validation.testsPass', () => true);

// ── 2. A leaf value may not be a structured object (would-be sub-expression) ──
// @ts-expect-error — a FactScalar is string | number | boolean, never an object.
equals('track', { expression: 'a && b' });

// ── 3. A connective operand may not be a raw string expression ────────────────
// @ts-expect-error — `all` accepts ConditionSpec operands, not a string.
all('planReview.approved === true');

// ── 4. A connective operand may not be a closure ──────────────────────────────
// @ts-expect-error — `any` accepts ConditionSpec operands, not a predicate fn.
any(() => true);

// ── 5. A connective operand may not be a raw AST-shaped object literal ────────
// @ts-expect-error — a bare node object is not the branded ConditionSpec.
all({ kind: 'factPresent', field: 'artifacts.plan' });

// ── 6. `not` may not negate a raw predicate ───────────────────────────────────
// @ts-expect-error — `not` requires a ConditionSpec, not an arbitrary value.
not(() => false);

// ── 7. A gate presence probe may not be a raw string expression ───────────────
// @ts-expect-error — `gate` presence must be a ConditionSpec, not a string.
gate('plan-artifact', 'artifacts.plan != null');

// ── 8. An approval presence probe may not be a closure ────────────────────────
// @ts-expect-error — `approval` presence must be a ConditionSpec, not a fn.
approval('plan-review', () => true);

// ── 9. A ConditionSpec cannot be forged from a bare object literal ────────────
// @ts-expect-error — the brand is unconstructable outside the combinators.
const _forged: ConditionSpec = { kind: 'factPresent', field: 'artifacts.plan' };
void _forged;

// ── 10. An ObligationSpec cannot be forged from a bare object literal ─────────
// @ts-expect-error — the brand is unconstructable outside the combinators.
const _forgedObl: ObligationSpec = { kind: 'none' };
void _forgedObl;

// ── Positive controls: the SUPPORTED authoring forms DO typecheck ─────────────
// (These carry no `@ts-expect-error`; if the API regressed to reject a valid
// authoring form, the file would fail to compile here instead — proving the
// closure is not achieved by simply breaking the builder.)
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
  // Vitest strips types, so this file's real assertions are the tsc-checked
  // `@ts-expect-error`s above; this anchor keeps the file a discoverable spec.
  expect(typeof present).toBe('function');
});
