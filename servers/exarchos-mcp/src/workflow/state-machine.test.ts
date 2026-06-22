import { describe, it, expect } from 'vitest';
import {
  serializeTopology,
  listWorkflowTypes,
  getHSMDefinition,
  getInitialPhase,
  isBuiltInWorkflowType,
  executeTransition,
} from './state-machine.js';
import type {
  SerializedTopology,
  WorkflowTypeSummary,
  HSMDefinition,
} from './state-machine.js';
import { EXCLUDED_MERGE_PHASES } from './hsm-definitions.js';
import { EVENT_DATA_SCHEMAS } from '../event-store/schemas.js';
import { resolveGateSet, KIND_OBLIGATIONS } from './phase-kind.js';
import type { PhaseKind, ResolvedGate } from './phase-kind.js';

describe('serializeTopology', () => {
  it('SerializeTopology_FeatureWorkflow_ReturnsStatesAndTransitions', () => {
    const result: SerializedTopology = serializeTopology('feature');

    expect(result.workflowType).toBe('feature');
    // DR-4 (#1581): plan is initial; ideate (GATHER) removed.
    expect(result.initialPhase).toBe('plan');

    // States should have id and type
    expect(result.states['ideate']).toBeUndefined();
    expect(result.states['plan']).toBeDefined();
    expect(result.states['plan'].id).toBe('plan');
    expect(result.states['plan'].type).toBe('atomic');

    expect(result.states['completed']).toBeDefined();
    expect(result.states['completed'].type).toBe('final');

    expect(result.states['implementation']).toBeDefined();
    expect(result.states['implementation'].type).toBe('compound');

    // Transitions should have from and to
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

    // Tracks should be derived from compound states
    expect(result.tracks).toBeDefined();
    expect(Object.keys(result.tracks).length).toBeGreaterThan(0);

    // Polish track should contain its child states
    expect(result.tracks['polish-track']).toBeDefined();
    expect(result.tracks['polish-track']).toContain('polish-implement');
    expect(result.tracks['polish-track']).toContain('polish-validate');
    expect(result.tracks['polish-track']).toContain('polish-update-docs');

    // Overhaul track should contain its child states
    expect(result.tracks['overhaul-track']).toBeDefined();
    expect(result.tracks['overhaul-track']).toContain('overhaul-plan');
    expect(result.tracks['overhaul-track']).toContain('overhaul-delegate');
    expect(result.tracks['overhaul-track']).toContain('overhaul-review');
    expect(result.tracks['overhaul-track']).toContain('overhaul-update-docs');
  });

  it('SerializeTopology_TransitionGuards_IncludeIdAndDescription', () => {
    const result: SerializedTopology = serializeTopology('feature');

    // Find a guarded transition (plan -> plan-review has planArtifactExists guard)
    const planToReview = result.transitions.find(
      (t) => t.from === 'plan' && t.to === 'plan-review',
    );
    expect(planToReview).toBeDefined();
    expect(planToReview!.guard).toBeDefined();
    expect(planToReview!.guard!.id).toBe('plan-artifact-exists');
    expect(planToReview!.guard!.description).toBe('Plan artifact must exist');

    // Guard should NOT have an evaluate function (JSON-serializable)
    expect((planToReview!.guard as Record<string, unknown>)['evaluate']).toBeUndefined();
  });

  it('SerializeTopology_CompoundStates_IncludeParentAndInitial', () => {
    const result: SerializedTopology = serializeTopology('feature');

    // The compound state should have initial and maxFixCycles
    const implementation = result.states['implementation'];
    expect(implementation).toBeDefined();
    expect(implementation.type).toBe('compound');
    expect(implementation.initial).toBe('delegate');
    expect(implementation.maxFixCycles).toBe(3);

    // Child states should have parent
    const delegate = result.states['delegate'];
    expect(delegate).toBeDefined();
    expect(delegate.parent).toBe('implementation');

    const review = result.states['review'];
    expect(review).toBeDefined();
    expect(review.parent).toBe('implementation');

    // Compound state should include onEntry and onExit
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

    // review -> delegate is a fix cycle
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

    // Should include feature, debug, and refactor
    const names = result.workflowTypes.map((wt) => wt.name);
    expect(names).toContain('feature');
    expect(names).toContain('debug');
    expect(names).toContain('refactor');

    // Each entry should have initialPhase, phaseCount, trackCount
    const feature = result.workflowTypes.find((wt) => wt.name === 'feature');
    expect(feature).toBeDefined();
    expect(feature!.initialPhase).toBe('plan');
    expect(feature!.phaseCount).toBeGreaterThan(0);
    expect(feature!.trackCount).toBeGreaterThanOrEqual(0);

    // Debug has two tracks (thorough-track, hotfix-track)
    const debug = result.workflowTypes.find((wt) => wt.name === 'debug');
    expect(debug).toBeDefined();
    expect(debug!.trackCount).toBe(2);

    // Refactor has two tracks (polish-track, overhaul-track)
    const refactor = result.workflowTypes.find((wt) => wt.name === 'refactor');
    expect(refactor).toBeDefined();
    expect(refactor!.trackCount).toBe(2);
  });
});

// ─── Discovery Workflow Tests (#1080) ──────────────────────────────────────

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

// ─── DR-10: non-optional phase-kind resolve at the transition boundary ───────
describe('executeTransition phase-kind resolve (DR-10)', () => {
  it('ExecuteTransition_AtomicTarget_AttachesResolvedGateSet', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', artifacts: { sources: ['a.md'] }, _events: [] };
    const result = executeTransition(hsm, state, 'synthesizing');
    expect(result.success).toBe(true);
    const targetKind = (hsm.states['synthesizing'] as { kind: PhaseKind }).kind;
    // The boundary resolves the target kind's obligation, non-optionally.
    expect(result.resolvedGates).toEqual(
      resolveGateSet(targetKind, {
        riskTier: 'low',
        boundaryTouching: false,
        workflowType: hsm.id,
      }),
    );
  });

  it('ExecuteTransition_ResolverThrows_ReturnsPhaseBlocked', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', artifacts: { sources: ['a.md'] }, _events: [] };
    // Inject a faulting resolver — the boundary must fail CLOSED, not OPEN.
    const result = executeTransition(hsm, state, 'synthesizing', () => {
      throw new Error('resolver boom');
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PHASE_BLOCKED');
    expect(result.events.some((e) => e.type === 'phase.blocked')).toBe(true);
  });
});

// ─── Resolve-then-freeze: phase.entered append (DR-13, DR-10 freeze half) ────

describe('executeTransition resolve-then-freeze (DR-13)', () => {
  it('executeTransition_EveryTransition_AppendsExactlyOnePhaseEntered', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', artifacts: { sources: ['a.md'] }, _events: [] };
    const result = executeTransition(hsm, state, 'synthesizing');
    expect(result.success).toBe(true);

    // Exactly one phase.entered accompanies the transition — the freeze half of
    // the resolve-then-freeze PDP (DR-10/DR-13).
    const entered = result.events.filter((e) => e.type === 'phase.entered');
    expect(entered).toHaveLength(1);

    const targetKind = (hsm.states['synthesizing'] as { kind: PhaseKind }).kind;
    const md = entered[0].metadata as Record<string, unknown>;
    expect(md.phase).toBe('synthesizing');
    expect(md.kind).toBe(targetKind);
    expect(md.resolver).toBe(KIND_OBLIGATIONS[targetKind].gates?.resolver ?? null);
    // The frozen gate-set is the resolver output, snapshotted to {family, gate}.
    expect(md.resolvedGates).toEqual(
      resolveGateSet(targetKind, {
        riskTier: 'low',
        boundaryTouching: false,
        workflowType: hsm.id,
      }).map((g) => ({ family: g.family, gate: g.gate })),
    );
    expect(md.policySource).toBe('builtin');
    expect(md.mode).toBe('enforce');
    // DR-14: the freeze also records the kind's POLA posture (trust tier).
    expect(md.posture).toBe(KIND_OBLIGATIONS[targetKind].posture);

    // The frozen payload validates against the durable phase.entered schema.
    const schema = EVENT_DATA_SCHEMAS['phase.entered'];
    expect(schema?.safeParse(md).success).toBe(true);
  });

  it('executeTransition_BlockedTransition_AppendsNoPhaseEntered', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', artifacts: { sources: ['a.md'] }, _events: [] };
    // A fail-closed resolution emits phase.blocked, never a phase.entered.
    const result = executeTransition(hsm, state, 'synthesizing', () => {
      throw new Error('resolver boom');
    });
    expect(result.success).toBe(false);
    expect(result.events.some((e) => e.type === 'phase.entered')).toBe(false);
  });

  // ─── DR-3 (#1581 task 005): resolve-then-freeze `designDepth` at PLAN entry ──
  it('PhaseEntered_PlanPhase_FreezesDesignDepth', () => {
    const feature = getHSMDefinition('feature');
    // DR-4 (#1581): plan is initial; plan-review is also PLAN-kind, so
    // plan → plan-review is a valid entry into a PLAN phase that triggers the
    // designDepth freeze (the freeze fires on every PLAN phase.entered).
    const planArtifact = { artifacts: { plan: 'docs/specs/x.md' } };
    const mdOf = (r: ReturnType<typeof executeTransition>) =>
      r.events.find((e) => e.type === 'phase.entered')!.metadata as Record<string, unknown>;

    // Author override patched onto state before PLAN entry ⇒ that depth is frozen.
    const overridden = executeTransition(
      feature,
      { phase: 'plan', ...planArtifact, designDepth: 'deep', _events: [] },
      'plan-review',
    );
    expect(overridden.success).toBe(true);
    expect(overridden.events.filter((e) => e.type === 'phase.entered')).toHaveLength(1);
    expect(mdOf(overridden).designDepth).toBe('deep');

    // No override ⇒ the behavior-neutral 'standard' default is frozen.
    const defaulted = executeTransition(
      feature,
      { phase: 'plan', ...planArtifact, _events: [] },
      'plan-review',
    );
    expect(mdOf(defaulted).designDepth).toBe('standard');

    // The frozen payload (now carrying designDepth) still validates against the
    // durable phase.entered schema; and the enum is pinned — 'bogus' is rejected.
    const schema = EVENT_DATA_SCHEMAS['phase.entered'];
    expect(schema?.safeParse(mdOf(overridden)).success).toBe(true);
    expect(schema?.safeParse({ ...mdOf(overridden), designDepth: 'bogus' }).success).toBe(false);

    // Single freeze author: a non-PLAN phase.entered omits designDepth entirely.
    const nonPlan = executeTransition(
      getHSMDefinition('discovery'),
      { phase: 'gathering', artifacts: { sources: ['a.md'] }, _events: [] },
      'synthesizing',
    );
    expect(mdOf(nonPlan).designDepth).toBeUndefined();
  });

  it('freeze_PolicyTableMutatedAfterEntry_FrozenObligationUnchanged', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', artifacts: { sources: ['a.md'] }, _events: [] };
    // Inject a mutable policy source; the freeze must snapshot, not alias it.
    const live: ResolvedGate[] = [{ family: 'synthesis', gate: 'tests' }];
    const result = executeTransition(hsm, state, 'synthesizing', () => live);

    const entered = result.events.find((e) => e.type === 'phase.entered');
    const frozen = (entered?.metadata as Record<string, unknown>).resolvedGates;
    expect(frozen).toEqual([{ family: 'synthesis', gate: 'tests' }]);

    // Mutate the live policy source AFTER entry (push + in-place edit).
    live.push({ family: 'synthesis', gate: 'typecheck' });
    (live[0] as { gate: string }).gate = 'MUTATED';

    // The obligation frozen at entry is a value snapshot — untouched.
    expect(frozen).toEqual([{ family: 'synthesis', gate: 'tests' }]);
  });

  it('executeTransition_ImplementKind_FreezesEmptyResolvedGatesSequence', () => {
    // F3 (#1546): IMPLEMENT defers its per-task gate sequences to the wave
    // stamp. The phase.entered freeze records resolver/posture/mode but NO
    // phase-level sequence — an empty array, never the low-risk phase-default
    // ladder a replay consumer could mistake for the authoritative per-task set.
    const hsm = getHSMDefinition('oneshot');
    const state = { phase: 'plan', artifacts: { plan: 'docs/plan.md' }, _events: [] };
    const result = executeTransition(hsm, state, 'implementing');
    expect(result.success).toBe(true);

    const entered = result.events.filter((e) => e.type === 'phase.entered');
    expect(entered).toHaveLength(1);
    const md = entered[0].metadata as Record<string, unknown>;
    expect(md.kind).toBe('IMPLEMENT');
    // Deferred: no phase-level sequence frozen for IMPLEMENT.
    expect(md.resolvedGates).toEqual([]);
    // The transition-result return field agrees with the frozen event — no
    // surface divergence (both defer IMPLEMENT's per-task sequence).
    expect(result.resolvedGates).toEqual([]);
    // resolver / posture / mode ARE still frozen.
    expect(md.resolver).toBe(KIND_OBLIGATIONS.IMPLEMENT.gates?.resolver ?? null);
    expect(md.posture).toBe(KIND_OBLIGATIONS.IMPLEMENT.posture);
    expect(md.mode).toBe('enforce');
    // Still validates against the durable phase.entered schema.
    const schema = EVENT_DATA_SCHEMAS['phase.entered'];
    expect(schema?.safeParse(md).success).toBe(true);
  });

  it('executeTransition_PhaseAdvance_AppendsPhaseExitedWithGateStatus', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', artifacts: { sources: ['a.md'] }, _events: [] };
    const result = executeTransition(hsm, state, 'synthesizing');
    expect(result.success).toBe(true);

    // Advancing a phase appends exactly one phase.exited for the LEFT phase.
    const exited = result.events.filter((e) => e.type === 'phase.exited');
    expect(exited).toHaveLength(1);
    const md = exited[0].metadata as Record<string, unknown>;
    expect(md.phase).toBe('gathering');
    // A forward advance (not a fix-cycle) means the phase's required gates passed.
    expect(md.allRequiredGatesPassed).toBe(true);

    // Ordering: exit the old phase before entering the new one.
    const types = result.events.map((e) => e.type);
    expect(types.indexOf('phase.exited')).toBeLessThan(types.indexOf('phase.entered'));

    // The payload validates against the durable phase.exited schema.
    const schema = EVENT_DATA_SCHEMAS['phase.exited'];
    expect(schema?.safeParse(md).success).toBe(true);
  });

  it('executeTransition_FixCycle_PhaseExitedReportsGatesNotPassed', () => {
    // review → delegate is a fix-cycle (feature HSM): required gates did NOT
    // pass, so the phase loops back. phase.exited records that.
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

// ─── Feature workflow merge-pending substate (T17 / DR-MO-1, DR-MO-2) ───────

describe('Feature workflow merge-pending substate', () => {
  it('exposes EXCLUDED_MERGE_PHASES as a reusable constant', () => {
    // Sanity check: T19 will import this same constant.
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

  it('featureHsm_TaskCompletedWithoutWorktree_DoesNotTransitionToMergePending', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'delegate',
      _events: [
        {
          type: 'task.completed',
          data: {
            taskId: 'T01',
            // no worktree / worktreePath — task ran in-process
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

  it('featureHsm_MergeRecoveredEvent_LeavesMergePendingState', () => {
    // #1306 — merge.recovered (successor to merge.rollback) is a terminal exit
    // event for merge-pending during the dual-emit window. No terminal
    // mergeOrchestrator.phase is set, so this exercises the EVENT-recognition
    // path specifically (not the EXCLUDED_MERGE_PHASES fallback).
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

  it('featureHsm_TaskCompletedWithWorktree_DoesNotTransitionWhenMergeCompleted', () => {
    // Excluded phase guard: even with a worktree-bearing task.completed, do
    // not re-enter merge-pending if the merge already terminated.
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

// ─── Fix-cycle schema validity for non-compound children (#1339) ────────────

describe('Fix-cycle event schema validity (#1339)', () => {
  // Minimal HSM where the fix-cycle source state is a top-level atomic state
  // with no parent compound. getParentCompound() therefore returns undefined,
  // exercising the line 792 emission site that would otherwise produce
  // `metadata: { compoundStateId: undefined }`.
  function makeNonCompoundFixCycleHsm(): HSMDefinition {
    return {
      id: 'test-noncompound',
      states: {
        a: { id: 'a', type: 'atomic' },
        b: { id: 'b', type: 'atomic' },
      },
      transitions: [
        // No guard, marked as a fix cycle. `from` has no parent compound.
        { from: 'a', to: 'b', isFixCycle: true },
      ],
    };
  }

  it('ExecuteTransition_FixCycleOnNonCompoundChild_EmitsSchemaValidEvent', () => {
    const hsm = makeNonCompoundFixCycleHsm();
    const state = { phase: 'a', _events: [] };

    const result = executeTransition(hsm, state, 'b');
    expect(result.success).toBe(true);

    const fixCycleEvent = result.events.find((e) => e.type === 'fix-cycle');
    expect(fixCycleEvent).toBeDefined();

    // The persisted event `data` is the emitted metadata plus the count and
    // featureId folded in by the append path. Model that here and assert it
    // parses cleanly against the schema EVENT_DATA_SCHEMAS uses for this event.
    const schema = EVENT_DATA_SCHEMAS['workflow.fix-cycle'];
    expect(schema).toBeDefined();

    const data = {
      ...(fixCycleEvent!.metadata ?? {}),
      count: 1,
      featureId: 'feat-1339',
    };

    // RED today: metadata carries `compoundStateId: undefined`, which fails
    // the `z.string()` constraint on WorkflowFixCycleData.compoundStateId.
    const parsed = schema!.safeParse(data);
    expect(parsed.success).toBe(true);

    // The undefined key must not be emitted at all (no literal `undefined`).
    expect(
      Object.prototype.hasOwnProperty.call(
        fixCycleEvent!.metadata ?? {},
        'compoundStateId',
      ),
    ).toBe(false);
  });
});
