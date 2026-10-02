import { describe, it, expect } from 'vitest';
import {
  serializeTopology,
  listWorkflowTypes,
  getHSMDefinition,
  getInitialPhase,
  isBuiltInWorkflowType,
  executeTransition,
  countPlanRevisions,
  getValidTransitions,
} from '../../../src/workflow/state-machine.js';
import type {
  SerializedTopology,
  WorkflowTypeSummary,
  HSMDefinition,
} from '../../../src/workflow/state-machine.js';
import { EXCLUDED_MERGE_PHASES, createFeatureHSM, createRefactorHSM } from '../../../src/workflow/hsm-definitions.js';
import { EVENT_DATA_SCHEMAS, isBuiltInEventType } from '../../../src/events/schemas.js';
import { buildHsmEventData } from '../../../src/workflow/hsm-transition-guard.js';
import { mapInternalToExternalType } from '../../../src/workflow/events.js';
import { resolveGateSet, KIND_OBLIGATIONS } from '../../../src/workflow/phase-kind.js';
import type { PhaseKind, ResolvedGate } from '../../../src/workflow/phase-kind.js';

describe('serializeTopology', () => {
  /** The feature workflow starts at `plan` and has no `ideate` state. */
  it('SerializeTopology_FeatureWorkflow_ReturnsStatesAndTransitions', () => {
    const result: SerializedTopology = serializeTopology('feature');

    expect(result.workflowType).toBe('feature');
    expect(result.initialPhase).toBe('plan');

    expect(result.states['ideate']).toBeUndefined();
    expect(result.states['plan']).toBeDefined();
    expect(result.states['plan'].id).toBe('plan');
    expect(result.states['plan'].type).toBe('atomic');

    expect(result.states['completed']).toBeDefined();
    expect(result.states['completed'].type).toBe('final');

    expect(result.states['implementation']).toBeDefined();
    expect(result.states['implementation'].type).toBe('compound');

    expect(result.transitions.length).toBeGreaterThan(0);
    const planToReview = result.transitions.find(
      (t) => t.from === 'plan' && t.to === 'plan-review',
    );
    expect(planToReview).toBeDefined();
    expect(planToReview!.from).toBe('plan');
    expect(planToReview!.to).toBe('plan-review');
  });

  it('SerializeTopology_RefactorWorkflow_IncludesTracks', () => {
    const result: SerializedTopology = serializeTopology('refactor');

    expect(result.tracks).toBeDefined();
    expect(Object.keys(result.tracks).length).toBeGreaterThan(0);

    expect(result.tracks['polish-track']).toBeDefined();
    expect(result.tracks['polish-track']).toContain('polish-implement');
    expect(result.tracks['polish-track']).toContain('polish-validate');
    expect(result.tracks['polish-track']).toContain('polish-update-docs');

    expect(result.tracks['overhaul-track']).toBeDefined();
    expect(result.tracks['overhaul-track']).toContain('overhaul-plan');
    expect(result.tracks['overhaul-track']).toContain('overhaul-delegate');
    expect(result.tracks['overhaul-track']).toContain('overhaul-review');
    expect(result.tracks['overhaul-track']).toContain('overhaul-update-docs');
  });

  /** A serialized guard carries no `evaluate` function, so the topology stays JSON-serializable. */
  it('SerializeTopology_TransitionGuards_IncludeIdAndDescription', () => {
    const result: SerializedTopology = serializeTopology('feature');

    const planToReview = result.transitions.find(
      (t) => t.from === 'plan' && t.to === 'plan-review',
    );
    expect(planToReview).toBeDefined();
    expect(planToReview!.guard).toBeDefined();
    expect(planToReview!.guard!.id).toBe('plan-artifact-exists');
    expect(planToReview!.guard!.description).toBe('Plan artifact must exist');

    expect((planToReview!.guard as Record<string, unknown>)['evaluate']).toBeUndefined();
  });

  it('SerializeTopology_CompoundStates_IncludeParentAndInitial', () => {
    const result: SerializedTopology = serializeTopology('feature');

    const implementation = result.states['implementation'];
    expect(implementation).toBeDefined();
    expect(implementation.type).toBe('compound');
    expect(implementation.initial).toBe('delegate');
    expect(implementation.maxFixCycles).toBe(3);

    const delegate = result.states['delegate'];
    expect(delegate).toBeDefined();
    expect(delegate.parent).toBe('implementation');

    const review = result.states['review'];
    expect(review).toBeDefined();
    expect(review.parent).toBe('implementation');

    expect(implementation.onEntry).toEqual(['log']);
    expect(implementation.onExit).toEqual(['log']);
  });

  it('SerializeTopology_UnknownWorkflowType_Throws', () => {
    expect(() => serializeTopology('nonexistent')).toThrow(
      'Unknown workflow type: nonexistent',
    );
  });

  it('SerializeTopology_TransitionsIncludeFixCycleAndEffects', () => {
    const result: SerializedTopology = serializeTopology('feature');

    const reviewToDelegate = result.transitions.find(
      (t) => t.from === 'review' && t.to === 'delegate',
    );
    expect(reviewToDelegate).toBeDefined();
    expect(reviewToDelegate!.isFixCycle).toBe(true);
    expect(reviewToDelegate!.effects).toEqual(['increment-fix-cycle']);
  });
});

describe('listWorkflowTypes', () => {
  it('ListWorkflowTypes_ReturnsAllRegisteredTypes', () => {
    const result: WorkflowTypeSummary = listWorkflowTypes();

    expect(result.workflowTypes).toBeDefined();
    expect(result.workflowTypes.length).toBeGreaterThanOrEqual(3);

    const names = result.workflowTypes.map((wt) => wt.name);
    expect(names).toContain('feature');
    expect(names).toContain('debug');
    expect(names).toContain('refactor');

    const feature = result.workflowTypes.find((wt) => wt.name === 'feature');
    expect(feature).toBeDefined();
    expect(feature!.initialPhase).toBe('plan');
    expect(feature!.phaseCount).toBeGreaterThan(0);
    expect(feature!.trackCount).toBeGreaterThanOrEqual(0);

    const debug = result.workflowTypes.find((wt) => wt.name === 'debug');
    expect(debug).toBeDefined();
    expect(debug!.trackCount).toBe(2);

    const refactor = result.workflowTypes.find((wt) => wt.name === 'refactor');
    expect(refactor).toBeDefined();
    expect(refactor!.trackCount).toBe(2);
  });
});

describe('Discovery workflow', () => {
  it('getHSMDefinition_Discovery_ReturnsValidDefinition', () => {
    const hsm = getHSMDefinition('discovery');
    expect(hsm.id).toBe('discovery');
    expect(Object.keys(hsm.states)).toContain('gathering');
    expect(Object.keys(hsm.states)).toContain('synthesizing');
    expect(Object.keys(hsm.states)).toContain('completed');
    expect(Object.keys(hsm.states)).toContain('cancelled');
  });

  it('getInitialPhase_Discovery_ReturnsGathering', () => {
    expect(getInitialPhase('discovery')).toBe('gathering');
  });

  it('isBuiltInWorkflowType_Discovery_ReturnsTrue', () => {
    expect(isBuiltInWorkflowType('discovery')).toBe(true);
  });

  it('executeTransition_Discovery_GatheringToSynthesizing_PassesWithSources', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', artifacts: { sources: ['a.md'] }, _events: [] };
    const result = executeTransition(hsm, state, 'synthesizing');
    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('synthesizing');
  });

  it('executeTransition_Discovery_GatheringToSynthesizing_FailsWithoutSources', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', artifacts: {}, _events: [] };
    const result = executeTransition(hsm, state, 'synthesizing');
    expect(result.success).toBe(false);
  });

  it('executeTransition_Discovery_SynthesizingToCompleted_PassesWithReport', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'synthesizing', artifacts: { report: 'docs/report.md' }, _events: [] };
    const result = executeTransition(hsm, state, 'completed');
    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('completed');
  });

  it('executeTransition_Discovery_CancelFromGathering_Succeeds', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', _events: [] };
    const result = executeTransition(hsm, state, 'cancelled');
    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('cancelled');
  });
});

/** Every advance into an atomic state with a kind resolves the gate-set of the target kind. */
describe('executeTransition phase-kind resolve (DR-10)', () => {
  it('ExecuteTransition_AtomicTarget_AttachesResolvedGateSet', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', artifacts: { sources: ['a.md'] }, _events: [] };
    const result = executeTransition(hsm, state, 'synthesizing');
    expect(result.success).toBe(true);
    const targetKind = (hsm.states['synthesizing'] as { kind: PhaseKind }).kind;
    expect(result.resolvedGates).toEqual(
      resolveGateSet(targetKind, {
        riskTier: 'low',
        boundaryTouching: false,
        workflowType: hsm.id,
      }),
    );
  });

  /** A resolver that throws must block the transition, so the boundary fails closed. */
  it('ExecuteTransition_ResolverThrows_ReturnsPhaseBlocked', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', artifacts: { sources: ['a.md'] }, _events: [] };
    const result = executeTransition(hsm, state, 'synthesizing', () => {
      throw new Error('resolver boom');
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PHASE_BLOCKED');
    expect(result.events.some((e) => e.type === 'phase.blocked')).toBe(true);
  });
});

/** A transition freezes the resolved obligation on one `phase.entered` event. */
describe('executeTransition resolve-then-freeze (DR-13)', () => {
  /**
   * The frozen metadata holds the kind, the resolver, the gate-set as `{family, gate}` pairs, the policy source, the mode and the posture.
   * It must parse against the durable `phase.entered` schema.
   */
  it('executeTransition_EveryTransition_AppendsExactlyOnePhaseEntered', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', artifacts: { sources: ['a.md'] }, _events: [] };
    const result = executeTransition(hsm, state, 'synthesizing');
    expect(result.success).toBe(true);

    const entered = result.events.filter((e) => e.type === 'phase.entered');
    expect(entered).toHaveLength(1);

    const targetKind = (hsm.states['synthesizing'] as { kind: PhaseKind }).kind;
    const md = entered[0].metadata as Record<string, unknown>;
    expect(md.phase).toBe('synthesizing');
    expect(md.kind).toBe(targetKind);
    expect(md.resolver).toBe(KIND_OBLIGATIONS[targetKind].gates?.resolver ?? null);
    expect(md.resolvedGates).toEqual(
      resolveGateSet(targetKind, {
        riskTier: 'low',
        boundaryTouching: false,
        workflowType: hsm.id,
      }).map((g) => ({ family: g.family, gate: g.gate })),
    );
    expect(md.policySource).toBe('builtin');
    expect(md.mode).toBe('enforce');
    expect(md.posture).toBe(KIND_OBLIGATIONS[targetKind].posture);

    const schema = EVENT_DATA_SCHEMAS['phase.entered'];
    expect(schema?.safeParse(md).success).toBe(true);
  });

  it('executeTransition_BlockedTransition_AppendsNoPhaseEntered', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', artifacts: { sources: ['a.md'] }, _events: [] };
    const result = executeTransition(hsm, state, 'synthesizing', () => {
      throw new Error('resolver boom');
    });
    expect(result.success).toBe(false);
    expect(result.events.some((e) => e.type === 'phase.entered')).toBe(false);
  });

  /**
   * `plan-review` is a PLAN phase, and every `phase.entered` into a PLAN phase freezes `designDepth`.
   * A `designDepth` on the state is frozen as is. Without one, the freeze records `standard`.
   * A non-PLAN `phase.entered` omits `designDepth`.
   */
  it('PhaseEntered_PlanPhase_FreezesDesignDepth', () => {
    const feature = getHSMDefinition('feature');
    const planArtifact = { artifacts: { plan: 'docs/specs/x.md' } };
    const mdOf = (r: ReturnType<typeof executeTransition>) =>
      r.events.find((e) => e.type === 'phase.entered')!.metadata as Record<string, unknown>;

    const overridden = executeTransition(
      feature,
      { phase: 'plan', ...planArtifact, designDepth: 'deep', _events: [] },
      'plan-review',
    );
    expect(overridden.success).toBe(true);
    expect(overridden.events.filter((e) => e.type === 'phase.entered')).toHaveLength(1);
    expect(mdOf(overridden).designDepth).toBe('deep');

    const defaulted = executeTransition(
      feature,
      { phase: 'plan', ...planArtifact, _events: [] },
      'plan-review',
    );
    expect(mdOf(defaulted).designDepth).toBe('standard');

    const schema = EVENT_DATA_SCHEMAS['phase.entered'];
    expect(schema?.safeParse(mdOf(overridden)).success).toBe(true);
    expect(schema?.safeParse({ ...mdOf(overridden), designDepth: 'bogus' }).success).toBe(false);

    const nonPlan = executeTransition(
      getHSMDefinition('discovery'),
      { phase: 'gathering', artifacts: { sources: ['a.md'] }, _events: [] },
      'synthesizing',
    );
    expect(mdOf(nonPlan).designDepth).toBeUndefined();
  });

  /** The freeze copies the resolver output, so a later change to that array leaves the frozen gate-set unchanged. */
  it('freeze_PolicyTableMutatedAfterEntry_FrozenObligationUnchanged', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', artifacts: { sources: ['a.md'] }, _events: [] };
    const live: ResolvedGate[] = [{ family: 'synthesis', gate: 'tests' }];
    const result = executeTransition(hsm, state, 'synthesizing', () => live);

    const entered = result.events.find((e) => e.type === 'phase.entered');
    const frozen = (entered?.metadata as Record<string, unknown>).resolvedGates;
    expect(frozen).toEqual([{ family: 'synthesis', gate: 'tests' }]);

    live.push({ family: 'synthesis', gate: 'typecheck' });
    (live[0] as { gate: string }).gate = 'MUTATED';

    expect(frozen).toEqual([{ family: 'synthesis', gate: 'tests' }]);
  });

  /**
   * IMPLEMENT records no phase-level gate sequence, because the wave stamp holds its per-task sequences.
   * The event and `result.resolvedGates` both hold an empty array. The resolver, posture and mode are still frozen.
   */
  it('executeTransition_ImplementKind_FreezesEmptyResolvedGatesSequence', () => {
    const hsm = getHSMDefinition('oneshot');
    const state = { phase: 'plan', artifacts: { plan: 'docs/plan.md' }, _events: [] };
    const result = executeTransition(hsm, state, 'implementing');
    expect(result.success).toBe(true);

    const entered = result.events.filter((e) => e.type === 'phase.entered');
    expect(entered).toHaveLength(1);
    const md = entered[0].metadata as Record<string, unknown>;
    expect(md.kind).toBe('IMPLEMENT');
    expect(md.resolvedGates).toEqual([]);
    expect(result.resolvedGates).toEqual([]);
    expect(md.resolver).toBe(KIND_OBLIGATIONS.IMPLEMENT.gates?.resolver ?? null);
    expect(md.posture).toBe(KIND_OBLIGATIONS.IMPLEMENT.posture);
    expect(md.mode).toBe('enforce');
    const schema = EVENT_DATA_SCHEMAS['phase.entered'];
    expect(schema?.safeParse(md).success).toBe(true);
  });

  /** A forward advance appends one `phase.exited` for the left phase, with `allRequiredGatesPassed: true`, before `phase.entered`. */
  it('executeTransition_PhaseAdvance_AppendsPhaseExitedWithGateStatus', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', artifacts: { sources: ['a.md'] }, _events: [] };
    const result = executeTransition(hsm, state, 'synthesizing');
    expect(result.success).toBe(true);

    const exited = result.events.filter((e) => e.type === 'phase.exited');
    expect(exited).toHaveLength(1);
    const md = exited[0].metadata as Record<string, unknown>;
    expect(md.phase).toBe('gathering');
    expect(md.allRequiredGatesPassed).toBe(true);

    const types = result.events.map((e) => e.type);
    expect(types.indexOf('phase.exited')).toBeLessThan(types.indexOf('phase.entered'));

    const schema = EVENT_DATA_SCHEMAS['phase.exited'];
    expect(schema?.safeParse(md).success).toBe(true);
  });

  /** `review → delegate` is a fix-cycle edge, so `phase.exited` records `allRequiredGatesPassed: false`. */
  it('executeTransition_FixCycle_PhaseExitedReportsGatesNotPassed', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'review',
      reviews: { 'reviewer-a': { status: 'failed' } },
      _events: [],
    };
    const result = executeTransition(hsm, state, 'delegate');
    expect(result.success).toBe(true);
    const exited = result.events.find((e) => e.type === 'phase.exited');
    expect(exited).toBeDefined();
    expect((exited?.metadata as Record<string, unknown>).phase).toBe('review');
    expect((exited?.metadata as Record<string, unknown>).allRequiredGatesPassed).toBe(false);
  });
});

describe('Feature workflow merge-pending substate', () => {
  it('exposes EXCLUDED_MERGE_PHASES as a reusable constant', () => {
    expect(EXCLUDED_MERGE_PHASES).toBeInstanceOf(Set);
    expect(EXCLUDED_MERGE_PHASES.has('completed')).toBe(true);
    expect(EXCLUDED_MERGE_PHASES.has('rolled-back')).toBe(true);
    expect(EXCLUDED_MERGE_PHASES.has('aborted')).toBe(true);
    expect(EXCLUDED_MERGE_PHASES.has('pending')).toBe(false);
    expect(EXCLUDED_MERGE_PHASES.has('executing')).toBe(false);
  });

  it('featureHsm_TaskCompletedWithWorktree_TransitionsToMergePending', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'delegate',
      _events: [
        {
          type: 'task.completed',
          data: {
            taskId: 'T01',
            worktree: '/path/to/worktree',
          },
        },
      ],
    };
    const result = executeTransition(hsm, state, 'merge-pending');
    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('merge-pending');
  });

  /** A `task.completed` event without `worktree` or `worktreePath` fails the merge-pending entry guard. */
  it('featureHsm_TaskCompletedWithoutWorktree_DoesNotTransitionToMergePending', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'delegate',
      _events: [
        {
          type: 'task.completed',
          data: {
            taskId: 'T01',
          },
        },
      ],
    };
    const result = executeTransition(hsm, state, 'merge-pending');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('GUARD_FAILED');
  });

  it('featureHsm_MergeCompletedEvent_LeavesMergePendingState', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'merge-pending',
      mergeOrchestrator: { phase: 'completed' },
      _events: [
        {
          type: 'task.completed',
          data: { taskId: 'T01', worktree: '/path/to/worktree' },
        },
        {
          type: 'merge.executed',
          data: { taskId: 'T01' },
        },
      ],
    };
    const result = executeTransition(hsm, state, 'delegate');
    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('delegate');
  });

  /**
   * A `merge.recovered` event lets the workflow leave merge-pending.
   * The state has no terminal `mergeOrchestrator.phase`, so only the event can pass the guard.
   */
  it('featureHsm_MergeRecoveredEvent_LeavesMergePendingState', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'merge-pending',
      _events: [
        {
          type: 'task.completed',
          data: { taskId: 'T01', worktree: '/path/to/worktree' },
        },
        {
          type: 'merge.recovered',
          data: { taskId: 'T01', recoveryPointSha: 'abc123', reason: 'timeout' },
        },
      ],
    };
    const result = executeTransition(hsm, state, 'delegate');
    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('delegate');
  });

  /** A terminal `mergeOrchestrator.phase` blocks a new entry into merge-pending, even after a `task.completed` with a worktree. */
  it('featureHsm_TaskCompletedWithWorktree_DoesNotTransitionWhenMergeCompleted', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'delegate',
      mergeOrchestrator: { phase: 'completed' },
      _events: [
        {
          type: 'task.completed',
          data: { taskId: 'T01', worktree: '/path/to/worktree' },
        },
      ],
    };
    const result = executeTransition(hsm, state, 'merge-pending');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('GUARD_FAILED');
  });
});

/**
 * A fix-cycle edge from a top-level state has no parent compound.
 * Its event must omit `compoundStateId` and still parse against the `workflow.fix-cycle` schema.
 */
describe('Fix-cycle event schema validity (#1339)', () => {
  function makeNonCompoundFixCycleHsm(): HSMDefinition {
    return {
      id: 'test-noncompound',
      states: {
        a: { id: 'a', type: 'atomic' },
        b: { id: 'b', type: 'atomic' },
      },
      transitions: [
        { from: 'a', to: 'b', isFixCycle: true },
      ],
    };
  }

  /** The test builds the persisted `data` as the append path does: the emitted metadata plus `count` and `featureId`. */
  it('ExecuteTransition_FixCycleOnNonCompoundChild_EmitsSchemaValidEvent', () => {
    const hsm = makeNonCompoundFixCycleHsm();
    const state = { phase: 'a', _events: [] };

    const result = executeTransition(hsm, state, 'b');
    expect(result.success).toBe(true);

    const fixCycleEvent = result.events.find((e) => e.type === 'fix-cycle');
    expect(fixCycleEvent).toBeDefined();

    const schema = EVENT_DATA_SCHEMAS['workflow.fix-cycle'];
    expect(schema).toBeDefined();

    const data = {
      ...(fixCycleEvent!.metadata ?? {}),
      count: 1,
      featureId: 'feat-1339',
    };

    const parsed = schema!.safeParse(data);
    expect(parsed.success).toBe(true);

    expect(
      Object.prototype.hasOwnProperty.call(
        fixCycleEvent!.metadata ?? {},
        'compoundStateId',
      ),
    ).toBe(false);
  });
});

/**
 * The executor emits `plan-revision` on every `isRevision` edge except the standard feature `plan-review → plan` edge.
 * The test HSM has one such edge, `overhaul-plan-review → overhaul-plan`.
 * Its states have no parent compound and no `kind`, so gate-set resolution does not run.
 */
describe('Plan-revision counted event (DR-1)', () => {
  function makeRevisionHsm(): HSMDefinition {
    return {
      id: 'test-revision',
      states: {
        'overhaul-plan': { id: 'overhaul-plan', type: 'atomic' },
        'overhaul-plan-review': { id: 'overhaul-plan-review', type: 'atomic' },
      },
      transitions: [
        { from: 'overhaul-plan-review', to: 'overhaul-plan', isRevision: true },
        { from: 'overhaul-plan', to: 'overhaul-plan-review' },
      ],
    } as HSMDefinition;
  }

  /** A top-level phase has no parent compound, so the event omits `compoundStateId`. */
  it('ExecuteTransition_IsRevisionTransition_EmitsExactlyOnePlanRevisionEvent', () => {
    const hsm = makeRevisionHsm();
    const state = { phase: 'overhaul-plan-review', _events: [] };

    const result = executeTransition(hsm, state, 'overhaul-plan');
    expect(result.success).toBe(true);

    const revisionEvents = result.events.filter((e) => e.type === 'plan-revision');
    expect(revisionEvents).toHaveLength(1);
    expect(revisionEvents[0].from).toBe('overhaul-plan-review');
    expect(revisionEvents[0].to).toBe('overhaul-plan');
    expect(
      Object.prototype.hasOwnProperty.call(
        revisionEvents[0].metadata ?? {},
        'compoundStateId',
      ),
    ).toBe(false);
  });

  it('ExecuteTransition_NonRevisionTransition_EmitsNoPlanRevisionEvent', () => {
    const hsm = makeRevisionHsm();
    const state = { phase: 'overhaul-plan', _events: [] };

    const result = executeTransition(hsm, state, 'overhaul-plan-review');
    expect(result.success).toBe(true);
    expect(result.events.find((e) => e.type === 'plan-revision')).toBeUndefined();
  });

  it('CountPlanRevisions_MixedLog_CountsInternalAndExternalShapes', () => {
    const events = [
      { type: 'transition' },
      { type: 'plan-revision' },
      { type: 'fix-cycle' },
      { type: 'workflow.plan-revision' },
      { type: 'plan-revision' },
    ];
    expect(countPlanRevisions(events)).toBe(3);
  });

  it('CountPlanRevisions_NoRevisions_ReturnsZero', () => {
    expect(
      countPlanRevisions([{ type: 'transition' }, { type: 'fix-cycle' }]),
    ).toBe(0);
  });

  /** The data that `buildHsmEventData` builds for a `plan-revision` event must parse against the registered `workflow.plan-revision` schema. */
  it('PlanRevisionEvent_BuiltEmissionData_ParsesAgainstRegisteredSchema', () => {
    const hsm = makeRevisionHsm();
    const state = { phase: 'overhaul-plan-review', _events: [] };
    const result = executeTransition(hsm, state, 'overhaul-plan');
    const revisionEvent = result.events.find((e) => e.type === 'plan-revision');
    expect(revisionEvent).toBeDefined();

    const data = buildHsmEventData(revisionEvent!, 'feat-dr1', {
      planRevisionOrdinal: 1,
    });
    const schema = EVENT_DATA_SCHEMAS['workflow.plan-revision'];
    expect(schema).toBeDefined();
    const parsed = schema!.safeParse(data);
    expect(parsed.success).toBe(true);
    expect(data).toMatchObject({ count: 1, featureId: 'feat-dr1' });
  });

  it('PlanRevisionType_MapsToRegisteredExternalEventType', () => {
    expect(mapInternalToExternalType('plan-revision')).toBe('workflow.plan-revision');
    expect(isBuiltInEventType('workflow.plan-revision')).toBe(true);
  });
});

/**
 * The feature revise edge `plan-review → plan` carries `isRevision`, and `plan-review → blocked` comes before it.
 * Transition targets enumerate in array order, so the bound wins at the cap.
 * A traversal of this edge emits no `plan-revision`, because `prepare_review` counts this loop.
 */
describe('Feature HSM plan-review bound (DR-1, Task 002)', () => {
  const planReviewTransitions = () =>
    createFeatureHSM().transitions.filter((t) => t.from === 'plan-review');

  /** The edge keeps `isRevision`. `executeTransition` matches this edge by workflow type and phases to skip the emission. */
  it('ReviseEdge_CarriesIsRevisionFlag', () => {
    const revise = planReviewTransitions().find((t) => t.to === 'plan');
    expect(revise).toBeDefined();
    expect(revise!.isRevision).toBe(true);
  });

  it('ForwardAndTerminalEdges_AreNotRevisions', () => {
    for (const target of ['delegate', 'blocked'] as const) {
      const t = planReviewTransitions().find((x) => x.to === target);
      expect(t).toBeDefined();
      expect(t!.isRevision ?? false).toBe(false);
    }
  });

  /**
   * At the cap, `revisionsExhausted` and `planReviewGapsFound` both pass.
   * The ordered enumeration puts the `blocked` exit first.
   */
  it('BlockedEdge_OrderedBeforeReviseEdge', () => {
    const targets = getValidTransitions(createFeatureHSM(), 'plan-review').map((t) => t.phase);
    const blockedIdx = targets.indexOf('blocked');
    const planIdx = targets.indexOf('plan');
    expect(blockedIdx).toBeGreaterThanOrEqual(0);
    expect(planIdx).toBeGreaterThanOrEqual(0);
    expect(blockedIdx).toBeLessThan(planIdx);
  });

  /**
   * `prepare_review` counts this loop with `workflow.plan-review-dispatched`.
   * If the edge also emits `plan-revision`, one loop counts twice.
   */
  it('ReviseEdge_TraversalEmitsNoPlanRevision_OnRealHsm_RetiredForStandardEdge', () => {
    const hsm = createFeatureHSM();
    const state = {
      phase: 'plan-review',
      planReview: { gapsFound: true, revisionCount: 0 },
      _events: [],
    };
    const result = executeTransition(hsm, state, 'plan');
    expect(result.success).toBe(true);
    expect(result.events.filter((e) => e.type === 'plan-revision')).toHaveLength(0);
  });
});

/**
 * The overhaul track has the same bound as the feature HSM.
 * Its revise edge must carry `isRevision` and come after `blocked`, or the plan-review loop has no bound.
 */
describe('Overhaul HSM plan-review bound (DR-1 parity — RVC-R8)', () => {
  const overhaulPlanReview = () =>
    createRefactorHSM().transitions.filter((t) => t.from === 'overhaul-plan-review');

  it('ReviseEdge_CarriesIsRevisionFlag', () => {
    const revise = overhaulPlanReview().find((t) => t.to === 'overhaul-plan');
    expect(revise).toBeDefined();
    expect(revise!.isRevision).toBe(true);
  });

  it('ForwardAndTerminalEdges_AreNotRevisions', () => {
    for (const target of ['overhaul-delegate', 'blocked'] as const) {
      const t = overhaulPlanReview().find((x) => x.to === target);
      expect(t).toBeDefined();
      expect(t!.isRevision ?? false).toBe(false);
    }
  });

  it('BlockedEdge_OrderedBeforeReviseEdge', () => {
    const targets = getValidTransitions(createRefactorHSM(), 'overhaul-plan-review').map(
      (t) => t.phase,
    );
    const blockedIdx = targets.indexOf('blocked');
    const planIdx = targets.indexOf('overhaul-plan');
    expect(blockedIdx).toBeGreaterThanOrEqual(0);
    expect(planIdx).toBeGreaterThanOrEqual(0);
    expect(blockedIdx).toBeLessThan(planIdx);
  });

  it('ReviseEdge_TraversalEmitsCountedPlanRevision_OnRealHsm', () => {
    const hsm = createRefactorHSM();
    const state = {
      phase: 'overhaul-plan-review',
      planReview: { gapsFound: true, revisionCount: 0 },
      _events: [],
    };
    const result = executeTransition(hsm, state, 'overhaul-plan');
    expect(result.success).toBe(true);
    expect(result.events.filter((e) => e.type === 'plan-revision')).toHaveLength(1);
  });
});

/**
 * Only the standard feature `plan-review → plan` edge skips the `plan-revision` emission.
 * The overhaul revise edge and the delegate fix-cycle edge keep their counters.
 */
describe('plan-review bound retirement is edge-scoped (WLM-6 DR-2, task 005)', () => {
  it('Overhaul_EdgeBound_StillFires', () => {
    const hsm = createRefactorHSM();
    const state = {
      phase: 'overhaul-plan-review',
      planReview: { gapsFound: true, revisionCount: 0 },
      _events: [],
    };
    const result = executeTransition(hsm, state, 'overhaul-plan');
    expect(result.success).toBe(true);
    expect(result.events.filter((e) => e.type === 'plan-revision')).toHaveLength(1);
    const feature = getHSMDefinition('feature');
    const featureRevise = executeTransition(
      feature,
      { phase: 'plan-review', planReview: { gapsFound: true, revisionCount: 0 }, _events: [] },
      'plan',
    );
    expect(featureRevise.events.filter((e) => e.type === 'plan-revision')).toHaveLength(0);
  });

  /**
   * The feature `review → delegate` fix-cycle edge keeps its `increment-fix-cycle` effect.
   * Its traversal emits one `fix-cycle` event and no `plan-revision`.
   */
  it('Delegate_FixCycleLoop_Unchanged', () => {
    const hsm = getHSMDefinition('feature');
    const reviewToDelegate = hsm.transitions.find(
      (t) => t.from === 'review' && t.to === 'delegate',
    );
    expect(reviewToDelegate?.isFixCycle).toBe(true);
    expect(reviewToDelegate?.effects).toEqual(['increment-fix-cycle']);

    const result = executeTransition(
      hsm,
      { phase: 'review', reviews: { 'reviewer-a': { status: 'failed' } }, _events: [] },
      'delegate',
    );
    expect(result.success).toBe(true);
    expect(result.events.filter((e) => e.type === 'fix-cycle')).toHaveLength(1);
    expect(result.events.filter((e) => e.type === 'plan-revision')).toHaveLength(0);
  });
});
