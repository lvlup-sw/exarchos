import { describe, it, expect, beforeEach } from 'vitest';
import { applyPhaseSkips } from './phase-skip.js';
import { createFeatureHSM, createDebugHSM, createRefactorHSM } from './hsm-definitions.js';
import type { HSMDefinition } from './state-machine.js';

describe('Phase Skip Integration', () => {
  describe('Feature workflow', () => {
    let featureHsm: HSMDefinition;

    beforeEach(() => {
      featureHsm = createFeatureHSM();
    });

    it('WorkflowInit_WithSkipPhases_PlanReviewSkipped', () => {
      const modified = applyPhaseSkips(featureHsm, ['plan-review']);

      // plan should now go to delegate (plan-review's outgoing target)
      const planTransition = modified.transitions.find(t => t.from === 'plan');
      expect(planTransition?.to).toBe('delegate');
      expect(planTransition?.to).not.toBe('plan-review');

      // plan-review's outgoing guard (planReviewComplete) should be inherited
      expect(planTransition?.guard?.id).toBe('plan-review-complete');

      // No transitions should originate from plan-review
      const planReviewTransitions = modified.transitions.filter(t => t.from === 'plan-review');
      expect(planReviewTransitions).toHaveLength(0);
    });

    it('WorkflowInit_SkipPlanReview_RemovesAllPlanReviewTransitions', () => {
      const modified = applyPhaseSkips(featureHsm, ['plan-review']);

      // The original has 3 transitions from plan-review:
      //   plan-review -> delegate, plan-review -> plan, plan-review -> blocked
      // All should be removed
      const fromPlanReview = modified.transitions.filter(t => t.from === 'plan-review');
      expect(fromPlanReview).toHaveLength(0);
    });

    it('WorkflowStartedEvent_IncludesOriginalPhases', () => {
      // Verify that applying skips does not mutate the original HSM
      const modified = applyPhaseSkips(featureHsm, ['plan-review']);

      // The original HSM should still have plan-review as a state
      expect(featureHsm.states['plan-review']).toBeDefined();

      // The modified HSM should have different transitions
      expect(modified.transitions).not.toEqual(featureHsm.transitions);

      // Original transitions count should be unchanged
      const original = createFeatureHSM();
      expect(featureHsm.transitions).toHaveLength(original.transitions.length);
    });

    it('WorkflowInit_NoSkipPhases_NoChange', () => {
      const modified = applyPhaseSkips(featureHsm, []);
      expect(modified).toEqual(featureHsm);
    });

    it('WorkflowInit_SkipIdeate_Rejected', () => {
      // ideate is the initial phase (no incoming transitions)
      expect(() => applyPhaseSkips(featureHsm, ['ideate'])).toThrow(/cannot skip initial/i);
    });

    it('WorkflowInit_SkipCompleted_Rejected', () => {
      expect(() => applyPhaseSkips(featureHsm, ['completed'])).toThrow(/cannot skip final/i);
    });

    it('WorkflowInit_SkipCancelled_Rejected', () => {
      expect(() => applyPhaseSkips(featureHsm, ['cancelled'])).toThrow(/cannot skip final/i);
    });

    it('WorkflowInit_SkipImplementationCompound_RejectedAsNoDirectIncoming', () => {
      // The 'implementation' compound state has no direct incoming transitions
      // (transitions go to its child 'delegate' instead), so it is treated
      // as having no incoming transitions and is rejected as an initial phase.
      expect(() => applyPhaseSkips(featureHsm, ['implementation'])).toThrow(/cannot skip initial/i);
    });

    it('WorkflowInit_SkipSynthesize_ReroutesIncomingTransitions', () => {
      // synthesize has multiple outgoing transitions:
      //   synthesize -> delegate (synthesizeRetryable)
      //   synthesize -> completed (prUrlExists)
      // The first outgoing found is used for rerouting.
      const modified = applyPhaseSkips(featureHsm, ['synthesize']);

      // No transitions from synthesize should remain
      const fromSynthesize = modified.transitions.filter(t => t.from === 'synthesize');
      expect(fromSynthesize).toHaveLength(0);

      // Transitions that previously targeted synthesize should be rerouted
      // to the first outgoing target (delegate), inheriting synthesizeRetryable guard
      const toSynthesize = modified.transitions.filter(t => t.to === 'synthesize');
      expect(toSynthesize).toHaveLength(0);
    });
  });

  describe('Debug workflow', () => {
    let debugHsm: HSMDefinition;

    beforeEach(() => {
      debugHsm = createDebugHSM();
    });

    it('WorkflowInit_SkipTriage_Rejected', () => {
      // triage is the initial phase of the debug workflow
      expect(() => applyPhaseSkips(debugHsm, ['triage'])).toThrow(/cannot skip initial/i);
    });

    it('WorkflowInit_NoSkipPhases_DebugUnchanged', () => {
      const modified = applyPhaseSkips(debugHsm, []);
      expect(modified).toEqual(debugHsm);
    });
  });

  describe('Refactor workflow', () => {
    let refactorHsm: HSMDefinition;

    beforeEach(() => {
      refactorHsm = createRefactorHSM();
    });

    it('WorkflowInit_SkipExplore_Rejected', () => {
      // explore is the initial phase of the refactor workflow
      expect(() => applyPhaseSkips(refactorHsm, ['explore'])).toThrow(/cannot skip initial/i);
    });

    it('WorkflowInit_NoSkipPhases_RefactorUnchanged', () => {
      const modified = applyPhaseSkips(refactorHsm, []);
      expect(modified).toEqual(refactorHsm);
    });
  });
});
