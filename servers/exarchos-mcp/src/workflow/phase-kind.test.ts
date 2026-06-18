import { describe, it, expect } from 'vitest';
import { KIND_OBLIGATIONS, resolveGateSet, ladderGateNames } from './phase-kind.js';
import type { ResolvedGate } from './phase-kind.js';
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
        expect(ladderGateNames(resolveGateSet('IMPLEMENT', { riskTier, boundaryTouching }))).toEqual(
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

  // DR-7: the fail-closed guard must distinguish a genuine resolver error from
  // the ordinary "no config supplied" path. With NO `config` in ctx, the
  // IMPLEMENT resolver MUST fall through to the frozen built-in table and
  // resolve cleanly across every (riskTier × boundary) cell — it must NOT
  // throw. Only a real resolver fault is allowed to fail the dispatch closed.
  it('ResolveGateSet_NoConfigOverride_FallsBackToBaseTable', () => {
    for (const riskTier of RISK_TIERS) {
      for (const boundaryTouching of BOUNDARY_VALUES) {
        // No `config` field at all in ctx — the absent-config path.
        const ctx = { riskTier, boundaryTouching };
        expect(() => resolveGateSet('IMPLEMENT', ctx)).not.toThrow();
        // The resolved sequence is the byte-identical built-in table cell.
        expect(ladderGateNames(resolveGateSet('IMPLEMENT', ctx))).toEqual(
          resolveVerificationPolicy(riskTier, boundaryTouching).sequence,
        );
      }
    }
  });
});

// ─── DR-8: discriminated ResolvedGate union ─────────────────────────────────
describe('ResolvedGate (DR-8)', () => {
  it('ResolveGateSet_Implement_ReturnsLadderFamilyResolvedGates', () => {
    const resolved: readonly ResolvedGate[] = resolveGateSet('IMPLEMENT', {
      riskTier: 'high',
      boundaryTouching: true,
    });
    expect(resolved.length).toBeGreaterThan(0);
    for (const g of resolved) {
      expect(g.family).toBe('ladder');
    }
    // The underlying gate names equal the verification-policy sequence verbatim.
    expect(resolved.map((g) => g.gate)).toEqual(
      resolveVerificationPolicy('high', true).sequence,
    );
  });

  it('LadderGateNames_ImplementResolved_ExtractsGateNameSequence', () => {
    const resolved = resolveGateSet('IMPLEMENT', {
      riskTier: 'medium',
      boundaryTouching: false,
    });
    expect(ladderGateNames(resolved)).toEqual(
      resolveVerificationPolicy('medium', false).sequence,
    );
  });
});
