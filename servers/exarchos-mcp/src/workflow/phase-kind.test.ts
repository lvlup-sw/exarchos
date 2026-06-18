import { describe, it, expect } from 'vitest';
import {
  KIND_OBLIGATIONS,
  resolveGateSet,
  ladderGateNames,
  resolveGateSetFailClosed,
} from './phase-kind.js';
import type { ResolvedGate } from './phase-kind.js';
import { resolveVerificationPolicy } from './verification-policy-resolver.js';
import type { RiskTier } from './verification-policy.js';
import { TOOL_REGISTRY } from '../registry.js';
import { getRequiredReviews } from './review-contract.js';
import type { PhaseKind } from './phase-kind.js';
import {
  createFeatureHSM,
  createDebugHSM,
  createRefactorHSM,
  createOneshotHSM,
  createDiscoveryHSM,
} from './hsm-definitions.js';

const PLAN_PHASE_NAMES = ['plan', 'plan-review', 'overhaul-plan'] as const;
const setEqualsNames = (set: ReadonlySet<string>, names: readonly string[]): boolean =>
  set.size === names.length && names.every((n) => set.has(n));

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

  it('ResolveGateSet_EveryGatedKind_IsWiredNoLongerThrows', () => {
    // S3 complete: no resolver is inert. Every gated kind resolves without the
    // 'not wired' throw (GATHER has no gates and is covered separately).
    for (const kind of ['IMPLEMENT', 'PLAN', 'REVIEW', 'SYNTHESIZE'] as const) {
      expect(() =>
        resolveGateSet(kind, { riskTier: 'low', boundaryTouching: false, workflowType: 'feature' }),
      ).not.toThrow();
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

// ─── DR-9: plan-structure resolver ──────────────────────────────────────────
describe('plan-structure resolver (DR-9)', () => {
  const ctx = { riskTier: 'low', boundaryTouching: false } as const;

  it('ResolveGateSet_PlanKind_ReturnsPlanPhaseGateSet', () => {
    const resolved = resolveGateSet('PLAN', ctx);
    expect(resolved.every((g) => g.family === 'plan')).toBe(true);
    expect(resolved.map((g) => g.gate)).toEqual([
      'check_task_decomposition',
      'check_plan_coverage',
      'spec_coverage_check',
      'check_provenance_chain',
      'generate_traceability',
    ]);
  });

  it('ResolveGateSet_PlanKind_MatchesRegistryPlanPhasesBinding', () => {
    // SoT cross-check: the resolver's required gate set must equal exactly the
    // registry actions bound to the PLAN_PHASES set — no new list minted, no
    // drift from the registry binding.
    const registryPlanGates = new Set(
      TOOL_REGISTRY.flatMap((t) => t.actions)
        .filter((a) => setEqualsNames(a.phases, PLAN_PHASE_NAMES))
        .map((a) => a.name),
    );
    const resolverPlanGates = new Set(resolveGateSet('PLAN', ctx).map((g) => g.gate));
    expect(resolverPlanGates).toEqual(registryPlanGates);
  });
});

// ─── DR-9: review-contract resolver ─────────────────────────────────────────
describe('review-contract resolver (DR-9)', () => {
  it('ResolveGateSet_ReviewKindFeatureLowTier_ReturnsBaseDimensions', () => {
    const resolved = resolveGateSet('REVIEW', {
      riskTier: 'low',
      boundaryTouching: false,
      workflowType: 'feature',
    });
    expect(resolved.every((g) => g.family === 'review')).toBe(true);
    expect(resolved.map((g) => g.gate)).toEqual(['spec-review', 'quality-review']);
  });

  it('ResolveGateSet_ReviewKindFeatureHighTier_AppendsMutationAdequacy', () => {
    const resolved = resolveGateSet('REVIEW', {
      riskTier: 'high',
      boundaryTouching: false,
      workflowType: 'feature',
    });
    expect(resolved.map((g) => g.gate)).toEqual([
      'spec-review',
      'quality-review',
      'mutation-adequacy',
    ]);
  });

  it('ResolveGateSet_ReviewKind_MatchesReviewContractSoT', () => {
    // SoT cross-check: the resolver must equal getRequiredReviews verbatim — the
    // dimension vocabulary stays owned by review-contract.ts, never re-listed.
    for (const riskTier of ['low', 'medium', 'high'] as const) {
      const resolved = resolveGateSet('REVIEW', {
        riskTier,
        boundaryTouching: false,
        workflowType: 'feature',
      }).map((g) => g.gate);
      expect(resolved).toEqual(getRequiredReviews('feature', riskTier));
    }
  });
});

// ─── DR-10: fail-closed phase-boundary resolution ──────────────────────────
describe('resolveGateSetFailClosed (DR-10)', () => {
  it('ResolveGateSetFailClosed_ValidKind_ReturnsOkGates', () => {
    const outcome = resolveGateSetFailClosed('PLAN', { riskTier: 'low', boundaryTouching: false });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.gates.length).toBeGreaterThan(0);
  });

  it('ResolveGateSetFailClosed_ResolverThrows_ReturnsFailClosed', () => {
    const outcome = resolveGateSetFailClosed(
      'IMPLEMENT',
      { riskTier: 'low', boundaryTouching: false },
      () => {
        throw new Error('boom');
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/boom/);
  });
});

// ─── DR-9: synthesis-readiness resolver ─────────────────────────────────────
describe('synthesis-readiness resolver (DR-9)', () => {
  it('ResolveGateSet_SynthesizeKind_ReturnsReadinessLegs', () => {
    const resolved = resolveGateSet('SYNTHESIZE', { riskTier: 'low', boundaryTouching: false });
    expect(resolved.every((g) => g.family === 'synthesis')).toBe(true);
    expect(resolved.map((g) => g.gate)).toEqual(['task-completion', 'tests', 'typecheck', 'stack']);
  });
});

// ─── DR-9: INV-6 cross-workflow-type acceptance (the central win) ────────────
describe('INV-6 cross-workflow-type acceptance', () => {
  const ALL_HSMS = [
    createFeatureHSM(),
    createDebugHSM(),
    createRefactorHSM(),
    createOneshotHSM(),
    createDiscoveryHSM(),
  ];

  it('PlanKind_DebugRcaAndFeaturePlanReview_ResolveIdenticalGateSet', () => {
    // Binding is by KIND, not by (workflowType:phase): a debug `rca` phase and a
    // feature `plan-review` phase are both kind PLAN and MUST resolve the same set.
    expect((createFeatureHSM().states['plan-review'] as { kind: PhaseKind }).kind).toBe('PLAN');
    expect((createDebugHSM().states['rca'] as { kind: PhaseKind }).kind).toBe('PLAN');
    const featurePlan = resolveGateSet('PLAN', {
      riskTier: 'medium',
      boundaryTouching: false,
      workflowType: 'feature',
    });
    const debugPlan = resolveGateSet('PLAN', {
      riskTier: 'medium',
      boundaryTouching: false,
      workflowType: 'debug',
    });
    expect(featurePlan).toEqual(debugPlan);
  });

  it('EveryAtomicPhase_AcrossAllWorkflowTypes_ResolvesWithoutThrowing', () => {
    // Reachability: every kind-tagged phase across every workflow type resolves
    // its obligation — no inert resolver remains on any reachable phase.
    for (const hsm of ALL_HSMS) {
      for (const state of Object.values(hsm.states)) {
        if (state.type === 'atomic') {
          expect(
            () =>
              resolveGateSet(state.kind, {
                riskTier: 'high',
                boundaryTouching: true,
                workflowType: hsm.id,
              }),
            `${hsm.id}:${state.id} (${state.kind})`,
          ).not.toThrow();
        }
      }
    }
  });
});
