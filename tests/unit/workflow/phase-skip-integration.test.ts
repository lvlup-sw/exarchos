import { describe, it, expect, beforeEach } from 'vitest';
import { applyPhaseSkips } from '../../../src/workflow/phase-skip.js';
import { createFeatureHSM, createDebugHSM, createRefactorHSM } from '../../../src/workflow/hsm-definitions.js';
import type { HSMDefinition } from '../../../src/workflow/state-machine.js';

describe('Phase Skip Integration', () => {
  describe('Feature workflow', () => {
    let featureHsm: HSMDefinition;

    beforeEach(() => {
      featureHsm = createFeatureHSM();
    });

    it('WorkflowInit_WithSkipPhases_PlanReviewSkipped', () => {
      const modified = applyPhaseSkips(featureHsm, ['plan-review']);

      const planTransition = modified.transitions.find(t => t.from === 'plan');
      expect(planTransition?.to).toBe('delegate');
      expect(planTransition?.to).not.toBe('plan-review');

      expect(planTransition?.guard?.id).toBe('plan-review-complete');

      const planReviewTransitions = modified.transitions.filter(t => t.from === 'plan-review');
      expect(planReviewTransitions).toHaveLength(0);
    });

    it('WorkflowInit_SkipPlanReview_RemovesAllPlanReviewTransitions', () => {
      const modified = applyPhaseSkips(featureHsm, ['plan-review']);

      const fromPlanReview = modified.transitions.filter(t => t.from === 'plan-review');
      expect(fromPlanReview).toHaveLength(0);
    });

    /** Applying skips must not change the original HSM. */
    it('WorkflowStartedEvent_IncludesOriginalPhases', () => {
      const modified = applyPhaseSkips(featureHsm, ['plan-review']);

      expect(featureHsm.states['plan-review']).toBeDefined();

      expect(modified.transitions).not.toEqual(featureHsm.transitions);

      const original = createFeatureHSM();
      expect(featureHsm.transitions).toHaveLength(original.transitions.length);
    });

    it('WorkflowInit_NoSkipPhases_NoChange', () => {
      const modified = applyPhaseSkips(featureHsm, []);
      expect(modified).toEqual(featureHsm);
    });

    it('WorkflowInit_SkipPlan_Rejected', () => {
      expect(() => applyPhaseSkips(featureHsm, ['plan'])).toThrow(/cannot skip initial/i);
    });

    it('WorkflowInit_SkipCompleted_Rejected', () => {
      expect(() => applyPhaseSkips(featureHsm, ['completed'])).toThrow(/cannot skip final/i);
    });

    it('WorkflowInit_SkipCancelled_Rejected', () => {
      expect(() => applyPhaseSkips(featureHsm, ['cancelled'])).toThrow(/cannot skip final/i);
    });

    /**
     * Transitions enter the child `delegate`, not the `implementation` compound itself.
     * So the compound has no incoming transition, and the skip rejects it as an initial phase.
     */
    it('WorkflowInit_SkipImplementationCompound_RejectedAsNoDirectIncoming', () => {
      expect(() => applyPhaseSkips(featureHsm, ['implementation'])).toThrow(/cannot skip initial/i);
    });

    /** Each incoming transition of `synthesize` becomes one transition per outgoing target, so no edge to or from `synthesize` remains. */
    it('WorkflowInit_SkipSynthesize_ReroutesIncomingTransitions', () => {
      const modified = applyPhaseSkips(featureHsm, ['synthesize']);

      const fromSynthesize = modified.transitions.filter(t => t.from === 'synthesize');
      expect(fromSynthesize).toHaveLength(0);

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
      expect(() => applyPhaseSkips(refactorHsm, ['explore'])).toThrow(/cannot skip initial/i);
    });

    it('WorkflowInit_NoSkipPhases_RefactorUnchanged', () => {
      const modified = applyPhaseSkips(refactorHsm, []);
      expect(modified).toEqual(refactorHsm);
    });
  });
});
