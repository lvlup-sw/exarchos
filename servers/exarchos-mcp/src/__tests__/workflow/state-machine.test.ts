import { describe, it, expect } from 'vitest';
import {
  getHSMDefinition,
  executeTransition,
  getValidTransitions,
} from '../../workflow/state-machine.js';
import type { HSMDefinition, State, Transition } from '../../workflow/state-machine.js';
import { guards } from '../../workflow/guards.js';

// ─── Task 003: HSM State/Transition Definitions ─────────────────────────────

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

      // Atomic states
      expect(hsm.states['ideate']).toBeDefined();
      expect(hsm.states['ideate'].type).toBe('atomic');

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

      // Compound state: Implementation
      expect(hsm.states['implementation']).toBeDefined();
      expect(hsm.states['implementation'].type).toBe('compound');
      expect(hsm.states['implementation'].initial).toBe('delegate');

      // Children of Implementation compound
      expect(hsm.states['delegate']).toBeDefined();
      expect(hsm.states['delegate'].type).toBe('atomic');
      expect(hsm.states['delegate'].parent).toBe('implementation');

      expect(hsm.states['review']).toBeDefined();
      expect(hsm.states['review'].type).toBe('atomic');
      expect(hsm.states['review'].parent).toBe('implementation');

      // integrate state should NOT exist
      expect(hsm.states['integrate']).toBeUndefined();
    });

    it('FeatureHSM_ValidTransitions_MatchDesignDiagram', () => {
      hsm = getHSMDefinition('feature');
      const transitions = hsm.transitions;

      // ideate → plan
      const ideateToPlan = transitions.find(
        (t) => t.from === 'ideate' && t.to === 'plan'
      );
      expect(ideateToPlan).toBeDefined();
      expect(ideateToPlan!.guard).toBeDefined();
      expect(ideateToPlan!.guard!.id).toBe('design-artifact-exists');

      // plan → plan-review
      const planToPlanReview = transitions.find(
        (t) => t.from === 'plan' && t.to === 'plan-review'
      );
      expect(planToPlanReview).toBeDefined();
      expect(planToPlanReview!.guard).toBeDefined();
      expect(planToPlanReview!.guard!.id).toBe('plan-artifact-exists');

      // plan-review → delegate (enters Implementation compound)
      const planReviewToDelegate = transitions.find(
        (t) => t.from === 'plan-review' && t.to === 'delegate'
      );
      expect(planReviewToDelegate).toBeDefined();
      expect(planReviewToDelegate!.guard).toBeDefined();
      expect(planReviewToDelegate!.guard!.id).toBe('plan-review-complete');

      // delegate → review (direct, no integrate step)
      const delegateToReview = transitions.find(
        (t) => t.from === 'delegate' && t.to === 'review'
      );
      expect(delegateToReview).toBeDefined();
      expect(delegateToReview!.guard!.id).toBe('all-tasks-complete+team-disbanded');

      // integrate transitions should NOT exist
      expect(transitions.find((t) => t.from === 'integrate')).toBeUndefined();
      expect(transitions.find((t) => t.to === 'integrate')).toBeUndefined();

      // review → synthesize (exits Implementation compound)
      const reviewToSynthesize = transitions.find(
        (t) => t.from === 'review' && t.to === 'synthesize'
      );
      expect(reviewToSynthesize).toBeDefined();
      expect(reviewToSynthesize!.guard!.id).toBe('all-reviews-passed');

      // review → delegate (fix cycle)
      const reviewToDelegate = transitions.find(
        (t) => t.from === 'review' && t.to === 'delegate'
      );
      expect(reviewToDelegate).toBeDefined();
      expect(reviewToDelegate!.guard!.id).toBe('any-review-failed');
      expect(reviewToDelegate!.isFixCycle).toBe(true);

      // synthesize → completed
      const synthesizeToCompleted = transitions.find(
        (t) => t.from === 'synthesize' && t.to === 'completed'
      );
      expect(synthesizeToCompleted).toBeDefined();
      expect(synthesizeToCompleted!.guard!.id).toBe('pr-url-exists');

      // blocked → delegate
      const blockedToDelegate = transitions.find(
        (t) => t.from === 'blocked' && t.to === 'delegate'
      );
      expect(blockedToDelegate).toBeDefined();
      expect(blockedToDelegate!.guard!.id).toBe('human-unblocked');
    });
  });

  describe('Debug Workflow HSM', () => {
    it('DebugHSM_AllStatesAndTransitions_MatchDesign', () => {
      const hsm = getHSMDefinition('debug');
      expect(hsm.id).toBe('debug');

      // Atomic states
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

      // ThoroughTrack compound state
      expect(hsm.states['thorough-track']).toBeDefined();
      expect(hsm.states['thorough-track'].type).toBe('compound');
      expect(hsm.states['thorough-track'].maxFixCycles).toBe(2);

      // ThoroughTrack children: rca, design, implement, validate, review
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

      // HotfixTrack compound state
      expect(hsm.states['hotfix-track']).toBeDefined();
      expect(hsm.states['hotfix-track'].type).toBe('compound');

      // HotfixTrack children: implement, validate
      for (const child of ['hotfix-implement', 'hotfix-validate']) {
        expect(hsm.states[child]).toBeDefined();
        expect(hsm.states[child].parent).toBe('hotfix-track');
      }

      // Key transitions
      const transitions = hsm.transitions;

      // triage → investigate
      expect(
        transitions.find((t) => t.from === 'triage' && t.to === 'investigate')
      ).toBeDefined();

      // investigate → rca (thorough track entry)
      expect(
        transitions.find((t) => t.from === 'investigate' && t.to === 'rca')
      ).toBeDefined();

      // investigate → hotfix-implement (hotfix track entry)
      expect(
        transitions.find(
          (t) => t.from === 'investigate' && t.to === 'hotfix-implement'
        )
      ).toBeDefined();

      // rca → design
      expect(
        transitions.find((t) => t.from === 'rca' && t.to === 'design')
      ).toBeDefined();

      // design → debug-implement
      expect(
        transitions.find(
          (t) => t.from === 'design' && t.to === 'debug-implement'
        )
      ).toBeDefined();

      // debug-implement → debug-validate
      expect(
        transitions.find(
          (t) => t.from === 'debug-implement' && t.to === 'debug-validate'
        )
      ).toBeDefined();

      // debug-validate → debug-review
      expect(
        transitions.find(
          (t) => t.from === 'debug-validate' && t.to === 'debug-review'
        )
      ).toBeDefined();

      // debug-review → synthesize
      expect(
        transitions.find(
          (t) => t.from === 'debug-review' && t.to === 'synthesize'
        )
      ).toBeDefined();

      // hotfix-implement → hotfix-validate
      expect(
        transitions.find(
          (t) => t.from === 'hotfix-implement' && t.to === 'hotfix-validate'
        )
      ).toBeDefined();

      // hotfix-validate → completed
      expect(
        transitions.find(
          (t) => t.from === 'hotfix-validate' && t.to === 'completed'
        )
      ).toBeDefined();

      // synthesize → completed
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

      // Atomic states
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

      // PolishTrack compound state
      expect(hsm.states['polish-track']).toBeDefined();
      expect(hsm.states['polish-track'].type).toBe('compound');

      // PolishTrack children: implement, validate, update-docs
      for (const child of [
        'polish-implement',
        'polish-validate',
        'polish-update-docs',
      ]) {
        expect(hsm.states[child]).toBeDefined();
        expect(hsm.states[child].parent).toBe('polish-track');
      }

      // OverhaulTrack compound state
      expect(hsm.states['overhaul-track']).toBeDefined();
      expect(hsm.states['overhaul-track'].type).toBe('compound');
      expect(hsm.states['overhaul-track'].maxFixCycles).toBe(3);

      // OverhaulTrack children: plan, plan-review, delegate, review, update-docs (no integrate)
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

      // overhaul-integrate should NOT exist
      expect(hsm.states['overhaul-integrate']).toBeUndefined();

      // Key transitions
      const transitions = hsm.transitions;

      // explore → brief
      expect(
        transitions.find((t) => t.from === 'explore' && t.to === 'brief')
      ).toBeDefined();

      // brief → polish-implement (polish track entry)
      expect(
        transitions.find(
          (t) => t.from === 'brief' && t.to === 'polish-implement'
        )
      ).toBeDefined();

      // brief → overhaul-plan (overhaul track entry)
      expect(
        transitions.find(
          (t) => t.from === 'brief' && t.to === 'overhaul-plan'
        )
      ).toBeDefined();

      // Polish track flow
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

      // Overhaul track flow (no integrate step, plan-review before delegate)
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

      // overhaul-integrate transitions should NOT exist
      expect(transitions.find((t) => t.from === 'overhaul-integrate')).toBeUndefined();
      expect(transitions.find((t) => t.to === 'overhaul-integrate')).toBeUndefined();

      // Overhaul fix cycles (only review → delegate, no integrate → delegate)
      const reviewToDelegate = transitions.find(
        (t) => t.from === 'overhaul-review' && t.to === 'overhaul-delegate'
      );
      expect(reviewToDelegate).toBeDefined();
      expect(reviewToDelegate!.isFixCycle).toBe(true);

      // synthesize → completed
      expect(
        transitions.find(
          (t) => t.from === 'synthesize' && t.to === 'completed'
        )
      ).toBeDefined();
    });
  });

  describe('Compound States', () => {
    it('CompoundStates_HaveEntryExitEffects_AndMaxFixCycles', () => {
      // Feature: Implementation compound
      const feature = getHSMDefinition('feature');
      const implementation = feature.states['implementation'];
      expect(implementation.type).toBe('compound');
      expect(implementation.maxFixCycles).toBe(3);
      expect(implementation.onEntry).toBeDefined();
      expect(implementation.onEntry).toContain('log');
      expect(implementation.onExit).toBeDefined();
      expect(implementation.onExit).toContain('log');

      // Debug: ThoroughTrack compound
      const debug = getHSMDefinition('debug');
      const thoroughTrack = debug.states['thorough-track'];
      expect(thoroughTrack.type).toBe('compound');
      expect(thoroughTrack.maxFixCycles).toBe(2);
      expect(thoroughTrack.onEntry).toBeDefined();
      expect(thoroughTrack.onEntry).toContain('log');
      expect(thoroughTrack.onExit).toBeDefined();
      expect(thoroughTrack.onExit).toContain('log');

      // Debug: HotfixTrack compound
      const hotfixTrack = debug.states['hotfix-track'];
      expect(hotfixTrack.type).toBe('compound');
      expect(hotfixTrack.onEntry).toBeDefined();
      expect(hotfixTrack.onExit).toBeDefined();

      // Refactor: PolishTrack compound
      const refactor = getHSMDefinition('refactor');
      const polishTrack = refactor.states['polish-track'];
      expect(polishTrack.type).toBe('compound');
      expect(polishTrack.onEntry).toBeDefined();
      expect(polishTrack.onExit).toBeDefined();

      // Refactor: OverhaulTrack compound
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

// ─── Task 004: HSM Transition Algorithm ──────────────────────────────────────

describe('HSM Transition Algorithm', () => {
  describe('executeTransition', () => {
    it('ExecuteTransition_ValidTransition_ReturnsSuccess', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'ideate',
        artifacts: { design: 'docs/design.md', plan: null, pr: null },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'plan');

      expect(result.success).toBe(true);
      expect(result.newPhase).toBe('plan');
      expect(result.idempotent).toBe(false);
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.events[0].type).toBe('transition');
    });

    it('ExecuteTransition_IdempotentSamePhase_ReturnsNoOp', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'ideate',
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'ideate');

      expect(result.success).toBe(true);
      expect(result.idempotent).toBe(true);
      expect(result.effects).toEqual([]);
      expect(result.events).toEqual([]);
    });

    it('ExecuteTransition_InvalidTarget_ReturnsInvalidTransition', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'ideate',
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'completed');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('INVALID_TRANSITION');
      expect(result.validTargets).toBeDefined();
      expect(result.validTargets!.length).toBeGreaterThan(0);

      // Enriched validTargets include guard metadata
      const planTarget = result.validTargets!.find((t) => t.phase === 'plan');
      expect(planTarget).toBeDefined();
      expect(planTarget!.guard).toBeDefined();
      expect(planTarget!.guard!.id).toBe('design-artifact-exists');
      expect(planTarget!.guard!.description).toBe('Design artifact must exist');
    });

    it('ExecuteTransition_GuardFails_ReturnsGuardFailed', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'ideate',
        artifacts: { design: null, plan: null, pr: null },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'plan');

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
      // Exiting Implementation compound should fire exit effects
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
      // Should record last sub-state when leaving compound
      expect(result.historyUpdates).toBeDefined();
      expect(result.historyUpdates!['implementation']).toBe('review');
    });

    it('ExecuteTransition_CancelFromAnyNonFinal_Succeeds', () => {
      const hsm = getHSMDefinition('feature');

      const nonFinalPhases = [
        'ideate',
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
      // Fix-cycle event should use compoundStateId key, not compound
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
      // compound-entry event should include compoundStateId metadata
      const compoundEntryEvent = result.events.find((e) => e.type === 'compound-entry');
      expect(compoundEntryEvent).toBeDefined();
      expect(compoundEntryEvent!.metadata).toBeDefined();
      expect(compoundEntryEvent!.metadata!.compoundStateId).toBe('implementation');
    });

    it('ExecuteTransition_CircuitBreaker_ReturnsCircuitOpen', () => {
      const hsm = getHSMDefinition('feature');

      // Simulate 3 fix-cycle events within the implementation compound
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

    it('ExecuteTransition_GuardThrows_ReturnsGuardFailed (Bug 7)', () => {
      const hsm = getHSMDefinition('feature');
      // Corrupt state: tasks is an array-like object (not a real Array)
      // The allTasksComplete guard calls tasks.every() which is undefined on non-arrays
      // This triggers: TypeError: tasks.every is not a function
      const state: Record<string, unknown> = {
        phase: 'delegate',
        tasks: { length: 1, 0: { status: 'pending' } },
        _events: [],
        _history: {},
      };

      // Should NOT throw — should return structured error
      const result = executeTransition(hsm, state, 'review');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
      expect(result.errorMessage).toContain('Guard');
    });
  });

  describe('getValidTransitions', () => {
    /** Extract phase strings from enriched ValidTransitionTarget array */
    const phases = (targets: readonly { phase: string }[]) => targets.map((t) => t.phase);

    it('returns valid target phases from a given phase', () => {
      const hsm = getHSMDefinition('feature');
      const targets = getValidTransitions(hsm, 'ideate');

      expect(phases(targets)).toContain('plan');
      expect(phases(targets)).toContain('cancelled');
    });

    it('returns empty array for final states', () => {
      const hsm = getHSMDefinition('feature');
      const targets = getValidTransitions(hsm, 'completed');

      expect(targets).toEqual([]);
    });

    it('returns valid transitions for compound state children', () => {
      const hsm = getHSMDefinition('feature');

      // delegate is inside implementation compound — goes directly to review
      const delegateTargets = getValidTransitions(hsm, 'delegate');
      expect(phases(delegateTargets)).toContain('review');
      expect(phases(delegateTargets)).toContain('cancelled');
      expect(phases(delegateTargets)).not.toContain('integrate');

      // review has two transitions: synthesize (passed) and delegate (fix cycle)
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

// ─── Task: Debug HSM executeTransition Tests ──────────────────────────────────

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
      // Should have compound-entry event for thorough-track
      const compoundEntry = result.events.find(
        (e) => e.type === 'compound-entry'
      );
      expect(compoundEntry).toBeDefined();
      expect(compoundEntry!.metadata!.compoundStateId).toBe('thorough-track');
      // Should have onEntry effect from thorough-track compound
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
      // Should have compound-entry event for hotfix-track
      const compoundEntry = result.events.find(
        (e) => e.type === 'compound-entry'
      );
      expect(compoundEntry).toBeDefined();
      expect(compoundEntry!.metadata!.compoundStateId).toBe('hotfix-track');
      // Should have onEntry effect from hotfix-track compound
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
      // Both rca and design are within thorough-track, so no compound events
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

      // implementationComplete always returns true
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
      // Should have compound-exit event for thorough-track
      const compoundExit = result.events.find(
        (e) => e.type === 'compound-exit'
      );
      expect(compoundExit).toBeDefined();
      expect(compoundExit!.from).toBe('thorough-track');
      // Should have onExit effect from thorough-track compound
      expect(result.effects).toContain('log');
      // History should record last sub-state
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

      // implementationComplete always returns true
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
      // Should have compound-exit event for hotfix-track
      const compoundExit = result.events.find(
        (e) => e.type === 'compound-exit'
      );
      expect(compoundExit).toBeDefined();
      expect(compoundExit!.from).toBe('hotfix-track');
      // Should have onExit effect from hotfix-track compound
      expect(result.effects).toContain('log');
      // History should record last sub-state
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
      // Should record history for the thorough-track compound
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

// ─── Task: Refactor HSM executeTransition Tests ───────────────────────────────

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
      // Should have compound-entry event for polish-track
      const compoundEntry = result.events.find(
        (e) => e.type === 'compound-entry'
      );
      expect(compoundEntry).toBeDefined();
      expect(compoundEntry!.metadata!.compoundStateId).toBe('polish-track');
      // Should have onEntry effect from polish-track compound
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
      // Should have compound-entry event for overhaul-track
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

      // implementationComplete always returns true
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
      // Should have compound-exit event for polish-track
      const compoundExit = result.events.find(
        (e) => e.type === 'compound-exit'
      );
      expect(compoundExit).toBeDefined();
      expect(compoundExit!.from).toBe('polish-track');
      // Should have onExit effect from polish-track compound
      expect(result.effects).toContain('log');
      // History should record last sub-state
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
      // Should exit overhaul-track compound
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

      // Simulate 3 fix-cycle events within the overhaul-track compound
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

// ─── Task: Feature HSM plan-review gap loop ───────────────────────────────────

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
    // Should include the log effect from the transition
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

// ─── Task: Final state and edge case transitions ──────────────────────────────

describe('Final state transitions', () => {
  it('returns INVALID_TRANSITION when transitioning from completed state', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'completed',
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'ideate');

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

    const result = executeTransition(hsm, state, 'ideate');

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

// ─── Task: getValidTransitions enriched output ────────────────────────────────

describe('getValidTransitions guard metadata', () => {
  it('returns guard id and description for guarded transitions', () => {
    const hsm = getHSMDefinition('feature');
    const targets = getValidTransitions(hsm, 'ideate');

    const planTarget = targets.find((t) => t.phase === 'plan');
    expect(planTarget).toBeDefined();
    expect(planTarget!.guard).toEqual({
      id: 'design-artifact-exists',
      description: 'Design artifact must exist',
    });
  });

  it('omits guard for unguarded transitions (cancelled)', () => {
    const hsm = getHSMDefinition('feature');
    const targets = getValidTransitions(hsm, 'ideate');

    const cancelTarget = targets.find((t) => t.phase === 'cancelled');
    expect(cancelTarget).toBeDefined();
    expect(cancelTarget!.guard).toBeUndefined();
  });

  it('includes merge-verified guard for universal completed transition', () => {
    const hsm = getHSMDefinition('feature');
    const targets = getValidTransitions(hsm, 'ideate');

    const completedTarget = targets.find((t) => t.phase === 'completed');
    expect(completedTarget).toBeDefined();
    expect(completedTarget!.guard).toEqual({
      id: 'merge-verified',
      description: 'Merge must be verified by the orchestrator before cleanup',
    });
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

// ─── Task: Additional guard coverage ──────────────────────────────────────────

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

    // Neither allReviewsPassed nor anyReviewFailed should pass
    const toSynthesize = executeTransition(hsm, state, 'synthesize');
    expect(toSynthesize.success).toBe(false);

    const toDelegate = executeTransition(hsm, state, 'delegate');
    expect(toDelegate.success).toBe(false);
  });

  // ─── Status-based review format (matches what skills actually write) ────

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

  // ─── Guard diagnostic reasons ────

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

  it('countFixCycles counts only matching compound events', () => {
    const hsm = getHSMDefinition('feature');

    // 2 fix cycles for 'implementation', 1 for unrelated compound
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

    // Should succeed because only 2 of 3 fix-cycle events match 'implementation'
    // and maxFixCycles for implementation is 3
    const result = executeTransition(hsm, state, 'delegate');
    expect(result.success).toBe(true);
  });

  it('countFixCycles triggers circuit breaker at exact limit', () => {
    const hsm = getHSMDefinition('feature');

    // Exactly 3 fix-cycle events for 'implementation' (maxFixCycles is 3)
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

// ─── Task: Missing state/edge case coverage ──────────────────────────────────

// ─── Task: Diagnostic event emission on guard failure and circuit open ──────

describe('Diagnostic Event Emission', () => {
  describe('guard-failed events', () => {
    it('should return guard-failed event when guard returns false', () => {
      const hsm = getHSMDefinition('feature');
      const state: Record<string, unknown> = {
        phase: 'ideate',
        artifacts: { design: null, plan: null, pr: null },
        _events: [],
        _history: {},
      };

      const result = executeTransition(hsm, state, 'plan');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
      expect(result.events.length).toBe(1);
      expect(result.events[0].type).toBe('guard-failed');
      expect(result.events[0].from).toBe('ideate');
      expect(result.events[0].to).toBe('plan');
      expect(result.events[0].metadata).toBeDefined();
      expect(result.events[0].metadata!.guard).toBe('design-artifact-exists');
    });

    it('should return guard-failed event when guard throws exception', () => {
      const hsm = getHSMDefinition('feature');
      // Corrupt state that makes the allTasksComplete guard throw
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

      // Simulate 3 fix-cycle events within the implementation compound (maxFixCycles is 3)
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

      // Simulate 3 fix-cycle events within the overhaul-track compound (maxFixCycles is 3)
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

// ─── Task: Synthesize retry transitions ───────────────────────────────────────

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
      // No _events or _history
    };

    const result = executeTransition(hsm, state, 'delegate');

    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('delegate');
  });

  it('handles missing _history gracefully (defaults to empty object)', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'ideate',
      artifacts: { design: 'docs/design.md' },
      // No _history
    };

    const result = executeTransition(hsm, state, 'plan');

    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('plan');
  });
});

// ─── Task: Leaf-state onEntry/onExit effect coverage ──────────────────────────

describe('Leaf-state onEntry/onExit effects', () => {
  // Build a minimal custom HSM where leaf (atomic) states have onEntry/onExit effects.
  // This exercises the code paths at lines 843-844 (currentState.onExit) and
  // 876-877 (targetState.onEntry) in state-machine.ts, which are not reached
  // by the built-in HSM definitions (only compound states have effects there).

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
    // Should include the onExit effect from the alpha leaf state
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
    // Should include the onEntry effect from the beta leaf state
    expect(result.effects).toContain('checkpoint');
  });

  it('collects both onExit and onEntry leaf effects in a single transition', () => {
    const hsm = createTestHSM();
    const state: Record<string, unknown> = {
      phase: 'alpha',
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'beta');

    expect(result.success).toBe(true);
    // Both leaf-state exit (log) and entry (checkpoint) effects should be present
    expect(result.effects).toContain('log');
    expect(result.effects).toContain('checkpoint');
    // Exit effects come before entry effects
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
    // Should include the onExit effect from the alpha leaf state via cancel path
    expect(result.effects).toContain('log');
  });
});

// ─── Task 1: mergeVerified guard ──────────────────────────────────────────────

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

// ─── Task 2: Universal cleanup transition ─────────────────────────────────────

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

  it('should fall through to normal transition when mergeVerified is false', () => {
    const hsm = getHSMDefinition('feature');
    // review has no normal transition to completed, so this should fail
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
    // delegate is inside 'implementation' compound
    const state = { phase: 'delegate', _cleanup: { mergeVerified: true }, _events: [], _history: {} };
    const result = executeTransition(hsm, state as Record<string, unknown>, 'completed');
    expect(result.success).toBe(true);
    // Should have exit effects from implementation compound
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
    // Should be idempotent
    expect(result.success).toBe(true);
    expect(result.idempotent).toBe(true);
  });
});

// ─── Task 3: Debug Escalation HSM Transition ────────────────────────────────

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

  it('debugHSM_InvestigateToCancelled_FailsWhenNoEscalation', () => {
    const hsm = getHSMDefinition('debug');
    const state: Record<string, unknown> = {
      phase: 'investigate',
      investigation: { rootCause: 'simple bug' },
      _events: [],
      _history: {},
    };

    // Note: cancel is a universal transition, so investigate → cancelled
    // via the escalation guard will fail, but universal cancel will succeed.
    // The guard-gated transition is distinct from universal cancel.
    // Let's verify the guard-gated transition is in the definition.
    const transition = hsm.transitions.find(
      (t) => t.from === 'investigate' && t.to === 'cancelled',
    );
    expect(transition).toBeDefined();
    expect(transition!.guard).toBeDefined();

    // Verify the guard fails for non-escalation state
    const guardResult = transition!.guard!.evaluate(state);
    expect(guardResult).not.toBe(true);
  });
});

// ─── Task 4: Plan Revision Termination HSM Transition ───────────────────────

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

  it('featureHSM_PlanReviewToBlocked_SucceedsWhenRevisionsExhausted', () => {
    const hsm = getHSMDefinition('feature');
    const state: Record<string, unknown> = {
      phase: 'plan-review',
      planReview: { revisionCount: 3 },
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
      _events: [],
      _history: {},
    };

    const result = executeTransition(hsm, state, 'blocked');

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('GUARD_FAILED');
  });
});

// ─── Task 8: Hotfix-Validate to Synthesize HSM Transition ───────────────────

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

    // Find indices of both transitions from hotfix-validate
    const synthIdx = transitions.findIndex(
      (t) => t.from === 'hotfix-validate' && t.to === 'synthesize',
    );
    const completedIdx = transitions.findIndex(
      (t) => t.from === 'hotfix-validate' && t.to === 'completed',
    );

    // synthesize transition must come before completed transition
    expect(synthIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThanOrEqual(0);
    expect(synthIdx).toBeLessThan(completedIdx);
  });
});
