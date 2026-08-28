// @oracle-sources: ../../../../src/verbs/execute/compile.ts, the three-action runbook order written out by hand directly above the quantifier — the population `every` ranges over is pinned to exactly that list on the preceding line so a short or empty segment cannot satisfy the execution-authority predicate vacuously
//
// ─── Compiling the plan-closeout segment ────────────────────────────────────
//
// One argument binds onto four leaf parameters, and that is the whole reason
// the runbook exists as one intent rather than three calls: `check_plan_coverage`
// and `check_provenance_chain` spell the unified spec `designPath`/`planPath`,
// while `generate_traceability` spells it `designFile`/`planFile`. The caller
// answers once.
//
// The two refusal paths are exercised separately and deliberately. The schema
// refuses a call that omits `specPath` — that is the path a real caller takes.
// The compiler's own unbound-variable refusal is a SECOND fence, reachable only
// by a validated-args set that satisfies its schema and still lacks the
// variable; a fixture arranges exactly that, so removing either fence reddens
// something.

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
    // The matrix generator declares no subject field, so it carries the path
    // under its own spelling and nothing else.
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

  it('PlanCloseout_ValidatedArgsWithoutTheVariable_HitTheUnboundFence', () => {
    // The second fence, reached the only way it can be: a schema that accepts a
    // call the runbook's `<specPath>` placeholder has nothing to bind to. The
    // shipped schema makes the field required precisely so a real caller never
    // gets here — which is also why the fence needs its own subject to stay
    // non-vacuous.
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
    // The refusal names WHERE, so a caller does not have to diff the runbook.
    expect(refusal.step).toBe('0:check_plan_coverage');
  });
});
