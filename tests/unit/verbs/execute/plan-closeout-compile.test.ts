// @oracle-sources: ../../../../src/verbs/execute/compile.ts, the three-action runbook order written out by hand directly above the quantifier — the population `every` ranges over is pinned to exactly that list on the preceding line so a short or empty segment cannot satisfy the execution-authority predicate vacuously
//
// One `specPath` argument binds onto four leaf parameters, so the runbook is one
// intent and not three calls. `check_plan_coverage` and `check_provenance_chain`
// name the spec `designPath` and `planPath`. `generate_traceability` names it
// `designFile` and `planFile`.
//
// The tests reach the two refusal paths separately. The schema refuses a call
// without `specPath`. The compiler refusal of an unbound variable is a second
// fence, so the removal of either fence makes a test fail.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  compileIntent,
  PRODUCTION_COMPILE_DEPS,
  type CompileDeps,
} from '../../../../src/verbs/execute/compile.js';
import type { CompiledLeaf } from '../../../../src/verbs/execute/types.js';

const INTENT = 'plan-closeout';
const SUBJECT = { streamId: 'wf-plan-closeout' };
const SPEC_PATH = '/tmp/specs/feature.md';
const ARGS = { specPath: SPEC_PATH };

function refusalOf(outcome: ReturnType<typeof compileIntent>): {
  code: string;
  message: string;
  step?: string;
} {
  if (outcome.ok) throw new Error('expected a compile refusal, got a segment');
  return outcome.refusal;
}

function leavesOf(outcome: ReturnType<typeof compileIntent>): readonly CompiledLeaf[] {
  if (!outcome.ok) {
    throw new Error(`expected a segment, got ${outcome.refusal.code}: ${outcome.refusal.message}`);
  }
  return outcome.segment.leaves;
}

describe('plan-closeout compiles against the live registry', () => {
  it('PlanCloseout_CompilesToTheThreeShippedLeaves_InRunbookOrder', () => {
    const leaves = leavesOf(compileIntent(INTENT, SUBJECT, ARGS, PRODUCTION_COMPILE_DEPS));

    expect(leaves.map((leaf) => leaf.action)).toEqual([
      'check_plan_coverage',
      'check_provenance_chain',
      'generate_traceability',
    ]);
    expect(leaves.map((leaf) => leaf.onFail)).toEqual(['stop', 'stop', 'continue']);
    expect(
      leaves.every((leaf) => leaf.contract.executionAuthority.kind === 'local'),
    ).toBe(true);
  });

  /** The matrix generator declares no subject field. It carries the path under its own names and has no `featureId`. */
  it('PlanCloseout_OneSpecPath_BindsOntoBothLeafSpellings', () => {
    const leaves = leavesOf(compileIntent(INTENT, SUBJECT, ARGS, PRODUCTION_COMPILE_DEPS));
    const byAction = new Map(leaves.map((leaf) => [leaf.action, leaf.args]));

    expect(byAction.get('check_plan_coverage')).toMatchObject({
      featureId: SUBJECT.streamId,
      designPath: SPEC_PATH,
      planPath: SPEC_PATH,
    });
    expect(byAction.get('check_provenance_chain')).toMatchObject({
      featureId: SUBJECT.streamId,
      designPath: SPEC_PATH,
      planPath: SPEC_PATH,
    });
    expect(byAction.get('generate_traceability')).toMatchObject({
      designFile: SPEC_PATH,
      planFile: SPEC_PATH,
    });
    expect(byAction.get('generate_traceability')).not.toHaveProperty('featureId');
  });

  it('PlanCloseout_WithoutSpecPath_RefusedByTheIntentSchema', () => {
    const refusal = refusalOf(compileIntent(INTENT, SUBJECT, {}, PRODUCTION_COMPILE_DEPS));
    expect(refusal.code).toBe('INTENT_ARGS_INVALID');
    expect(refusal.message).toContain('specPath');
  });

  it('PlanCloseout_UnknownKey_Refused', () => {
    const refusal = refusalOf(
      compileIntent(INTENT, SUBJECT, { ...ARGS, planPath: SPEC_PATH }, PRODUCTION_COMPILE_DEPS),
    );
    expect(refusal.code).toBe('INTENT_ARGS_INVALID');
    expect(refusal.message).toContain('planPath');
  });

  /**
   * A permissive fixture schema accepts a call that leaves the `<specPath>` placeholder unbound.
   * The shipped schema makes the field required, so a real caller never reaches this fence.
   * The refusal names the step, so a caller does not need to diff the runbook.
   */
  it('PlanCloseout_ValidatedArgsWithoutTheVariable_HitTheUnboundFence', () => {
    const permissive: CompileDeps = {
      ...PRODUCTION_COMPILE_DEPS,
      argSchemas: {
        ...PRODUCTION_COMPILE_DEPS.argSchemas,
        [INTENT]: z.object({ specPath: z.string().min(1).optional() }).strict(),
      },
    };

    const refusal = refusalOf(compileIntent(INTENT, SUBJECT, {}, permissive));
    expect(refusal.code).toBe('INTENT_TEMPLATE_VAR_UNBOUND');
    expect(refusal.message).toContain('specPath');
    expect(refusal.step).toBe('0:check_plan_coverage');
  });
});
