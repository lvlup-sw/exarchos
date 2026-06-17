import { describe, it, expect } from 'vitest';
import { KIND_OBLIGATIONS, resolveGateSet } from './phase-kind.js';
import { resolveVerificationPolicy } from './verification-policy-resolver.js';
import type { RiskTier } from './verification-policy.js';

describe('KIND_OBLIGATIONS', () => {
  it('KindObligations_EveryKind_HasARow', () => {
    expect(Object.keys(KIND_OBLIGATIONS).sort()).toEqual([
      'GATHER',
      'IMPLEMENT',
      'PLAN',
      'REVIEW',
      'SYNTHESIZE',
    ]);
  });

  it('KindObligations_ImplementRow_PointsAtVerificationLadder', () => {
    expect(KIND_OBLIGATIONS.IMPLEMENT.gates?.resolver).toBe('verification-ladder');
  });

  it('KindObligations_GatherRow_HasNullGates', () => {
    expect(KIND_OBLIGATIONS.GATHER.gates).toBeNull();
  });

  it('KindObligations_ReviewRow_IsReadOnly', () => {
    expect(KIND_OBLIGATIONS.REVIEW.posture).toBe('read-only');
  });
});

describe('resolveGateSet', () => {
  const RISK_TIERS: readonly RiskTier[] = ['low', 'medium', 'high'];
  const BOUNDARY_VALUES: readonly boolean[] = [false, true];

  it('ResolveGateSet_Implement_MatchesVerificationPolicy', () => {
    // No config → builtin path; the IMPLEMENT cell must be behavior-identical to
    // the verification policy resolver across all six (riskTier × boundary) cells.
    for (const riskTier of RISK_TIERS) {
      for (const boundaryTouching of BOUNDARY_VALUES) {
        expect(resolveGateSet('IMPLEMENT', { riskTier, boundaryTouching })).toEqual(
          resolveVerificationPolicy(riskTier, boundaryTouching).sequence,
        );
      }
    }
  });

  it('ResolveGateSet_Gather_ReturnsEmpty', () => {
    expect(resolveGateSet('GATHER', { riskTier: 'low', boundaryTouching: false })).toEqual([]);
  });

  it('ResolveGateSet_InertResolver_ThrowsNotYetWired', () => {
    for (const kind of ['PLAN', 'REVIEW', 'SYNTHESIZE'] as const) {
      expect(() => resolveGateSet(kind, { riskTier: 'low', boundaryTouching: false })).toThrow(
        /not wired|S3/,
      );
    }
  });
});
