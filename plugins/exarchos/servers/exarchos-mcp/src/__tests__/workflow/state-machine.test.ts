import { describe, it, expect } from 'vitest';
import {
  getHSMDefinition,
  executeTransition,
  getValidTransitions,
} from '../../workflow/state-machine.js';
import type { HSMDefinition } from '../../workflow/state-machine.js';

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

      expect(hsm.states['integrate']).toBeDefined();
      expect(hsm.states['integrate'].type).toBe('atomic');
      expect(hsm.states['integrate'].parent).toBe('implementation');

      expect(hsm.states['review']).toBeDefined();
      expect(hsm.states['review'].type).toBe('atomic');
      expect(hsm.states['review'].parent).toBe('implementation');
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

      // delegate → integrate
      const delegateToIntegrate = transitions.find(
        (t) => t.from === 'delegate' && t.to === 'integrate'
      );
      expect(delegateToIntegrate).toBeDefined();
      expect(delegateToIntegrate!.guard!.id).toBe('all-tasks-complete');

      // integrate → review
      const integrateToReview = transitions.find(
        (t) => t.from === 'integrate' && t.to === 'review'
      );
      expect(integrateToReview).toBeDefined();
      expect(integrateToReview!.guard!.id).toBe('integration-passed');

      // integrate → delegate (fix cycle)
      const integrateToDelegate = transitions.find(
        (t) => t.from === 'integrate' && t.to === 'delegate'
      );
      expect(integrateToDelegate).toBeDefined();
      expect(integrateToDelegate!.guard!.id).toBe('integration-failed');
      expect(integrateToDelegate!.isFixCycle).toBe(true);

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

      // OverhaulTrack children: plan, delegate, integrate, review, update-docs
      for (const child of [
        'overhaul-plan',
        'overhaul-delegate',
        'overhaul-integrate',
        'overhaul-review',
        'overhaul-update-docs',
      ]) {
        expect(hsm.states[child]).toBeDefined();
        expect(hsm.states[child].parent).toBe('overhaul-track');
      }

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

      // Overhaul track flow
      expect(
        transitions.find(
          (t) => t.from === 'overhaul-plan' && t.to === 'overhaul-delegate'
        )
      ).toBeDefined();
      expect(
        transitions.find(
          (t) =>
            t.from === 'overhaul-delegate' && t.to === 'overhaul-integrate'
        )
      ).toBeDefined();
      expect(
        transitions.find(
          (t) =>
            t.from === 'overhaul-integrate' && t.to === 'overhaul-review'
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

      // Overhaul fix cycles
      const integrateToDelegate = transitions.find(
        (t) =>
          t.from === 'overhaul-integrate' && t.to === 'overhaul-delegate'
      );
      expect(integrateToDelegate).toBeDefined();
      expect(integrateToDelegate!.isFixCycle).toBe(true);

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
        'integrate',
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
        phase: 'integrate',
        integration: { passed: false },
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
        from: 'integrate',
        to: 'delegate',
        trigger: 'test',
        metadata: { compoundStateId: 'implementation' },
      }));

      const state: Record<string, unknown> = {
        phase: 'integrate',
        integration: { passed: false },
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
      const result = executeTransition(hsm, state, 'integrate');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GUARD_FAILED');
      expect(result.errorMessage).toContain('Guard');
    });
  });

  describe('getValidTransitions', () => {
    it('returns valid target phases from a given phase', () => {
      const hsm = getHSMDefinition('feature');
      const targets = getValidTransitions(hsm, 'ideate');

      expect(targets).toContain('plan');
      expect(targets).toContain('cancelled');
    });

    it('returns empty array for final states', () => {
      const hsm = getHSMDefinition('feature');
      const targets = getValidTransitions(hsm, 'completed');

      expect(targets).toEqual([]);
    });
  });
});
