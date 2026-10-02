import { describe, it, expect } from 'vitest';
import {
  KIND_OBLIGATIONS,
  resolveGateSet,
  ladderGateNames,
  resolveGateSetFailClosed,
} from '../../../src/workflow/phase-kind.js';
import type { ResolvedGate, ResolveGateSetCtx } from '../../../src/workflow/phase-kind.js';
import { resolveVerificationPolicy } from '../../../src/workflow/verification-policy-resolver.js';
import type { RiskTier } from '../../../src/workflow/verification-policy.js';
import { TOOL_REGISTRY } from '../../../src/registry.js';
import { getRequiredReviews } from '../../../src/workflow/review-contract.js';
import type { PhaseKind } from '../../../src/workflow/phase-kind.js';
import {
  createFeatureHSM,
  createDebugHSM,
  createRefactorHSM,
  createOneshotHSM,
  createDiscoveryHSM,
} from '../../../src/workflow/hsm-definitions.js';

const PLAN_PHASE_NAMES = ['plan', 'plan-review', 'overhaul-plan'] as const;
const setEqualsNames = (set: ReadonlySet<string>, names: readonly string[]): boolean =>
  set.size === names.length && names.every((n) => set.has(n));

describe('KIND_OBLIGATIONS', () => {
  it('KindObligations_EveryKind_HasARow', () => {
    expect(Object.keys(KIND_OBLIGATIONS).sort()).toEqual([
      'GATHER',
      'IMPLEMENT',
      'MERGE',
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
    for (const kind of ['IMPLEMENT', 'PLAN', 'REVIEW', 'SYNTHESIZE'] as const) {
      expect(() =>
        resolveGateSet(kind, { riskTier: 'low', boundaryTouching: false, workflowType: 'feature' }),
      ).not.toThrow();
    }
  });

  /**
   * With no `config` in the context, the IMPLEMENT resolver uses the built-in table and does not throw.
   * Only a real resolver fault can fail the dispatch closed.
   */
  it('ResolveGateSet_NoConfigOverride_FallsBackToBaseTable', () => {
    for (const riskTier of RISK_TIERS) {
      for (const boundaryTouching of BOUNDARY_VALUES) {
        const ctx = { riskTier, boundaryTouching };
        expect(() => resolveGateSet('IMPLEMENT', ctx)).not.toThrow();
        expect(ladderGateNames(resolveGateSet('IMPLEMENT', ctx))).toEqual(
          resolveVerificationPolicy(riskTier, boundaryTouching).sequence,
        );
      }
    }
  });
});

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

  /** The resolver gate set must equal the registry actions bound to the plan phases, so the gate list has one source. */
  it('ResolveGateSet_PlanKind_MatchesRegistryPlanPhasesBinding', () => {
    const registryPlanGates = new Set(
      TOOL_REGISTRY.flatMap((t) => t.actions)
        .filter((a) => setEqualsNames(a.phases, PLAN_PHASE_NAMES))
        .map((a) => a.name),
    );
    const resolverPlanGates = new Set(resolveGateSet('PLAN', ctx).map((g) => g.gate));
    expect(resolverPlanGates).toEqual(registryPlanGates);
  });

  /** `designDepth` is optional. A context without it resolves to the same five gates as an explicit `standard`. */
  it('ResolveGateSetCtx_DesignDepthAbsent_DefaultsStandardNoThrow', () => {
    const standardGates = [
      'check_task_decomposition',
      'check_plan_coverage',
      'spec_coverage_check',
      'check_provenance_chain',
      'generate_traceability',
    ];

    const absent: ResolveGateSetCtx = { riskTier: 'low', boundaryTouching: false };
    expect(() => resolveGateSet('PLAN', absent)).not.toThrow();
    expect(resolveGateSet('PLAN', absent).map((g) => g.gate)).toEqual(standardGates);

    const explicitStandard: ResolveGateSetCtx = {
      riskTier: 'low',
      boundaryTouching: false,
      designDepth: 'standard',
    };
    expect(resolveGateSet('PLAN', explicitStandard).map((g) => g.gate)).toEqual(standardGates);
  });

  /** With an explicit `designDepth: 'standard'`, the resolver reads the context and must still match the registry binding. */
  it('PlanStructureResolver_StandardDepth_MatchesRegistryPlanPhasesBinding', () => {
    const registryPlanGates = new Set(
      TOOL_REGISTRY.flatMap((t) => t.actions)
        .filter((a) => setEqualsNames(a.phases, PLAN_PHASE_NAMES))
        .map((a) => a.name),
    );
    const resolved = resolveGateSet('PLAN', {
      riskTier: 'low',
      boundaryTouching: false,
      designDepth: 'standard',
    });
    expect(resolved.every((g) => g.family === 'plan')).toBe(true);
    expect(new Set(resolved.map((g) => g.gate))).toEqual(registryPlanGates);
  });

  /**
   * No resolved gate set holds `check_design_completeness`. `check_plan_coverage` reports its acceptance-criteria finding.
   * It stays only as a deprecated registry action that is not bound to the plan phases.
   */
  it('GateChains_DesignCompletenessExcised_AbsentFromSpecReviewChain', () => {
    const isDesignCompleteness = (gate: string): boolean =>
      gate === 'check_design_completeness' || gate.includes('design-completeness');

    const reviewChain = resolveGateSet('REVIEW', {
      riskTier: 'low',
      boundaryTouching: false,
      designDepth: 'standard',
    }).map((g) => g.gate);
    expect(reviewChain.some(isDesignCompleteness)).toBe(false);

    const planChain = resolveGateSet('PLAN', {
      riskTier: 'low',
      boundaryTouching: false,
      designDepth: 'standard',
    }).map((g) => g.gate);
    expect(planChain.some(isDesignCompleteness)).toBe(false);

    const entry = TOOL_REGISTRY.flatMap((t) => t.actions).find(
      (a) => a.name === 'check_design_completeness',
    );
    expect(entry).toBeDefined();
    expect(setEqualsNames(entry!.phases, PLAN_PHASE_NAMES)).toBe(false);
    expect(entry!.deprecated).toBe(true);
  });

  /** The `deep` rung adds `check_exploration_depth` after the five gates of `standard`. */
  it('PlanStructureResolver_DeepDepth_AddsExplorationObligation', () => {
    const standardCtx: ResolveGateSetCtx = {
      riskTier: 'low',
      boundaryTouching: false,
      designDepth: 'standard',
    };
    const deepCtx: ResolveGateSetCtx = {
      riskTier: 'low',
      boundaryTouching: false,
      designDepth: 'deep',
    };
    const standardSeq = resolveGateSet('PLAN', standardCtx).map((g) => g.gate);
    const deepSeq = resolveGateSet('PLAN', deepCtx).map((g) => g.gate);

    expect(deepSeq).toEqual([...standardSeq, 'check_exploration_depth']);
    expect(resolveGateSet('PLAN', deepCtx).every((g) => g.family === 'plan')).toBe(true);
  });
});

describe('review-contract resolver (DR-9)', () => {
  it('ResolveGateSet_ReviewKindFeatureLowTier_ReturnsBaseDimensions', () => {
    const resolved = resolveGateSet('REVIEW', {
      riskTier: 'low',
      boundaryTouching: false,
      workflowType: 'feature',
    });
    expect(resolved.every((g) => g.family === 'review')).toBe(true);
    expect(resolved.map((g) => g.gate)).toEqual(['review']);
  });

  it('ResolveGateSet_ReviewKindFeatureHighTier_AppendsMutationAdequacy', () => {
    const resolved = resolveGateSet('REVIEW', {
      riskTier: 'high',
      boundaryTouching: false,
      workflowType: 'feature',
    });
    expect(resolved.map((g) => g.gate)).toEqual([
      'review',
      'mutation-adequacy',
    ]);
  });

  /**
   * The resolver must equal `getRequiredReviews`, so `review-contract.ts` owns the dimension names.
   * The set handler builds `_requiredReviews` through `resolveGateSet('REVIEW')`.
   */
  it('ResolveGateSet_ReviewKind_MatchesReviewContractSoT', () => {
    for (const riskTier of ['low', 'medium', 'high'] as const) {
      const resolved = resolveGateSet('REVIEW', {
        riskTier,
        boundaryTouching: false,
        workflowType: 'feature',
      }).map((g) => g.gate);
      expect(resolved).toEqual(getRequiredReviews('feature', riskTier));
    }
  });

  /** An absent or unknown `workflowType` resolves to the base roster and does not throw. */
  it('ResolveGateSet_ReviewKind_AbsentWorkflowType_FallsBackToBase_NeverThrows_DR7', () => {
    expect(() =>
      resolveGateSet('REVIEW', { riskTier: 'high', boundaryTouching: false }),
    ).not.toThrow();
    const resolved = resolveGateSet('REVIEW', {
      riskTier: 'high',
      boundaryTouching: false,
      workflowType: 'not-a-real-type',
    }).map((g) => g.gate);
    expect(resolved).toEqual(getRequiredReviews('not-a-real-type', 'high'));
  });
});

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

  /**
   * A `designDepth` outside thin, standard and deep must fail the PLAN resolution closed through the real resolver.
   * Then the caller appends `phase.blocked`. The reason names the bad depth.
   */
  it('ResolveGateSet_MalformedDesignDepth_FailsClosedBlocked', () => {
    const malformed = { riskTier: 'low', boundaryTouching: false, designDepth: 'shallow' } as unknown as ResolveGateSetCtx;
    const outcome = resolveGateSetFailClosed('PLAN', malformed);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toMatch(/designDepth/);
      expect(outcome.reason).toMatch(/shallow/);
    }
    expect(() => resolveGateSet('PLAN', malformed)).toThrow(/shallow/);
  });

  /** An absent `designDepth` is not a fault. It resolves to `standard`, so fail-closed fires only on a malformed depth. */
  it('ResolveGateSet_AbsentDesignDepth_ResolvesOpenNotBlocked', () => {
    const outcome = resolveGateSetFailClosed('PLAN', { riskTier: 'low', boundaryTouching: false });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.gates.map((g) => g.gate)).toEqual([
        'check_task_decomposition',
        'check_plan_coverage',
        'spec_coverage_check',
        'check_provenance_chain',
        'generate_traceability',
      ]);
    }
  });
});

describe('synthesis-readiness resolver (DR-9)', () => {
  it('ResolveGateSet_SynthesizeKind_ReturnsReadinessLegs', () => {
    const resolved = resolveGateSet('SYNTHESIZE', { riskTier: 'low', boundaryTouching: false });
    expect(resolved.every((g) => g.family === 'synthesis')).toBe(true);
    expect(resolved.map((g) => g.gate)).toEqual([
      'task-completion',
      'tests',
      'typecheck',
      'document',
      'stack',
    ]);
  });

  /**
   * The `document` leg sits directly after `typecheck` and before `stack`, so a docs gap shows with the build legs.
   * `prepare-synthesis.ts` evaluates the leg.
   */
  it('SynthesisReadinessResolver_Roster_PinsDocumentAfterTypecheck', () => {
    const legs = resolveGateSet('SYNTHESIZE', { riskTier: 'low', boundaryTouching: false }).map(
      (g) => g.gate,
    );
    const typecheckIdx = legs.indexOf('typecheck');
    const documentIdx = legs.indexOf('document');
    const stackIdx = legs.indexOf('stack');
    expect(documentIdx).toBe(typecheckIdx + 1);
    expect(stackIdx).toBe(documentIdx + 1);
  });
});

/** Gate sets bind to the phase kind, not to the workflow type and phase name. */
describe('INV-6 cross-workflow-type acceptance', () => {
  const ALL_HSMS = [
    createFeatureHSM(),
    createDebugHSM(),
    createRefactorHSM(),
    createOneshotHSM(),
    createDiscoveryHSM(),
  ];

  it('PlanKind_DebugRcaAndFeaturePlanReview_ResolveIdenticalGateSet', () => {
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
