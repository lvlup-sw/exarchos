// @oracle-sources: ../../../../src/verbs/execute/compile.ts, the `SHIPPED_LEAVES` list this file writes by hand — the population both `every` quantifiers range over is pinned against that list and against a literal index sequence before either runs, so a segment that compiled short or empty cannot satisfy a per-leaf predicate vacuously
//
// Tests that compile the `quality-evaluation` segment against the shipped runbook, the real
// registry lookup, and the real argument schema. The runbook as written must use only
// registered local actions.
//
// The subject identity must reach each leaf that declares it, under the field name of that
// leaf. The compiler refuses a missing argument before the first leaf runs, and the refusal
// names the field.

import { describe, it, expect } from 'vitest';

import { compileIntent, PRODUCTION_COMPILE_DEPS } from '../../../../src/verbs/execute/compile.js';
import type { CompiledLeaf } from '../../../../src/verbs/execute/types.js';

const INTENT = 'quality-evaluation';
const SUBJECT = { streamId: 'wf-quality' };

/** The five leaves the shipped runbook lists, in its order. */
const SHIPPED_LEAVES = [
  'check_static_analysis',
  'check_security_scan',
  'check_convergence',
  'check_invariant_conformance',
  'check_review_verdict',
];

const ARGS = {
  high: 0,
  medium: 1,
  low: 2,
  diffContent: '+const answer = 42;\n',
};

function refusalOf(outcome: ReturnType<typeof compileIntent>): { code: string; message: string } {
  if (outcome.ok) throw new Error('expected a compile refusal, got a segment');
  return outcome.refusal;
}

function leavesOf(outcome: ReturnType<typeof compileIntent>): readonly CompiledLeaf[] {
  if (!outcome.ok) {
    throw new Error(`expected a segment, got ${outcome.refusal.code}: ${outcome.refusal.message}`);
  }
  return outcome.segment.leaves;
}

describe('quality-evaluation compiles against the live registry', () => {
  /**
   * The segment keeps the failure policy of the runbook and does not decide a new one.
   * Each leaf has local authority, so the segment can run in the process.
   */
  it('QualityEvaluation_CompilesToTheFiveShippedLeaves_InRunbookOrder', () => {
    const leaves = leavesOf(compileIntent(INTENT, SUBJECT, ARGS, PRODUCTION_COMPILE_DEPS));

    expect(leaves.map((leaf) => leaf.action)).toEqual(SHIPPED_LEAVES);
    expect(leaves.map((leaf) => leaf.index)).toEqual([0, 1, 2, 3, 4]);
    expect(leaves.every((leaf) => leaf.tool === 'exarchos_orchestrate')).toBe(true);
    expect(leaves.map((leaf) => leaf.onFail)).toEqual([
      'stop',
      'continue',
      'continue',
      'stop',
      'stop',
    ]);
    expect(
      leaves.every((leaf) => leaf.contract.executionAuthority.kind === 'local'),
    ).toBe(true);
  });

  /**
   * Each leaf whose schema declares a subject field must carry the same stream. Otherwise
   * the segment commits part of its work to a stream that nobody watches. The last check
   * makes sure that at least one leaf declares a subject field.
   */
  it('QualityEvaluation_SubjectIdentity_ReachesEveryLeafThatDeclaresIt', () => {
    const leaves = leavesOf(compileIntent(INTENT, SUBJECT, ARGS, PRODUCTION_COMPILE_DEPS));

    for (const leaf of leaves) {
      const declaredKeys = new Set(Object.keys(leaf.declaration.schema.shape));
      if (declaredKeys.has('featureId')) {
        expect(leaf.args.featureId, leaf.action).toBe(SUBJECT.streamId);
      }
      if (declaredKeys.has('streamId')) {
        expect(leaf.args.streamId, leaf.action).toBe(SUBJECT.streamId);
      }
    }
    expect(
      leaves.filter((leaf) => leaf.args.featureId === SUBJECT.streamId).length,
    ).toBeGreaterThan(0);
  });

  it('QualityEvaluation_FindingCounts_ReachTheVerdictLeafAsNumbers', () => {
    const leaves = leavesOf(compileIntent(INTENT, SUBJECT, ARGS, PRODUCTION_COMPILE_DEPS));
    const verdict = leaves.find((leaf) => leaf.action === 'check_review_verdict');

    expect(verdict).toBeDefined();
    expect(verdict?.args.high).toBe(0);
    expect(verdict?.args.medium).toBe(1);
    expect(verdict?.args.low).toBe(2);
  });

  it.each([['high'], ['medium'], ['low']])(
    'QualityEvaluation_Without%s_RefusesNamingTheField',
    (field) => {
      const partial: Record<string, unknown> = { ...ARGS };
      delete partial[field];

      const refusal = refusalOf(compileIntent(INTENT, SUBJECT, partial, PRODUCTION_COMPILE_DEPS));
      expect(refusal.code).toBe('INTENT_ARGS_INVALID');
      expect(refusal.message).toContain(field);
    },
  );

  /**
   * The intent requires `diffContent`, although the registry declares it optional. The
   * security-scan handler refuses at run time without it, and a refusal in the middle of the
   * segment comes after the earlier leaves ran.
   */
  it('QualityEvaluation_WithoutDiffContent_Refuses', () => {
    const { diffContent: _dropped, ...partial } = ARGS;

    const refusal = refusalOf(compileIntent(INTENT, SUBJECT, partial, PRODUCTION_COMPILE_DEPS));
    expect(refusal.code).toBe('INTENT_ARGS_INVALID');
    expect(refusal.message).toContain('diffContent');
  });

  it('QualityEvaluation_UnknownKey_Refuses', () => {
    const refusal = refusalOf(
      compileIntent(
        INTENT,
        SUBJECT,
        { ...ARGS, riskTier: 'high' },
        PRODUCTION_COMPILE_DEPS,
      ),
    );
    expect(refusal.code).toBe('INTENT_ARGS_INVALID');
    expect(refusal.message).toContain('riskTier');
  });

  /**
   * The subject comes as `featureId` or `streamId` on the request, not in `args`. A subject
   * in `args` offers a choice that the compiler then overwrites, so the compiler refuses it.
   */
  it('QualityEvaluation_FeatureIdArgument_Refused_SubjectIsNotACallerArgument', () => {
    const refusal = refusalOf(
      compileIntent(
        INTENT,
        SUBJECT,
        { ...ARGS, featureId: 'wf-somewhere-else' },
        PRODUCTION_COMPILE_DEPS,
      ),
    );
    expect(refusal.code).toBe('INTENT_ARGS_INVALID');
    expect(refusal.message).toContain('featureId');
  });
});
