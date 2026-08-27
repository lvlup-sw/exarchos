// ─── Compiling the review-closeout segment ──────────────────────────────────
//
// `quality-evaluation` is compiled against the LIVE table — the shipped runbook,
// the real registry lookup, the real argument schema — because what is under
// test is whether the runbook as authored closes over registered local actions,
// not whether a fixture does.
//
// Two things the compiler owes this intent are asserted here rather than
// inferred: that subject identity reaches every leaf that declares it, under
// whichever spelling that leaf declares, and that a missing argument is refused
// BEFORE the first leaf runs. Both refusals name the field, because a caller
// told only "invalid" has to guess which of eight it was.

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
  it('QualityEvaluation_CompilesToTheFiveShippedLeaves_InRunbookOrder', () => {
    const leaves = leavesOf(compileIntent(INTENT, SUBJECT, ARGS, PRODUCTION_COMPILE_DEPS));

    expect(leaves.map((leaf) => leaf.action)).toEqual(SHIPPED_LEAVES);
    expect(leaves.map((leaf) => leaf.index)).toEqual([0, 1, 2, 3, 4]);
    expect(leaves.every((leaf) => leaf.tool === 'exarchos_orchestrate')).toBe(true);
    // The runbook's own failure policy, carried onto the segment rather than
    // re-decided: the two advisory gates continue, the three blocking ones stop.
    expect(leaves.map((leaf) => leaf.onFail)).toEqual([
      'stop',
      'continue',
      'continue',
      'stop',
      'stop',
    ]);
    // Every leaf is locally authoritative, which is the property that makes the
    // segment executable in-process at all.
    expect(
      leaves.every((leaf) => leaf.contract.executionAuthority.kind === 'local'),
    ).toBe(true);
  });

  it('QualityEvaluation_SubjectIdentity_ReachesEveryLeafThatDeclaresIt', () => {
    const leaves = leavesOf(compileIntent(INTENT, SUBJECT, ARGS, PRODUCTION_COMPILE_DEPS));

    // Not "at least one leaf carries it" — every leaf whose registered schema
    // declares a subject field must carry the SAME stream, or the segment would
    // commit part of its work to a stream nobody is watching.
    for (const leaf of leaves) {
      const declaredKeys = new Set(Object.keys(leaf.declaration.schema.shape));
      if (declaredKeys.has('featureId')) {
        expect(leaf.args.featureId, leaf.action).toBe(SUBJECT.streamId);
      }
      if (declaredKeys.has('streamId')) {
        expect(leaf.args.streamId, leaf.action).toBe(SUBJECT.streamId);
      }
    }
    // Non-vacuous: at least one leaf actually declares a subject field.
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

  it('QualityEvaluation_WithoutDiffContent_Refuses', () => {
    // Required here although the registry declares it optional: the
    // security-scan handler refuses at runtime without it, and a refusal
    // discovered mid-segment is one the earlier leaves have already paid for.
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

  it('QualityEvaluation_FeatureIdArgument_Refused_SubjectIsNotACallerArgument', () => {
    // The subject arrives as `featureId`/`streamId` on the REQUEST, not inside
    // `args`. Accepting it here would advertise a choice the compiler overwrites
    // a moment later.
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
