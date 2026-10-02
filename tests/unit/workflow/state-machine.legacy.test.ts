import { describe, it, expect, afterEach } from 'vitest';
import {
  getHSMDefinition,
  getInitialPhase,
  executeTransition,
  getValidTransitions,
  findTransition,
  registerWorkflowType,
  unregisterWorkflowType,
} from '../../../src/workflow/state-machine.js';
import type { HSMDefinition, State, Transition, WorkflowDefinition } from '../../../src/workflow/state-machine.js';
import { guards } from '../../../src/workflow/guards.js';

describe('HSM State Definitions', () => {
  describe('Feature Workflow HSM', () => {
    let hsm: HSMDefinition;

    it('should return HSM definition for feature workflow', () => {
      hsm = getHSMDefinition('feature');
      expect(hsm).toBeDefined();
      expect(hsm.id).toBe('feature');
    });

    it('FeatureHSM_AllStatesExist_CorrectTypes', () => {
      hsm = getHSMDefinition('feature');

      expect(hsm.states['ideate']).toBeUndefined();

      expect(hsm.states['plan']).toBeDefined();
      expect(hsm.states['plan'].type).toBe('atomic');

      expect(hsm.states['synthesize']).toBeDefined();
      expect(hsm.states['synthesize'].type).toBe('atomic');

      expect(hsm.states['completed']).toBeDefined();
      expect(hsm.states['completed'].type).toBe('final');

      expect(hsm.states['cancelled']).toBeDefined();
      expect(hsm.states['cancelled'].type).toBe('final');

      expect(hsm.states['blocked']).toBeDefined();
      expect(hsm.states['blocked'].type).toBe('atomic');

      expect(hsm.states['implementation']).toBeDefined();
      expect(hsm.states['implementation'].type).toBe('compound');
      expect(hsm.states['implementation'].initial).toBe('delegate');

      expect(hsm.states['delegate']).toBeDefined();
      expect(hsm.states['delegate'].type).toBe('atomic');
      expect(hsm.states['delegate'].parent).toBe('implementation');

      expect(hsm.states['review']).toBeDefined();
      expect(hsm.states['review'].type).toBe('atomic');
      expect(hsm.states['review'].parent).toBe('implementation');

      expect(hsm.states['integrate']).toBeUndefined();
    });

    it('FeatureHSM_ValidTransitions_MatchDesignDiagram', () => {
      hsm = getHSMDefinition('feature');
      const transitions = hsm.transitions;

      expect(transitions.find((t) => t.from === 'ideate')).toBeUndefined();

      const planToPlanReview = transitions.find(
        (t) => t.from === 'plan' && t.to === 'plan-review'
      );
      expect(planToPlanReview).toBeDefined();
      expect(planToPlanReview!.guard).toBeDefined();
      expect(planToPlanReview!.guard!.id).toBe('plan-artifact-exists');
      expect(planToPlanReview!.guard).toBeDefined();
      expect(planToPlanReview!.guard!.id).toBe('plan-artifact-exists');

      const planReviewToDelegate = transitions.find(
        (t) => t.from === 'plan-review' && t.to === 'delegate'
      );
      expect(planReviewToDelegate).toBeDefined();
      expect(planReviewToDelegate!.guard).toBeDefined();
      expect(planReviewToDelegate!.guard!.id).toBe('plan-review-complete');

      const delegateToReview = transitions.find(
        (t) => t.from === 'delegate' && t.to === 'review'
      );
      expect(delegateToReview).toBeDefined();
      expect(delegateToReview!.guard!.id).toBe('all-tasks-complete+team-disbanded');

      expect(transitions.find((t) => t.from === 'integrate')).toBeUndefined();
      expect(transitions.find((t) => t.to === 'integrate')).toBeUndefined();

      const reviewToSynthesize = transitions.find(
        (t) => t.from === 'review' && t.to === 'synthesize'
      );
      expect(reviewToSynthesize).toBeDefined();
      expect(reviewToSynthesize!.guard!.id).toBe('all-reviews-passed');

      const reviewToDelegate = transitions.find(
        (t) => t.from === 'review' && t.to === 'delegate'
      );
      expect(reviewToDelegate).toBeDefined();
      expect(reviewToDelegate!.guard!.id).toBe('any-review-failed');
      expect(reviewToDelegate!.isFixCycle).toBe(true);

      const synthesizeToCompleted = transitions.find(
        (t) => t.from === 'synthesize' && t.to === 'completed'
      );
      expect(synthesizeToCompleted).toBeDefined();
      expect(synthesizeToCompleted!.guard!.id).toBe('pr-url-exists');

      const blockedToDelegate = transitions.find(
        (t) => t.from === 'blocked' && t.to === 'delegate'
      );
      expect(blockedToDelegate).toBeDefined();
      expect(blockedToDelegate!.guard!.id).toBe('human-unblocked');
    });

    /** No state or transition uses `ideate`, and `plan` is the initial phase, with the `PLAN` kind. */
    it('FeatureHSM_NoIdeateState_PlanIsInitial', () => {
      const hsm = getHSMDefinition('feature');
      expect(hsm.states['ideate']).toBeUndefined();
      expect(hsm.transitions.some((t) => t.from === 'ideate' || t.to === 'ideate')).toBe(false);
      expect(getInitialPhase('feature')).toBe('plan');
      expect(hsm.states['plan']).toBeDefined();
      expect((hsm.states['plan'] as { kind?: string }).kind).toBe('PLAN');
    });

    /** `plan-review` is the only human approval gate. One transition, from `plan-review` to `delegate`, carries the `plan-review-complete` guard. */
    it('FeatureHSM_SingleApprovalPoint_PlanReviewOnly', () => {
      const hsm = getHSMDefinition('feature');
      const approvalEdges = hsm.transitions.filter(
        (t) => t.guard?.id === 'plan-review-complete',
      );
      expect(approvalEdges).toHaveLength(1);
      expect(approvalEdges[0].from).toBe('plan-review');
      expect(approvalEdges[0].to).toBe('delegate');
    });
  });

  describe('Debug Workflow HSM', () => {
    it('DebugHSM_AllStatesAndTransitions_MatchDesign', () => {
      const hsm = getHSMDefinition('debug');
      expect(hsm.id).toBe('debug');

      expect(hsm.states['triage']).toBeDefined();
      expect(hsm.states['triage'].type).toBe('atomic');

      expect(hsm.states['investigate']).toBeDefined();
      expect(hsm.states['investigate'].type).toBe('atomic');

      expect(hsm.states['synthesize']).toBeDefined();
      expect(hsm.states['synthesize'].type).toBe('atomic');

      expect(hsm.states['completed']).toBeDefined();
      expect(hsm.states['completed'].type).toBe('final');

      expect(hsm.states['cancelled']).toBeDefined();
      expect(hsm.states['cancelled'].type).toBe('final');

      expect(hsm.states['blocked']).toBeDefined();
      expect(hsm.states['blocked'].type).toBe('atomic');

      expect(hsm.states['thorough-track']).toBeDefined();
      expect(hsm.states['thorough-track'].type).toBe('compound');
      expect(hsm.states['thorough-track'].maxFixCycles).toBe(2);

      for (const child of [
        'rca',
        'design',
        'debug-implement',
        'debug-validate',
        'debug-review',
      ]) {
        expect(hsm.states[child]).toBeDefined();
        expect(hsm.states[child].parent).toBe('thorough-track');
      }

      expect(hsm.states['hotfix-track']).toBeDefined();
      expect(hsm.states['hotfix-track'].type).toBe('compound');

      for (const child of ['hotfix-implement', 'hotfix-validate']) {
        expect(hsm.states[child]).toBeDefined();
        expect(hsm.states[child].parent).toBe('hotfix-track');
      }

      const transitions = hsm.transitions;

      expect(
        transitions.find((t) => t.from === 'triage' && t.to === 'investigate')
      ).toBeDefined();

      expect(
        transitions.find((t) => t.from === 'investigate' && t.to === 'rca')
      ).toBeDefined();

      expect(
        transitions.find(
          (t) => t.from === 'investigate' && t.to === 'hotfix-implement'
        )
      ).toBeDefined();

      expect(
        transitions.find((t) => t.from === 'rca' && t.to === 'design')
      ).toBeDefined();

      expect(
        transitions.find(
          (t) => t.from === 'design' && t.to === 'debug-implement'
        )
      ).toBeDefined();

      expect(
        transitions.find(
          (t) => t.from === 'debug-implement' && t.to === 'debug-validate'
        )
      ).toBeDefined();

      expect(
        transitions.find(
          (t) => t.from === 'debug-validate' && t.to === 'debug-review'
        )
      ).toBeDefined();

      expect(
        transitions.find(
          (t) => t.from === 'debug-review' && t.to === 'synthesize'
        )
      ).toBeDefined();

      expect(
        transitions.find(
          (t) => t.from === 'hotfix-implement' && t.to === 'hotfix-validate'
        )
      ).toBeDefined();

      expect(
        transitions.find(
          (t) => t.from === 'hotfix-validate' && t.to === 'completed'
        )
      ).toBeDefined();

      expect(
        transitions.find(
          (t) => t.from === 'synthesize' && t.to === 'completed'
        )
      ).toBeDefined();
    });
  });

  describe('Refactor Workflow HSM', () => {
    it('RefactorHSM_AllStatesAndTransitions_MatchDesign', () => {
      const hsm = getHSMDefinition('refactor');
      expect(hsm.id).toBe('refactor');

      expect(hsm.states['explore']).toBeDefined();
      expect(hsm.states['explore'].type).toBe('atomic');

      expect(hsm.states['brief']).toBeDefined();
      expect(hsm.states['brief'].type).toBe('atomic');

      expect(hsm.states['synthesize']).toBeDefined();
      expect(hsm.states['synthesize'].type).toBe('atomic');

      expect(hsm.states['completed']).toBeDefined();
      expect(hsm.states['completed'].type).toBe('final');

      expect(hsm.states['cancelled']).toBeDefined();
      expect(hsm.states['cancelled'].type).toBe('final');

      expect(hsm.states['blocked']).toBeDefined();
      expect(hsm.states['blocked'].type).toBe('atomic');

      expect(hsm.states['polish-track']).toBeDefined();
      expect(hsm.states['polish-track'].type).toBe('compound');

      for (const child of [
        'polish-implement',
        'polish-validate',
        'polish-update-docs',
      ]) {
        expect(hsm.states[child]).toBeDefined();
        expect(hsm.states[child].parent).toBe('polish-track');
      }

      expect(hsm.states['overhaul-track']).toBeDefined();
      expect(hsm.states['overhaul-track'].type).toBe('compound');
      expect(hsm.states['overhaul-track'].maxFixCycles).toBe(3);

      for (const child of [
        'overhaul-plan',
        'overhaul-plan-review',
        'overhaul-delegate',
        'overhaul-review',
        'overhaul-update-docs',
      ]) {
        expect(hsm.states[child]).toBeDefined();
        expect(hsm.states[child].parent).toBe('overhaul-track');
      }

      expect(hsm.states['overhaul-integrate']).toBeUndefined();

      const transitions = hsm.transitions;

      expect(
        transitions.find((t) => t.from === 'explore' && t.to === 'brief')
      ).toBeDefined();

      expect(
        transitions.find(
          (t) => t.from === 'brief' && t.to === 'polish-implement'
        )
      ).toBeDefined();

      expect(
        transitions.find(
          (t) => t.from === 'brief' && t.to === 'overhaul-plan'
        )
      ).toBeDefined();

      expect(
        transitions.find(
          (t) =>
            t.from === 'polish-implement' && t.to === 'polish-validate'
        )
      ).toBeDefined();
      expect(
        transitions.find(
          (t) =>
            t.from === 'polish-validate' && t.to === 'polish-update-docs'
        )
      ).toBeDefined();
      expect(
        transitions.find(
          (t) => t.from === 'polish-update-docs' && t.to === 'completed'
        )
      ).toBeDefined();

      expect(
        transitions.find(
          (t) => t.from === 'overhaul-plan' && t.to === 'overhaul-plan-review'
        )
      ).toBeDefined();
      expect(
        transitions.find(
          (t) => t.from === 'overhaul-plan-review' && t.to === 'overhaul-delegate'
        )
      ).toBeDefined();
      expect(
        transitions.find(
          (t) =>
            t.from === 'overhaul-delegate' && t.to === 'overhaul-review'
        )
      ).toBeDefined();
      expect(
        transitions.find(
          (t) =>
            t.from === 'overhaul-review' && t.to === 'overhaul-update-docs'
        )
      ).toBeDefined();
      expect(
        transitions.find(
          (t) =>
            t.from === 'overhaul-update-docs' && t.to === 'synthesize'
        )
      ).toBeDefined();

      expect(transitions.find((t) => t.from === 'overhaul-integrate')).toBeUndefined();
      expect(transitions.find((t) => t.to === 'overhaul-integrate')).toBeUndefined();

      const reviewToDelegate = transitions.find(
        (t) => t.from === 'overhaul-review' && t.to === 'overhaul-delegate'
      );
      expect(reviewToDelegate).toBeDefined();
      expect(reviewToDelegate!.isFixCycle).toBe(true);

      expect(
        transitions.find(
          (t) => t.from === 'blocked' && t.to === 'overhaul-delegate'
        )
      ).toBeDefined();

      expect(
        transitions.find(
          (t) => t.from === 'synthesize' && t.to === 'completed'
        )
      ).toBeDefined();
    });
  });

  describe('Compound States', () => {
    it('CompoundStates_HaveEntryExitEffects_AndMaxFixCycles', () => {
      const feature = getHSMDefinition('feature');
      const implementation = feature.states['implementation'];
      expect(implementation.type).toBe('compound');
      expect(implementation.maxFixCycles).toBe(3);
      expect(implementation.onEntry).toBeDefined();
      expect(implementation.onEntry).toContain('log');
      expect(implementation.onExit).toBeDefined();
      expect(implementation.onExit).toContain('log');

      const debug = getHSMDefinition('debug');
      const thoroughTrack = debug.states['thorough-track'];
      expect(thoroughTrack.type).toBe('compound');
      expect(thoroughTrack.maxFixCycles).toBe(2);
      expect(thoroughTrack.onEntry).toBeDefined();
      expect(thoroughTrack.onEntry).toContain('log');
      expect(thoroughTrack.onExit).toBeDefined();
      expect(thoroughTrack.onExit).toContain('log');

      const hotfixTrack = debug.states['hotfix-track'];
      expect(hotfixTrack.type).toBe('compound');
      expect(hotfixTrack.onEntry).toBeDefined();
      expect(hotfixTrack.onExit).toBeDefined();

      const refactor = getHSMDefinition('refactor');
      const polishTrack = refactor.states['polish-track'];
      expect(polishTrack.type).toBe('compound');
      expect(polishTrack.onEntry).toBeDefined();
      expect(polishTrack.onExit).toBeDefined();

      const overhaulTrack = refactor.states['overhaul-track'];
      expect(overhaulTrack.type).toBe('compound');
      expect(overhaulTrack.maxFixCycles).toBe(3);
      expect(overhaulTrack.onEntry).toBeDefined();
      expect(overhaulTrack.onEntry).toContain('log');
      expect(overhaulTrack.onExit).toBeDefined();
      expect(overhaulTrack.onExit).toContain('log');
    });
  });

  describe('getHSMDefinition', () => {
    it('throws for unknown workflow type', () => {
      expect(() => getHSMDefinition('unknown')).toThrow();
    });
  });
});

describe('HSM Transition Algorithm', () => {
  describe('executeTransition', () => {
    it('ExecuteTransition_ValidTransition_ReturnsSuccess', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'plan',
        artifacts: { design: null, plan: 'docs/specs/x.md', pr: null },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'plan-review');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('plan-review');
      expect(result.idempotent).toBe(false);
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.events[0].type).toBe('transition');
    });

    it('ExecuteTransition_IdempotentSamePhase_ReturnsNoOp', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'plan',
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'plan');

      expect(result.success).toBe(true);
      expect(result.idempotent).toBe(true);
      expect(result.effects).toEqual([]);
      expect(result.events).toEqual([]);
    });

    /** The valid targets carry guard metadata. From `plan`, the `plan-review` target carries the `plan-artifact-exists` guard. */
    it('ExecuteTransition_InvalidTarget_ReturnsInvalidTransition', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'plan',
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'completed');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('INVALID_TRANSITION');
      expect(result.validTargets).toBeDefined();
      expect(result.validTargets!.length).toBeGreaterThan(0);

      const planReviewTarget = result.validTargets!.find((t) => t.phase === 'plan-review');
      expect(planReviewTarget).toBeDefined();
      expect(planReviewTarget!.guard).toBeDefined();
      expect(planReviewTarget!.guard!.id).toBe('plan-artifact-exists');
      expect(planReviewTarget!.guard!.description).toBe('Plan artifact must exist');
    });

    it('ExecuteTransition_GuardFails_ReturnsGuardFailed', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'plan',
        artifacts: { design: null, plan: null, pr: null },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'plan-review');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
      expect(result.guardDescription).toBeDefined();
    });

    it('ExecuteTransition_CompoundEntry_FiresOnEntryEffects', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'plan-review',
        planReview: { approved: true },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'delegate');

      expect(result.success).toBe(true);
      expect(result.effects).toContain('log');
    });

    it('ExecuteTransition_CompoundExit_FiresOnExitEffects', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'review',
        reviews: { spec: { passed: true }, quality: { passed: true } },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'synthesize');

      expect(result.success).toBe(true);
      expect(result.effects).toContain('log');
    });

    it('ExecuteTransition_HistoryUpdate_RecordsLastSubState', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'review',
        reviews: { spec: { passed: true }, quality: { passed: true } },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'synthesize');

      expect(result.success).toBe(true);
      expect(result.historyUpdates).toBeDefined();
      expect(result.historyUpdates!['implementation']).toBe('review');
    });

    it('ExecuteTransition_CancelFromAnyNonFinal_Succeeds', () => {
      const hsm = getHSMDefinition('feature');

      const nonFinalPhases = [
        'plan',
        'delegate',
        'review',
        'synthesize',
        'blocked',
      ];

      for (const phase of nonFinalPhases) {
        const state: Record<string, unknown> = {
          phase,
          _events: [],
          _history: {},
        };

        const result = executeTransition(hsm, state, 'cancelled');

        expect(result.success).toBe(true);
        expect(result.newPhase).toBe('cancelled');
      }
    });

    it('ExecuteTransition_FixCycleEvent_WritesCompoundStateIdMetadata (Bug 6)', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'review',
        reviews: { spec: { status: 'fail' } },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'delegate');

      expect(result.success).toBe(true);
      const fixCycleEvent = result.events.find((e) => e.type === 'fix-cycle');
      expect(fixCycleEvent).toBeDefined();
      expect(fixCycleEvent!.metadata).toBeDefined();
      expect(fixCycleEvent!.metadata!.compoundStateId).toBe('implementation');
      expect(fixCycleEvent!.metadata!.compound).toBeUndefined();
    });

    it('ExecuteTransition_CompoundEntry_WritesCompoundStateIdMetadata (Bug 6)', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'plan-review',
        planReview: { approved: true },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'delegate');

      expect(result.success).toBe(true);
      const compoundEntryEvent = result.events.find((e) => e.type === 'compound-entry');
      expect(compoundEntryEvent).toBeDefined();
      expect(compoundEntryEvent!.metadata).toBeDefined();
      expect(compoundEntryEvent!.metadata!.compoundStateId).toBe('implementation');
    });

    it('ExecuteTransition_CircuitBreaker_ReturnsCircuitOpen', () => {
      const hsm = getHSMDefinition('feature');

      const fixCycleEvents = Array.from({ length: 3 }, (_, i) => ({
        sequence: i + 1,
        version: '1.0' as const,
        timestamp: new Date().toISOString(),
        type: 'fix-cycle' as const,
        from: 'review',
        to: 'delegate',
        trigger: 'test',
        metadata: { compoundStateId: 'implementation' },
      }));

      const state: Record<string, unknown> = {
        phase: 'review',
        reviews: { spec: { status: 'fail' } },
        _events: fixCycleEvents,
        _history: {},
      };

      const result = executeTransition(hsm, state, 'delegate');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('CIRCUIT_OPEN');
    });

    /** An array-like `tasks` object is not an array, so the `allTasksComplete` guard fails. The transition returns GUARD_FAILED and does not throw. */
    it('ExecuteTransition_GuardThrows_ReturnsGuardFailed (Bug 7)', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'delegate',
        tasks: { length: 1, 0: { status: 'pending' } },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'review');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
      expect(result.errorMessage).toContain('Guard');
    });
  });

  describe('getValidTransitions', () => {
    const phases = (targets: readonly { phase: string }[]) => targets.map((t) => t.phase);

    it('returns valid target phases from a given phase', () => {
      const hsm = getHSMDefinition('feature');
      const targets = getValidTransitions(hsm, 'plan');

      expect(phases(targets)).toContain('plan-review');
      expect(phases(targets)).toContain('cancelled');
    });

    it('returns empty array for final states', () => {
      const hsm = getHSMDefinition('feature');
      const targets = getValidTransitions(hsm, 'completed');

      expect(targets).toEqual([]);
    });

    it('returns valid transitions for compound state children', () => {
      const hsm = getHSMDefinition('feature');

      const delegateTargets = getValidTransitions(hsm, 'delegate');
      expect(phases(delegateTargets)).toContain('review');
      expect(phases(delegateTargets)).toContain('cancelled');
      expect(phases(delegateTargets)).not.toContain('integrate');

      const reviewTargets = getValidTransitions(hsm, 'review');
      expect(phases(reviewTargets)).toContain('synthesize');
      expect(phases(reviewTargets)).toContain('delegate');
      expect(phases(reviewTargets)).toContain('cancelled');
    });

    it('returns valid transitions for debug HSM phases', () => {
      const hsm = getHSMDefinition('debug');

      const triageTargets = getValidTransitions(hsm, 'triage');
      expect(phases(triageTargets)).toContain('investigate');
      expect(phases(triageTargets)).toContain('cancelled');

      const investigateTargets = getValidTransitions(hsm, 'investigate');
      expect(phases(investigateTargets)).toContain('rca');
      expect(phases(investigateTargets)).toContain('hotfix-implement');
      expect(phases(investigateTargets)).toContain('cancelled');

      const rcaTargets = getValidTransitions(hsm, 'rca');
      expect(phases(rcaTargets)).toContain('design');
      expect(phases(rcaTargets)).toContain('cancelled');
    });

    it('returns valid transitions for refactor HSM phases', () => {
      const hsm = getHSMDefinition('refactor');

      const exploreTargets = getValidTransitions(hsm, 'explore');
      expect(phases(exploreTargets)).toContain('brief');
      expect(phases(exploreTargets)).toContain('cancelled');

      const briefTargets = getValidTransitions(hsm, 'brief');
      expect(phases(briefTargets)).toContain('polish-implement');
      expect(phases(briefTargets)).toContain('overhaul-plan');
      expect(phases(briefTargets)).toContain('cancelled');
    });

    it('returns empty array for cancelled (final) state', () => {
      const hsm = getHSMDefinition('feature');
      const targets = getValidTransitions(hsm, 'cancelled');
      expect(targets).toEqual([]);
    });
  });
});

describe('Debug HSM executeTransition', () => {
  describe('investigate to thorough track', () => {
    it('transitions from investigate to rca when thorough track selected', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'investigate',
        track: 'thorough',
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'rca');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('rca');
      expect(result.idempotent).toBe(false);
      const compoundEntry = result.events.find(
        (e) => e.type === 'compound-entry'
      );
      expect(compoundEntry).toBeDefined();
      expect(compoundEntry!.metadata!.compoundStateId).toBe('thorough-track');
      expect(result.effects).toContain('log');
    });

    it('fails to transition from investigate to rca when hotfix track selected', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'investigate',
        track: 'hotfix',
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'rca');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });
  });

  describe('investigate to hotfix track', () => {
    it('transitions from investigate to hotfix-implement when hotfix track selected', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'investigate',
        track: 'hotfix',
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'hotfix-implement');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('hotfix-implement');
      const compoundEntry = result.events.find(
        (e) => e.type === 'compound-entry'
      );
      expect(compoundEntry).toBeDefined();
      expect(compoundEntry!.metadata!.compoundStateId).toBe('hotfix-track');
      expect(result.effects).toContain('log');
    });

    it('fails to transition from investigate to hotfix-implement when thorough track selected', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'investigate',
        track: 'thorough',
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'hotfix-implement');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });
  });

  describe('full thorough track flow', () => {
    it('completes rca to design transition', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'rca',
        track: 'thorough',
        artifacts: { rca: 'docs/rca.md' },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'design');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('design');
      const compoundEntry = result.events.find(
        (e) => e.type === 'compound-entry'
      );
      expect(compoundEntry).toBeUndefined();
    });

    it('fails rca to design when rca artifact missing', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'rca',
        track: 'thorough',
        artifacts: {},
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'design');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });

    it('completes design to debug-implement transition', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'design',
        track: 'thorough',
        artifacts: { fixDesign: 'docs/fix.md' },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'debug-implement');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('debug-implement');
    });

    it('fails design to debug-implement when fixDesign artifact missing', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'design',
        track: 'thorough',
        artifacts: {},
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'debug-implement');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });

    it('completes debug-implement to debug-validate transition', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'debug-implement',
        track: 'thorough',
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'debug-validate');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('debug-validate');
    });

    it('completes debug-validate to debug-review transition', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'debug-validate',
        track: 'thorough',
        validation: { testsPass: true },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'debug-review');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('debug-review');
    });

    it('fails debug-validate to debug-review when validation fails', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'debug-validate',
        track: 'thorough',
        validation: { testsPass: false },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'debug-review');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });

    it('completes debug-review to synthesize transition (exits thorough-track compound)', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'debug-review',
        track: 'thorough',
        reviews: { spec: { passed: true } },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'synthesize');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('synthesize');
      const compoundExit = result.events.find(
        (e) => e.type === 'compound-exit'
      );
      expect(compoundExit).toBeDefined();
      expect(compoundExit!.from).toBe('thorough-track');
      expect(result.effects).toContain('log');
      expect(result.historyUpdates).toBeDefined();
      expect(result.historyUpdates!['thorough-track']).toBe('debug-review');
    });

    it('fails debug-review to synthesize when review fails', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'debug-review',
        track: 'thorough',
        reviews: { spec: { passed: false } },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'synthesize');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });

    it('completes synthesize to completed in debug workflow', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'synthesize',
        synthesis: { prUrl: 'https://github.com/org/repo/pull/1' },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'completed');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('completed');
    });
  });

  describe('full hotfix track flow', () => {
    it('completes hotfix-implement to hotfix-validate transition', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'hotfix-implement',
        track: 'hotfix',
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'hotfix-validate');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('hotfix-validate');
    });

    it('completes hotfix-validate to completed (exits hotfix-track compound)', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'hotfix-validate',
        track: 'hotfix',
        validation: { testsPass: true },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'completed');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('completed');
      const compoundExit = result.events.find(
        (e) => e.type === 'compound-exit'
      );
      expect(compoundExit).toBeDefined();
      expect(compoundExit!.from).toBe('hotfix-track');
      expect(result.effects).toContain('log');
      expect(result.historyUpdates).toBeDefined();
      expect(result.historyUpdates!['hotfix-track']).toBe('hotfix-validate');
    });

    it('fails hotfix-validate to completed when validation fails', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'hotfix-validate',
        track: 'hotfix',
        validation: { testsPass: false },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'completed');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });
  });

  describe('triage to investigate', () => {
    it('transitions from triage to investigate when triage complete', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'triage',
        triage: { symptom: 'error on startup' },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'investigate');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('investigate');
    });

    it('fails triage to investigate when triage incomplete', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'triage',
        triage: {},
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'investigate');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });
  });

  describe('cancel from debug phases', () => {
    it('cancels from within thorough-track compound with history', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'rca',
        track: 'thorough',
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'cancelled');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('cancelled');
      expect(result.historyUpdates).toBeDefined();
      expect(result.historyUpdates!['thorough-track']).toBe('rca');
    });

    it('cancels from within hotfix-track compound with history', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'hotfix-implement',
        track: 'hotfix',
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'cancelled');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('cancelled');
      expect(result.historyUpdates).toBeDefined();
      expect(result.historyUpdates!['hotfix-track']).toBe('hotfix-implement');
    });
  });
});

describe('Refactor HSM executeTransition', () => {
  describe('brief to polish track', () => {
    it('transitions from brief to polish-implement when polish track selected', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'brief',
        track: 'polish',
        brief: { goals: ['g1'] },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'polish-implement');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('polish-implement');
      const compoundEntry = result.events.find(
        (e) => e.type === 'compound-entry'
      );
      expect(compoundEntry).toBeDefined();
      expect(compoundEntry!.metadata!.compoundStateId).toBe('polish-track');
      expect(result.effects).toContain('log');
    });

    it('fails brief to polish-implement when overhaul track selected', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'brief',
        track: 'overhaul',
        brief: { goals: ['g1'] },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'polish-implement');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });
  });

  describe('brief to overhaul track', () => {
    it('transitions from brief to overhaul-plan when overhaul track selected', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'brief',
        track: 'overhaul',
        brief: { goals: ['g1'] },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'overhaul-plan');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('overhaul-plan');
      const compoundEntry = result.events.find(
        (e) => e.type === 'compound-entry'
      );
      expect(compoundEntry).toBeDefined();
      expect(compoundEntry!.metadata!.compoundStateId).toBe('overhaul-track');
      expect(result.effects).toContain('log');
    });

    it('fails brief to overhaul-plan when polish track selected', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'brief',
        track: 'polish',
        brief: { goals: ['g1'] },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'overhaul-plan');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });
  });

  describe('explore to brief', () => {
    it('transitions from explore to brief when scope assessment complete', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'explore',
        explore: { scopeAssessment: 'small' },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'brief');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('brief');
    });

    it('fails explore to brief when scope assessment missing', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'explore',
        explore: {},
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'brief');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });
  });

  describe('full polish track flow', () => {
    it('completes polish-implement to polish-validate transition', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'polish-implement',
        track: 'polish',
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'polish-validate');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('polish-validate');
    });

    it('completes polish-validate to polish-update-docs transition', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'polish-validate',
        track: 'polish',
        validation: { testsPass: true },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'polish-update-docs');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('polish-update-docs');
    });

    it('fails polish-validate to polish-update-docs when goals not verified', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'polish-validate',
        track: 'polish',
        validation: { testsPass: false },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'polish-update-docs');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });

    it('completes polish-update-docs to completed (exits polish-track compound)', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'polish-update-docs',
        track: 'polish',
        validation: { docsUpdated: true },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'completed');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('completed');
      const compoundExit = result.events.find(
        (e) => e.type === 'compound-exit'
      );
      expect(compoundExit).toBeDefined();
      expect(compoundExit!.from).toBe('polish-track');
      expect(result.effects).toContain('log');
      expect(result.historyUpdates).toBeDefined();
      expect(result.historyUpdates!['polish-track']).toBe('polish-update-docs');
    });

    it('fails polish-update-docs to completed when docs not updated', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'polish-update-docs',
        track: 'polish',
        validation: {},
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'completed');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });
  });

  describe('overhaul track flow', () => {
    it('completes overhaul-plan to overhaul-plan-review transition', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'overhaul-plan',
        track: 'overhaul',
        artifacts: { plan: 'docs/plan.md' },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'overhaul-plan-review');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('overhaul-plan-review');
    });

    it('completes overhaul-plan-review to overhaul-delegate transition', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'overhaul-plan-review',
        track: 'overhaul',
        planReview: { approved: true },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'overhaul-delegate');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('overhaul-delegate');
    });

    it('completes blocked to overhaul-delegate recovery transition', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'blocked',
        track: 'overhaul',
        unblocked: true,
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'overhaul-delegate');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('overhaul-delegate');
    });

    it('completes overhaul-delegate to overhaul-review transition', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'overhaul-delegate',
        track: 'overhaul',
        tasks: [{ status: 'complete' }, { status: 'complete' }],
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'overhaul-review');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('overhaul-review');
    });

    it('fails overhaul-delegate to overhaul-review when tasks incomplete', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'overhaul-delegate',
        track: 'overhaul',
        tasks: [{ status: 'complete' }, { status: 'pending' }],
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'overhaul-review');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });

    it('completes overhaul-review to overhaul-update-docs on review pass', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'overhaul-review',
        track: 'overhaul',
        reviews: { spec: { passed: true }, quality: { passed: true } },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'overhaul-update-docs');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('overhaul-update-docs');
    });

    it('cycles overhaul-review to overhaul-delegate on review fail (fix cycle)', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'overhaul-review',
        track: 'overhaul',
        reviews: { spec: { passed: true }, quality: { passed: false } },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'overhaul-delegate');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('overhaul-delegate');
      expect(result.effects).toContain('increment-fix-cycle');
      const fixCycleEvent = result.events.find((e) => e.type === 'fix-cycle');
      expect(fixCycleEvent).toBeDefined();
      expect(fixCycleEvent!.metadata!.compoundStateId).toBe('overhaul-track');
    });

    it('completes overhaul-update-docs to synthesize transition', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'overhaul-update-docs',
        track: 'overhaul',
        validation: { docsUpdated: true },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'synthesize');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('synthesize');
      const compoundExit = result.events.find(
        (e) => e.type === 'compound-exit'
      );
      expect(compoundExit).toBeDefined();
      expect(compoundExit!.from).toBe('overhaul-track');
      expect(result.effects).toContain('log');
      expect(result.historyUpdates).toBeDefined();
      expect(result.historyUpdates!['overhaul-track']).toBe(
        'overhaul-update-docs'
      );
    });

    it('completes synthesize to completed in refactor workflow', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'synthesize',
        artifacts: { pr: 'https://github.com/org/repo/pull/1' },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'completed');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('completed');
    });

    it('circuit breaker triggers in overhaul-track after max fix cycles', () => {
      const hsm = getHSMDefinition('refactor');

      const fixCycleEvents = Array.from({ length: 3 }, (_, i) => ({
        sequence: i + 1,
        version: '1.0' as const,
        timestamp: new Date().toISOString(),
        type: 'fix-cycle' as const,
        from: 'overhaul-review',
        to: 'overhaul-delegate',
        trigger: 'test',
        metadata: { compoundStateId: 'overhaul-track' },
      }));

      const state: Record<string, unknown> = {
        phase: 'overhaul-review',
        track: 'overhaul',
        reviews: { spec: { status: 'fail' } },
        _events: fixCycleEvents,
        _history: {},
      };

      const result = executeTransition(hsm, state, 'overhaul-delegate');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('CIRCUIT_OPEN');
      expect(result.errorMessage).toContain('overhaul-track');
    });
  });

  describe('cancel from refactor phases', () => {
    it('cancels from within polish-track compound with history', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'polish-validate',
        track: 'polish',
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'cancelled');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('cancelled');
      expect(result.historyUpdates).toBeDefined();
      expect(result.historyUpdates!['polish-track']).toBe('polish-validate');
    });

    it('cancels from within overhaul-track compound with history', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'overhaul-delegate',
        track: 'overhaul',
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'cancelled');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('cancelled');
      expect(result.historyUpdates).toBeDefined();
      expect(result.historyUpdates!['overhaul-track']).toBe(
        'overhaul-delegate'
      );
    });
  });
});

describe('Feature HSM plan-review transitions', () => {
  it('transitions plan-review back to plan when gaps found', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'plan-review',
      planReview: { gapsFound: true },
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'plan');

    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('plan');
    expect(result.effects).toContain('log');
  });

  it('fails plan-review to plan when no gaps found', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'plan-review',
      planReview: { gapsFound: false },
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'plan');

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('GUARD_FAILED');
  });
});

describe('Final state transitions', () => {
  it('returns INVALID_TRANSITION when transitioning from completed state', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'completed',
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'plan');

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_TRANSITION');
    expect(result.errorMessage).toContain('final state');
    expect(result.validTargets).toEqual([]);
  });

  it('returns INVALID_TRANSITION when transitioning from cancelled state', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'cancelled',
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'plan');

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_TRANSITION');
    expect(result.errorMessage).toContain('final state');
  });

  it('returns INVALID_TRANSITION from debug completed state', () => {
    const hsm = getHSMDefinition('debug');
    const state: Record<string, unknown> = {
      phase: 'completed',
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'triage');

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_TRANSITION');
  });

  it('returns INVALID_TRANSITION from refactor completed state', () => {
    const hsm = getHSMDefinition('refactor');
    const state: Record<string, unknown> = {
      phase: 'completed',
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'explore');

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_TRANSITION');
  });
});

describe('getValidTransitions guard metadata', () => {
  it('returns guard id and description for guarded transitions', () => {
    const hsm = getHSMDefinition('feature');
    const targets = getValidTransitions(hsm, 'plan');

    const planReviewTarget = targets.find((t) => t.phase === 'plan-review');
    expect(planReviewTarget).toBeDefined();
    expect(planReviewTarget!.guard).toEqual({
      id: 'plan-artifact-exists',
      description: 'Plan artifact must exist',
    });
  });

  it('omits guard for unguarded transitions (cancelled)', () => {
    const hsm = getHSMDefinition('feature');
    const targets = getValidTransitions(hsm, 'plan');

    const cancelTarget = targets.find((t) => t.phase === 'cancelled');
    expect(cancelTarget).toBeDefined();
    expect(cancelTarget!.guard).toBeUndefined();
  });

  it('includes merge-verified guard for universal completed transition', () => {
    const hsm = getHSMDefinition('feature');
    const targets = getValidTransitions(hsm, 'plan');

    const completedTarget = targets.find((t) => t.phase === 'completed');
    expect(completedTarget).toBeDefined();
    expect(completedTarget!.guard).toEqual({
      id: 'merge-verified',
      description: 'Merge must be verified by the orchestrator before cleanup',
    });
    expect(completedTarget!.universal).toBe(true);
  });

  it('returns empty array for final states', () => {
    const hsm = getHSMDefinition('feature');
    expect(getValidTransitions(hsm, 'completed')).toEqual([]);
    expect(getValidTransitions(hsm, 'cancelled')).toEqual([]);
  });

  it('returns guards for refactor polish track transitions', () => {
    const hsm = getHSMDefinition('refactor');
    const targets = getValidTransitions(hsm, 'polish-validate');

    const docsTarget = targets.find((t) => t.phase === 'polish-update-docs');
    expect(docsTarget).toBeDefined();
    expect(docsTarget!.guard!.id).toBe('goals-verified');
  });
});

describe('Guard edge cases', () => {
  it('prUrlExists guard checks synthesis.prUrl', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'synthesize',
      synthesis: { prUrl: 'https://github.com/org/repo/pull/1' },
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'completed');
    expect(result.success).toBe(true);
  });

  it('prUrlExists guard checks artifacts.pr as fallback', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'synthesize',
      artifacts: { pr: 'https://github.com/org/repo/pull/1' },
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'completed');
    expect(result.success).toBe(true);
  });

  it('allReviewsPassed returns false when no reviews', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'review',
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'synthesize');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('GUARD_FAILED');
  });

  it('allReviewsPassed returns false when reviews is empty object', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'review',
      reviews: {},
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'synthesize');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('GUARD_FAILED');
  });

  it('allTasksComplete returns true when tasks array is empty', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'delegate',
      tasks: [],
      _events: [{ type: 'team.disbanded' }],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'review');
    expect(result.success).toBe(true);
  });

  it('allTasksComplete returns true when tasks is undefined', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'delegate',
      _events: [{ type: 'team.disbanded' }],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'review');
    expect(result.success).toBe(true);
  });

  it('anyReviewFailed returns false when no reviews', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'review',
      _events: [],
      _history: {},
    };

    const toSynthesize = executeTransition(hsm, state, 'synthesize');
    expect(toSynthesize.success).toBe(false);

    const toDelegate = executeTransition(hsm, state, 'delegate');
    expect(toDelegate.success).toBe(false);
  });

  it('allReviewsPassed accepts status: "approved" format', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'review',
      reviews: {
        quality: { status: 'approved', highPriority: [], mediumPriority: [] },
      },
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'synthesize');
    expect(result.success).toBe(true);
  });

  it('allReviewsPassed accepts status: "pass" format', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'review',
      reviews: {
        spec: { status: 'pass', issues: [] },
      },
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'synthesize');
    expect(result.success).toBe(true);
  });

  it('allReviewsPassed accepts nested per-task review format', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'review',
      reviews: {
        A1: {
          specReview: { status: 'pass', issues: [] },
          qualityReview: { status: 'approved', highPriority: [] },
        },
        A2: {
          specReview: { status: 'pass', issues: [] },
          qualityReview: { status: 'approved' },
        },
      },
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'synthesize');
    expect(result.success).toBe(true);
  });

  it('anyReviewFailed detects status: "needs_fixes"', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'review',
      reviews: {
        quality: { status: 'needs_fixes', issues: ['H1: missing field'] },
      },
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'delegate');
    expect(result.success).toBe(true);
  });

  it('anyReviewFailed detects status: "fail"', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'review',
      reviews: {
        spec: { status: 'fail', issues: ['missing tests'] },
      },
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'delegate');
    expect(result.success).toBe(true);
  });

  it('allReviewsPassed fails with nested needs_fixes and reports diagnostic', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'review',
      reviews: {
        A1: {
          specReview: { status: 'pass' },
          qualityReview: { status: 'needs_fixes', issues: ['H1'] },
        },
      },
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'synthesize');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('GUARD_FAILED');
    expect(result.errorMessage).toContain('A1.qualityReview');
    expect(result.errorMessage).toContain('needs_fixes');
  });

  it('allReviewsPassed includes diagnostic reason when reviews missing', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'review',
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'synthesize');
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('state.reviews is missing');
  });

  it('allReviewsPassed includes diagnostic reason when reviews is empty', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'review',
      reviews: {},
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'synthesize');
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('no recognizable review entries');
  });

  it('humanUnblocked guard passes when unblocked is true', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'blocked',
      unblocked: true,
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'delegate');
    expect(result.success).toBe(true);
  });

  it('humanUnblocked guard fails when unblocked is false', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'blocked',
      unblocked: false,
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'delegate');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('GUARD_FAILED');
  });

  /** Only two of the three fix-cycle events name `implementation`, which allows three cycles, so the transition succeeds. */
  it('countFixCycles counts only matching compound events', () => {
    const hsm = getHSMDefinition('feature');

    const mixedEvents = [
      {
        type: 'fix-cycle',
        metadata: { compoundStateId: 'implementation' },
      },
      {
        type: 'fix-cycle',
        metadata: { compoundStateId: 'other-compound' },
      },
      {
        type: 'fix-cycle',
        metadata: { compoundStateId: 'implementation' },
      },
      {
        type: 'transition',
        metadata: {},
      },
    ];

    const state: Record<string, unknown> = {
      phase: 'review',
      reviews: { spec: { status: 'fail' } },
      _events: mixedEvents,
      _history: {},
    };

    const result = executeTransition(hsm, state, 'delegate');
    expect(result.success).toBe(true);
  });

  /** Three fix-cycle events for `implementation` reach its limit of three cycles. */
  it('countFixCycles triggers circuit breaker at exact limit', () => {
    const hsm = getHSMDefinition('feature');

    const events = Array.from({ length: 3 }, () => ({
      type: 'fix-cycle',
      metadata: { compoundStateId: 'implementation' },
    }));

    const state: Record<string, unknown> = {
      phase: 'review',
      reviews: { spec: { status: 'fail' } },
      _events: events,
      _history: {},
    };

    const result = executeTransition(hsm, state, 'delegate');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CIRCUIT_OPEN');
  });
});

describe('Diagnostic Event Emission', () => {
  describe('guard-failed events', () => {
    it('should return guard-failed event when guard returns false', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'plan',
        artifacts: { design: null, plan: null, pr: null },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'plan-review');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
      expect(result.events.length).toBe(1);
      expect(result.events[0].type).toBe('guard-failed');
      expect(result.events[0].from).toBe('plan');
      expect(result.events[0].to).toBe('plan-review');
      expect(result.events[0].metadata).toBeDefined();
      expect(result.events[0].metadata!.guard).toBe('plan-artifact-exists');
    });

    it('should return guard-failed event when guard throws exception', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'delegate',
        tasks: { length: 1, 0: { status: 'pending' } },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'review');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
      expect(result.events.length).toBe(1);
      expect(result.events[0].type).toBe('guard-failed');
      expect(result.events[0].from).toBe('delegate');
      expect(result.events[0].to).toBe('review');
      expect(result.events[0].metadata).toBeDefined();
      expect(result.events[0].metadata!.guard).toBe('all-tasks-complete+team-disbanded');
    });
  });

  describe('circuit-open events', () => {
    it('should return circuit-open event when fix-cycle limit reached', () => {
      const hsm = getHSMDefinition('feature');

      const fixCycleEvents = Array.from({ length: 3 }, (_, i) => ({
        sequence: i + 1,
        version: '1.0' as const,
        timestamp: new Date().toISOString(),
        type: 'fix-cycle' as const,
        from: 'review',
        to: 'delegate',
        trigger: 'test',
        metadata: { compoundStateId: 'implementation' },
      }));

      const state: Record<string, unknown> = {
        phase: 'review',
        reviews: { spec: { status: 'fail' } },
        _events: fixCycleEvents,
        _history: {},
      };

      const result = executeTransition(hsm, state, 'delegate');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('CIRCUIT_OPEN');
      expect(result.events.length).toBe(1);
      expect(result.events[0].type).toBe('circuit-open');
      expect(result.events[0].from).toBe('review');
      expect(result.events[0].to).toBe('delegate');
      expect(result.events[0].metadata).toBeDefined();
      expect(result.events[0].metadata!.compoundStateId).toBe('implementation');
      expect(result.events[0].metadata!.fixCycleCount).toBe(3);
      expect(result.events[0].metadata!.maxFixCycles).toBe(3);
    });

    it('should return circuit-open event for overhaul-track compound', () => {
      const hsm = getHSMDefinition('refactor');

      const fixCycleEvents = Array.from({ length: 3 }, (_, i) => ({
        sequence: i + 1,
        version: '1.0' as const,
        timestamp: new Date().toISOString(),
        type: 'fix-cycle' as const,
        from: 'overhaul-review',
        to: 'overhaul-delegate',
        trigger: 'test',
        metadata: { compoundStateId: 'overhaul-track' },
      }));

      const state: Record<string, unknown> = {
        phase: 'overhaul-review',
        track: 'overhaul',
        reviews: { spec: { status: 'fail' } },
        _events: fixCycleEvents,
        _history: {},
      };

      const result = executeTransition(hsm, state, 'overhaul-delegate');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('CIRCUIT_OPEN');
      expect(result.events.length).toBe(1);
      expect(result.events[0].type).toBe('circuit-open');
      expect(result.events[0].metadata!.compoundStateId).toBe('overhaul-track');
    });
  });
});

describe('Synthesize retry transitions', () => {
  describe('Feature HSM', () => {
    it('SynthesizeRetry_WhenRetryable_TransitionsToDelegate', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'synthesize',
        synthesis: { lastError: 'merge conflict', retryCount: 1 },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'delegate');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('delegate');
      expect(result.idempotent).toBe(false);
    });

    it('SynthesizeRetry_WhenRetriesExhausted_FailsGuard', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'synthesize',
        synthesis: { lastError: 'merge conflict', retryCount: 3 },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'delegate');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });

    it('SynthesizeRetry_WhenNoError_FailsGuard', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'synthesize',
        synthesis: {},
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'delegate');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });

    it('SynthesizeRetry_ValidTransitions_IncludesDelegateTarget', () => {
      const hsm = getHSMDefinition('feature');
      const targets = getValidTransitions(hsm, 'synthesize');
      const delegateTarget = targets.find((t) => t.phase === 'delegate');
      expect(delegateTarget).toBeDefined();
      expect(delegateTarget!.guard!.id).toBe('synthesize-retryable');
    });
  });

  describe('Debug HSM', () => {
    it('SynthesizeRetry_WhenRetryable_ThoroughTrack_TransitionsToDebugImplement', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'synthesize',
        track: 'thorough',
        synthesis: { lastError: 'merge conflict', retryCount: 0 },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'debug-implement');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('debug-implement');
      expect(result.idempotent).toBe(false);
    });

    it('SynthesizeRetry_WhenRetryable_HotfixTrack_TransitionsToHotfixImplement', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'synthesize',
        track: 'hotfix',
        synthesis: { lastError: 'merge conflict', retryCount: 0 },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'hotfix-implement');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('hotfix-implement');
      expect(result.idempotent).toBe(false);
    });

    it('SynthesizeRetry_WhenRetriesExhausted_FailsGuard', () => {
      const hsm = getHSMDefinition('debug');
      const state: Record<string, unknown> = {
        phase: 'synthesize',
        track: 'thorough',
        synthesis: { lastError: 'merge conflict', retryCount: 3 },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'debug-implement');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });

    it('SynthesizeRetry_ValidTransitions_IncludesTrackAwareTargets', () => {
      const hsm = getHSMDefinition('debug');
      const targets = getValidTransitions(hsm, 'synthesize');
      const debugImplTarget = targets.find((t) => t.phase === 'debug-implement');
      expect(debugImplTarget).toBeDefined();
      expect(debugImplTarget!.guard!.id).toBe('synthesize-retryable+thorough-track');
      const hotfixImplTarget = targets.find((t) => t.phase === 'hotfix-implement');
      expect(hotfixImplTarget).toBeDefined();
      expect(hotfixImplTarget!.guard!.id).toBe('synthesize-retryable+hotfix-track');
    });
  });

  describe('Refactor HSM', () => {
    it('SynthesizeRetry_WhenRetryable_TransitionsToOverhaulDelegate', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'synthesize',
        synthesis: { lastError: 'CI failed', retryCount: 2 },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'overhaul-delegate');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('overhaul-delegate');
      expect(result.idempotent).toBe(false);
    });

    it('SynthesizeRetry_WhenRetriesExhausted_FailsGuard', () => {
      const hsm = getHSMDefinition('refactor');
      const state: Record<string, unknown> = {
        phase: 'synthesize',
        synthesis: { lastError: 'CI failed', retryCount: 3 },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'overhaul-delegate');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
    });

    it('SynthesizeRetry_ValidTransitions_IncludesOverhaulDelegateTarget', () => {
      const hsm = getHSMDefinition('refactor');
      const targets = getValidTransitions(hsm, 'synthesize');
      const overhaulDelegateTarget = targets.find((t) => t.phase === 'overhaul-delegate');
      expect(overhaulDelegateTarget).toBeDefined();
      expect(overhaulDelegateTarget!.guard!.id).toBe('synthesize-retryable');
    });
  });
});

describe('Missing _events and _history defaults', () => {
  it('handles missing _events gracefully (defaults to empty array)', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'review',
      reviews: { spec: { status: 'fail' } },
    };

    const result = executeTransition(hsm, state, 'delegate');

    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('delegate');
  });

  it('handles missing _history gracefully (defaults to empty object)', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'plan',
      artifacts: { plan: 'docs/specs/x.md' },
    };

    const result = executeTransition(hsm, state, 'plan-review');

    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('plan-review');
  });
});

/** A minimal custom HSM puts onEntry and onExit effects on atomic states, so the tests reach the leaf-state effect paths. */
describe('Leaf-state onEntry/onExit effects', () => {

  function createTestHSM(): HSMDefinition {
    const states: Record<string, State> = {
      alpha: {
        id: 'alpha',
        type: 'atomic',
        onExit: ['log'],
      },
      beta: {
        id: 'beta',
        type: 'atomic',
        onEntry: ['checkpoint'],
      },
      done: {
        id: 'done',
        type: 'final',
      },
      cancelled: {
        id: 'cancelled',
        type: 'final',
      },
    };

    const transitions: Transition[] = [
      { from: 'alpha', to: 'beta' },
      { from: 'beta', to: 'done' },
    ];

    return { id: 'test-leaf-effects', states, transitions };
  }

  it('collects onExit effect from the current leaf state during transition', () => {
    const hsm = createTestHSM();
    const state: Record<string, unknown> = {
      phase: 'alpha',
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'beta');

    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('beta');
    expect(result.effects).toContain('log');
  });

  it('collects onEntry effect from the target leaf state during transition', () => {
    const hsm = createTestHSM();
    const state: Record<string, unknown> = {
      phase: 'alpha',
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'beta');

    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('beta');
    expect(result.effects).toContain('checkpoint');
  });

  /** The exit effects come before the entry effects. */
  it('collects both onExit and onEntry leaf effects in a single transition', () => {
    const hsm = createTestHSM();
    const state: Record<string, unknown> = {
      phase: 'alpha',
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'beta');

    expect(result.success).toBe(true);
    expect(result.effects).toContain('log');
    expect(result.effects).toContain('checkpoint');
    const logIdx = result.effects.indexOf('log');
    const checkpointIdx = result.effects.indexOf('checkpoint');
    expect(logIdx).toBeLessThan(checkpointIdx);
  });

  it('collects onExit effect from leaf state on cancel transition', () => {
    const hsm = createTestHSM();
    const state: Record<string, unknown> = {
      phase: 'alpha',
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'cancelled');

    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('cancelled');
    expect(result.effects).toContain('log');
  });
});

describe('mergeVerified guard', () => {
  it('should pass when _cleanup.mergeVerified is true', () => {
    const state = { _cleanup: { mergeVerified: true } } as Record<string, unknown>;
    expect(guards.mergeVerified.evaluate(state)).toBe(true);
  });

  it('should fail with reason when _cleanup.mergeVerified is false', () => {
    const state = { _cleanup: { mergeVerified: false } } as Record<string, unknown>;
    const result = guards.mergeVerified.evaluate(state);
    expect(typeof result).toBe('object');
    expect((result as { passed: boolean; reason: string }).passed).toBe(false);
    expect((result as { passed: boolean; reason: string }).reason).toBeTruthy();
  });

  it('should fail with reason when _cleanup is missing', () => {
    const state = {} as Record<string, unknown>;
    const result = guards.mergeVerified.evaluate(state);
    expect(typeof result).toBe('object');
    expect((result as { passed: boolean }).passed).toBe(false);
  });
});

describe('universal cleanup transition', () => {
  it('should transition from review to completed when mergeVerified', () => {
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'review', _cleanup: { mergeVerified: true }, _events: [], _history: {} };
    const result = executeTransition(hsm, state as Record<string, unknown>, 'completed');
    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('completed');
  });

  it('should transition from delegate to completed when mergeVerified', () => {
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'delegate', _cleanup: { mergeVerified: true }, _events: [], _history: {} };
    const result = executeTransition(hsm, state as Record<string, unknown>, 'completed');
    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('completed');
  });

  /** `review` has no normal transition to `completed`, so the fall-through fails. */
  it('should fall through to normal transition when mergeVerified is false', () => {
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'review', _cleanup: { mergeVerified: false }, _events: [], _history: {} };
    const result = executeTransition(hsm, state as Record<string, unknown>, 'completed');
    expect(result.success).toBe(false);
  });

  it('should still allow normal synthesize to completed via prUrlExists', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'synthesize',
      synthesis: { prUrl: 'https://github.com/test/pr/1' },
      artifacts: { pr: 'https://github.com/test/pr/1' },
      _events: [],
      _history: {},
    };
    const result = executeTransition(hsm, state as Record<string, unknown>, 'completed');
    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('completed');
  });

  it('should emit cleanup event type for cleanup transitions', () => {
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'review', _cleanup: { mergeVerified: true }, _events: [], _history: {} };
    const result = executeTransition(hsm, state as Record<string, unknown>, 'completed');
    expect(result.events[0].type).toBe('cleanup');
    expect(result.events[0].trigger).toBe('cleanup');
  });

  it('should work for debug workflow', () => {
    const hsm = getHSMDefinition('debug');
    const state = { phase: 'investigate', _cleanup: { mergeVerified: true }, _events: [], _history: {} };
    const result = executeTransition(hsm, state as Record<string, unknown>, 'completed');
    expect(result.success).toBe(true);
  });

  it('should work for refactor workflow', () => {
    const hsm = getHSMDefinition('refactor');
    const state = { phase: 'overhaul-review', _cleanup: { mergeVerified: true }, _events: [], _history: {} };
    const result = executeTransition(hsm, state as Record<string, unknown>, 'completed');
    expect(result.success).toBe(true);
  });

  it('should collect exit effects from compound parents', () => {
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'delegate', _cleanup: { mergeVerified: true }, _events: [], _history: {} };
    const result = executeTransition(hsm, state as Record<string, unknown>, 'completed');
    expect(result.success).toBe(true);
    expect(result.effects.length).toBeGreaterThan(0);
  });

  it('should record history for compound states being exited', () => {
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'delegate', _cleanup: { mergeVerified: true }, _events: [], _history: {} };
    const result = executeTransition(hsm, state as Record<string, unknown>, 'completed');
    expect(result.historyUpdates).toBeDefined();
    expect(result.historyUpdates?.['implementation']).toBe('delegate');
  });

  it('should not transition from already completed state', () => {
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'completed', _cleanup: { mergeVerified: true }, _events: [], _history: {} };
    const result = executeTransition(hsm, state as Record<string, unknown>, 'completed');
    expect(result.success).toBe(true);
    expect(result.idempotent).toBe(true);
  });
});

describe('Debug HSM Escalation Transition', () => {
  it('debugHSM_InvestigateToCancel_EscalationTransitionExists', () => {
    const hsm = getHSMDefinition('debug');
    const transition = hsm.transitions.find(
      (t) => t.from === 'investigate' && t.to === 'cancelled',
    );
    expect(transition).toBeDefined();
    expect(transition!.guard).toBeDefined();
    expect(transition!.guard!.id).toBe('escalation-required');
  });

  it('debugHSM_InvestigateToCancelled_SucceedsWhenEscalationRequired', () => {
    const hsm = getHSMDefinition('debug');
    const state: Record<string, unknown> = {
      phase: 'investigate',
      investigation: { escalate: true, rootCause: 'architectural issue' },
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'cancelled');

    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('cancelled');
  });

  /** The universal cancel still succeeds, so the test reads the guarded transition from the definition and evaluates its guard. */
  it('debugHSM_InvestigateToCancelled_FailsWhenNoEscalation', () => {
    const hsm = getHSMDefinition('debug');
    const state: Record<string, unknown> = {
      phase: 'investigate',
      investigation: { rootCause: 'simple bug' },
      _events: [],
      _history: {},
    };

    const transition = hsm.transitions.find(
      (t) => t.from === 'investigate' && t.to === 'cancelled',
    );
    expect(transition).toBeDefined();
    expect(transition!.guard).toBeDefined();

    const guardResult = transition!.guard!.evaluate(state);
    expect(guardResult).not.toBe(true);
  });
});

describe('Feature HSM Plan Revision Termination', () => {
  it('featureHSM_PlanReviewToBlocked_RevisionsExhaustedTransitionExists', () => {
    const hsm = getHSMDefinition('feature');
    const transition = hsm.transitions.find(
      (t) => t.from === 'plan-review' && t.to === 'blocked',
    );
    expect(transition).toBeDefined();
    expect(transition!.guard).toBeDefined();
    expect(transition!.guard!.id).toBe('revisions-exhausted');
  });

  /** The cap is the injected `_maxPlanRevisions`, from `workflow.maxPlanRevisions` in `.exarchos.yml`. At the cap, the terminating transition fires. */
  it('featureHSM_PlanReviewToBlocked_SucceedsWhenRevisionsExhausted', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'plan-review',
      planReview: { revisionCount: 3 },
      _maxPlanRevisions: 3,
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'blocked');

    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('blocked');
  });

  it('featureHSM_PlanReviewToBlocked_FailsWhenRevisionsBelowMax', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'plan-review',
      planReview: { revisionCount: 1 },
      _maxPlanRevisions: 3,
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'blocked');

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('GUARD_FAILED');
  });

  /** With no injected cap, the default cap is 1, so one revision reaches it. */
  it('featureHSM_PlanReviewToBlocked_DefaultCapIsOne_NoInjection', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'plan-review',
      planReview: { revisionCount: 1 },
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'blocked');

    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('blocked');
  });
});

describe('Debug HSM Hotfix-Validate to Synthesize', () => {
  it('debugHSM_HotfixValidateToSynthesize_TransitionExists', () => {
    const hsm = getHSMDefinition('debug');
    const transition = hsm.transitions.find(
      (t) => t.from === 'hotfix-validate' && t.to === 'synthesize',
    );
    expect(transition).toBeDefined();
    expect(transition!.guard).toBeDefined();
    expect(transition!.guard!.id).toBe('validation+pr-requested');
  });

  it('debugHSM_HotfixValidateToSynthesize_SucceedsWhenValidAndPrRequested', () => {
    const hsm = getHSMDefinition('debug');
    const state: Record<string, unknown> = {
      phase: 'hotfix-validate',
      validation: { testsPass: true },
      synthesis: { requested: true },
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'synthesize');

    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('synthesize');
  });

  it('debugHSM_HotfixValidateToSynthesize_FailsWhenNoPrRequested', () => {
    const hsm = getHSMDefinition('debug');
    const state: Record<string, unknown> = {
      phase: 'hotfix-validate',
      validation: { testsPass: true },
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'synthesize');

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('GUARD_FAILED');
  });

  it('debugHSM_HotfixValidateToCompleted_StillWorksWithoutPr', () => {
    const hsm = getHSMDefinition('debug');
    const state: Record<string, unknown> = {
      phase: 'hotfix-validate',
      validation: { testsPass: true },
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'completed');

    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('completed');
  });

  it('debugHSM_HotfixValidateToSynthesize_BeforeCompletedInTransitionOrder', () => {
    const hsm = getHSMDefinition('debug');
    const transitions = hsm.transitions;

    const synthIdx = transitions.findIndex(
      (t) => t.from === 'hotfix-validate' && t.to === 'synthesize',
    );
    const completedIdx = transitions.findIndex(
      (t) => t.from === 'hotfix-validate' && t.to === 'completed',
    );

    expect(synthIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThanOrEqual(0);
    expect(synthIdx).toBeLessThan(completedIdx);
  });
});

describe('getValidTransitions universal tagging', () => {
  it('tags universal completed target with universal: true', () => {
    const hsm = getHSMDefinition('feature');
    const targets = getValidTransitions(hsm, 'plan');

    const completedTarget = targets.find((t) => t.phase === 'completed');
    expect(completedTarget).toBeDefined();
    expect(completedTarget!.universal).toBe(true);
  });

  it('tags universal cancelled target with universal: true', () => {
    const hsm = getHSMDefinition('feature');
    const targets = getValidTransitions(hsm, 'plan');

    const cancelTarget = targets.find((t) => t.phase === 'cancelled');
    expect(cancelTarget).toBeDefined();
    expect(cancelTarget!.universal).toBe(true);
  });

  it('does not tag explicit transitions as universal', () => {
    const hsm = getHSMDefinition('feature');
    const targets = getValidTransitions(hsm, 'plan');

    const planReviewTarget = targets.find((t) => t.phase === 'plan-review');
    expect(planReviewTarget).toBeDefined();
    expect(planReviewTarget!.universal).toBeUndefined();
  });

  /** `hotfix-validate` has an explicit transition to `completed`, so its `completed` target is not universal. */
  it('does not tag explicit completed transition as universal (hotfix-validate)', () => {
    const hsm = getHSMDefinition('debug');
    const targets = getValidTransitions(hsm, 'hotfix-validate');

    const completedTarget = targets.find((t) => t.phase === 'completed');
    expect(completedTarget).toBeDefined();
    expect(completedTarget!.universal).toBeUndefined();
  });
});

describe('Debug HSM direct-push completion', () => {
  it('fixVerifiedDirectly guard passes with directPush and commitSha', () => {
    expect(guards.fixVerifiedDirectly).toBeDefined();
    const state = {
      resolution: { directPush: true, commitSha: 'abc123' },
    } as Record<string, unknown>;
    expect(guards.fixVerifiedDirectly.evaluate(state)).toBe(true);
  });

  it('fixVerifiedDirectly guard fails without directPush', () => {
    const state = {
      resolution: { commitSha: 'abc123' },
    } as Record<string, unknown>;
    const result = guards.fixVerifiedDirectly.evaluate(state);
    expect(result).not.toBe(true);
    expect((result as { passed: boolean }).passed).toBe(false);
  });

  it('fixVerifiedDirectly guard fails without commitSha', () => {
    const state = {
      resolution: { directPush: true },
    } as Record<string, unknown>;
    const result = guards.fixVerifiedDirectly.evaluate(state);
    expect(result).not.toBe(true);
    expect((result as { passed: boolean }).passed).toBe(false);
  });

  it('debugHSM_InvestigateToCompleted_SucceedsWithDirectPush', () => {
    const hsm = getHSMDefinition('debug');
    const state: Record<string, unknown> = {
      phase: 'investigate',
      resolution: { directPush: true, commitSha: 'abc123' },
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'completed');

    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('completed');
  });

  it('debugHSM_InvestigateToCompleted_FailsWithoutDirectPush', () => {
    const hsm = getHSMDefinition('debug');
    const state: Record<string, unknown> = {
      phase: 'investigate',
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'completed');

    expect(result.success).toBe(false);
  });

  it('debugHSM_InvestigateToCompleted_TransitionExists', () => {
    const hsm = getHSMDefinition('debug');
    const transition = hsm.transitions.find(
      (t) => t.from === 'investigate' && t.to === 'completed',
    );
    expect(transition).toBeDefined();
    expect(transition!.guard).toBeDefined();
    expect(transition!.guard!.id).toBe('fix-verified-directly');
  });
});

describe('HSM Registry Extension', () => {
  const CUSTOM_NAME = 'custom-deploy';

  afterEach(() => {
    try { unregisterWorkflowType(CUSTOM_NAME); } catch { }
  });

  it('RegisterWorkflowType_AddsToHsmRegistry', () => {
    const definition: WorkflowDefinition = {
      phases: ['init', 'build', 'deploy', 'done'],
      initialPhase: 'init',
      transitions: [
        { from: 'init', to: 'build', event: 'start-build' },
        { from: 'build', to: 'deploy', event: 'build-complete' },
        { from: 'deploy', to: 'done', event: 'deploy-complete' },
      ],
    };

    registerWorkflowType(CUSTOM_NAME, definition);

    const hsm = getHSMDefinition(CUSTOM_NAME);
    expect(hsm).toBeDefined();
    expect(hsm.id).toBe(CUSTOM_NAME);
    expect(hsm.states['init']).toBeDefined();
    expect(hsm.states['build']).toBeDefined();
    expect(hsm.states['deploy']).toBeDefined();
    expect(hsm.states['done']).toBeDefined();
  });

  it('RegisterWorkflowType_ExtendsBuiltIn_InheritsTransitions', () => {
    const featureHsm = getHSMDefinition('feature');
    const featureTransitionCount = featureHsm.transitions.length;

    const definition: WorkflowDefinition = {
      extends: 'feature',
      phases: ['extra-review'],
      initialPhase: 'plan',
      transitions: [
        { from: 'synthesize', to: 'extra-review', event: 'needs-extra-review' },
        { from: 'extra-review', to: 'completed', event: 'extra-review-done' },
      ],
    };

    registerWorkflowType(CUSTOM_NAME, definition);

    const hsm = getHSMDefinition(CUSTOM_NAME);
    expect(hsm.id).toBe(CUSTOM_NAME);

    expect(hsm.states['plan']).toBeDefined();
    expect(hsm.states['plan-review']).toBeDefined();
    expect(hsm.states['delegate']).toBeDefined();

    expect(hsm.states['extra-review']).toBeDefined();

    expect(hsm.transitions.length).toBeGreaterThan(2);

    const customTransition = hsm.transitions.find(
      (t) => t.from === 'synthesize' && t.to === 'extra-review',
    );
    expect(customTransition).toBeDefined();
  });

  it('RegisterWorkflowType_CustomPhases_ValidTransitions', () => {
    const definition: WorkflowDefinition = {
      phases: ['start', 'middle', 'end'],
      initialPhase: 'start',
      transitions: [
        { from: 'start', to: 'middle', event: 'advance' },
        { from: 'middle', to: 'end', event: 'finish' },
      ],
    };

    registerWorkflowType(CUSTOM_NAME, definition);

    const hsm = getHSMDefinition(CUSTOM_NAME);

    const state = { phase: 'start', _events: [], _history: {} };
    const result = executeTransition(hsm, state, 'middle');

    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('middle');
  });

  it('RegisterWorkflowType_DuplicateName_Throws', () => {
    const definition: WorkflowDefinition = {
      phases: ['a', 'b'],
      initialPhase: 'a',
      transitions: [{ from: 'a', to: 'b', event: 'go' }],
    };

    expect(() => registerWorkflowType('feature', definition)).toThrow(
      'Cannot override built-in workflow type: feature',
    );
    expect(() => registerWorkflowType('debug', definition)).toThrow(
      'Cannot override built-in workflow type: debug',
    );
    expect(() => registerWorkflowType('refactor', definition)).toThrow(
      'Cannot override built-in workflow type: refactor',
    );
    expect(() => registerWorkflowType('oneshot', definition)).toThrow(
      'Cannot override built-in workflow type: oneshot',
    );
  });
});

describe('findTransition', () => {
  it('FindTransition_ExistingTransition_ReturnsTransition', () => {
    const hsm = getHSMDefinition('feature');
    const transition = findTransition(hsm, 'plan', 'plan-review');
    expect(transition).toBeDefined();
    expect(transition!.from).toBe('plan');
    expect(transition!.to).toBe('plan-review');
  });

  it('FindTransition_NoMatch_ReturnsUndefined', () => {
    const hsm = getHSMDefinition('feature');
    const transition = findTransition(hsm, 'plan', 'review');
    expect(transition).toBeUndefined();
  });

  it('FindTransition_CustomWorkflowWithGuard_ReturnsGuard', () => {
    const definition: WorkflowDefinition = {
      phases: ['build', 'deploy'],
      initialPhase: 'build',
      transitions: [
        { from: 'build', to: 'deploy', event: 'build-done', guard: 'check-build' },
      ],
      guards: {
        'check-build': { command: 'echo ok' },
      },
    };

    registerWorkflowType('find-test', definition);
    try {
      const hsm = getHSMDefinition('find-test');
      const transition = findTransition(hsm, 'build', 'deploy');
      expect(transition).toBeDefined();
      expect(transition!.guard).toBeDefined();
      expect(transition!.guard!.id).toBe('check-build');
    } finally {
      unregisterWorkflowType('find-test');
    }
  });
});

/**
 * The oneshot workflow has a choice state at `implementing`.
 * For each combination of `synthesisPolicy` and a `synthesize.requested` event, exactly one of `synthesisOptedIn` and `synthesisOptedOut` passes.
 */
describe('Oneshot Workflow HSM', () => {
  it('oneshot_hsmHasFourTransitions', () => {
    const hsm = getHSMDefinition('oneshot');
    expect(hsm).toBeDefined();
    expect(hsm.id).toBe('oneshot');

    const planToImpl = hsm.transitions.find(
      (t) => t.from === 'plan' && t.to === 'implementing',
    );
    expect(planToImpl).toBeDefined();
    expect(planToImpl!.guard).toBeDefined();

    const implToSynth = hsm.transitions.find(
      (t) => t.from === 'implementing' && t.to === 'synthesize',
    );
    expect(implToSynth).toBeDefined();
    expect(implToSynth!.guard).toBeDefined();
    expect(implToSynth!.guard!.id).toBe('synthesis-opted-in');

    const implToCompleted = hsm.transitions.find(
      (t) => t.from === 'implementing' && t.to === 'completed',
    );
    expect(implToCompleted).toBeDefined();
    expect(implToCompleted!.guard).toBeDefined();
    expect(implToCompleted!.guard!.id).toBe('synthesis-opted-out');

    const synthToCompleted = hsm.transitions.find(
      (t) => t.from === 'synthesize' && t.to === 'completed',
    );
    expect(synthToCompleted).toBeDefined();
    expect(synthToCompleted!.guard).toBeDefined();
    expect(synthToCompleted!.guard!.id).toBe('merge-verified');
  });

  it('oneshot_initialPhaseIsPlan', () => {
    const hsm = getHSMDefinition('oneshot');
    expect(hsm.states['plan']).toBeDefined();
    expect(hsm.states['plan'].type).toBe('atomic');
    expect(hsm.states['implementing']).toBeDefined();
    expect(hsm.states['synthesize']).toBeDefined();
    expect(hsm.states['completed']).toBeDefined();
    expect(hsm.states['completed'].type).toBe('final');
    expect(hsm.states['cancelled']).toBeDefined();
    expect(hsm.states['cancelled'].type).toBe('final');
  });

  it('oneshot_planToImplementing_requiresPlanArtifact', () => {
    const hsm = getHSMDefinition('oneshot');

    const noPlan: Record<string, unknown> = {
      phase: 'plan',
      workflowType: 'oneshot',
      oneshot: { synthesisPolicy: 'on-request' },
      artifacts: {},
      _events: [],
      _history: {},
    };
    const failResult = executeTransition(hsm, noPlan, 'implementing');
    expect(failResult.success).toBe(false);
    expect(failResult.errorCode).toBe('GUARD_FAILED');

    const withPlan: Record<string, unknown> = {
      phase: 'plan',
      workflowType: 'oneshot',
      oneshot: { synthesisPolicy: 'on-request', planSummary: 'One-page plan' },
      artifacts: { plan: 'One-page plan' },
      _events: [],
      _history: {},
    };
    const okResult = executeTransition(hsm, withPlan, 'implementing');
    expect(okResult.success).toBe(true);
    expect(okResult.newPhase).toBe('implementing');
  });

  /**
   * Runs eight combinations of policy and event. A missing policy acts as `on-request`.
   * `always` goes to `synthesize`, and `never` goes to `completed`. `on-request` goes to `synthesize` only when the event is present.
   */
  it('oneshot_implementingChoiceStateMutuallyExclusive', () => {
    const hsm = getHSMDefinition('oneshot');

    const policies: Array<{
      label: string;
      oneshot: Record<string, unknown> | undefined;
    }> = [
      { label: 'always', oneshot: { synthesisPolicy: 'always' } },
      { label: 'never', oneshot: { synthesisPolicy: 'never' } },
      { label: 'on-request', oneshot: { synthesisPolicy: 'on-request' } },
      { label: 'default (undefined)', oneshot: undefined },
    ];
    const eventStreams: Array<{
      label: string;
      events: Array<Record<string, unknown>>;
    }> = [
      { label: 'no events', events: [] },
      {
        label: 'synthesize.requested present',
        events: [{ type: 'synthesize.requested' }],
      },
    ];

    for (const policy of policies) {
      for (const stream of eventStreams) {
        const state: Record<string, unknown> = {
          phase: 'implementing',
          workflowType: 'oneshot',
          artifacts: { plan: 'captured' },
          _events: stream.events,
          _history: {},
        };
        if (policy.oneshot !== undefined) {
          state.oneshot = policy.oneshot;
        }

        const toSynth = executeTransition(hsm, state, 'synthesize');
        const toCompleted = executeTransition(hsm, state, 'completed');

        const synthOk = toSynth.success === true;
        const completedOk = toCompleted.success === true;

        const caseLabel = `policy=${policy.label}, events=${stream.label}`;
        expect(
          synthOk !== completedOk,
          `Expected exactly one reachable target from implementing for ${caseLabel}, got synth=${synthOk}, completed=${completedOk}`,
        ).toBe(true);

        const effectivePolicy =
          policy.oneshot === undefined
            ? 'on-request'
            : (policy.oneshot.synthesisPolicy as string);
        const hasEvent = stream.events.some(
          (e) => e.type === 'synthesize.requested',
        );

        let expectedTarget: 'synthesize' | 'completed';
        if (effectivePolicy === 'always') expectedTarget = 'synthesize';
        else if (effectivePolicy === 'never') expectedTarget = 'completed';
        else expectedTarget = hasEvent ? 'synthesize' : 'completed';

        expect(
          expectedTarget === 'synthesize' ? synthOk : completedOk,
          `Expected ${expectedTarget} to be reachable for ${caseLabel}`,
        ).toBe(true);
      }
    }
  });

  it('oneshot_synthesizeToCompleted_requiresMergeVerified', () => {
    const hsm = getHSMDefinition('oneshot');

    const pending: Record<string, unknown> = {
      phase: 'synthesize',
      workflowType: 'oneshot',
      artifacts: { plan: 'captured' },
      _events: [],
      _history: {},
    };
    const pendingResult = executeTransition(hsm, pending, 'completed');
    expect(pendingResult.success).toBe(false);

    const verified: Record<string, unknown> = {
      phase: 'synthesize',
      workflowType: 'oneshot',
      artifacts: { plan: 'captured' },
      _cleanup: { mergeVerified: true },
      _events: [],
      _history: {},
    };
    const verifiedResult = executeTransition(hsm, verified, 'completed');
    expect(verifiedResult.success).toBe(true);
    expect(verifiedResult.newPhase).toBe('completed');
  });

  /** Cancel must succeed from each phase that is not final, and `getValidTransitions` must mark it universal. */
  it('oneshot_inheritsUniversalCancelTransition', () => {
    const hsm = getHSMDefinition('oneshot');

    const nonFinalPhases = ['plan', 'implementing', 'synthesize'];
    for (const phase of nonFinalPhases) {
      const state: Record<string, unknown> = {
        phase,
        workflowType: 'oneshot',
        artifacts: { plan: 'captured' },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'cancelled');

      expect(result.success, `Cancel should succeed from ${phase}`).toBe(true);
      expect(result.newPhase).toBe('cancelled');
    }

    const targets = getValidTransitions(hsm, 'plan');
    const cancelTarget = targets.find((t) => t.phase === 'cancelled');
    expect(cancelTarget).toBeDefined();
    expect(cancelTarget!.universal).toBe(true);
  });

  it('oneshot_cannotTransitionFromFinalCompleted', () => {
    const hsm = getHSMDefinition('oneshot');
    const state: Record<string, unknown> = {
      phase: 'completed',
      workflowType: 'oneshot',
      _events: [],
      _history: {},
    };
    const result = executeTransition(hsm, state, 'implementing');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_TRANSITION');
  });
});
