import { describe, it, expect } from 'vitest';
import { FeaturePhaseSchema, DebugPhaseSchema, RefactorPhaseSchema } from './schemas.js';
import { getPlaybook, renderPlaybook } from './playbooks.js';

describe('HSM-Playbook Coverage', () => {
  const workflowPhases: Record<string, readonly string[]> = {
    feature: FeaturePhaseSchema.options,
    debug: DebugPhaseSchema.options,
    refactor: RefactorPhaseSchema.options,
  };

  // Test: every HSM state has a playbook entry
  for (const [workflowType, phases] of Object.entries(workflowPhases)) {
    for (const phase of phases) {
      it(`allHsmStates_HavePlaybook_${workflowType}_${phase}`, () => {
        const playbook = getPlaybook(workflowType, phase);
        expect(playbook).not.toBeNull();
        expect(playbook!.phase).toBe(phase);
        expect(playbook!.workflowType).toBe(workflowType);
      });
    }
  }

  // Test: non-terminal playbooks have adequate compactGuidance
  const terminalPhases = ['completed', 'cancelled'];
  for (const [workflowType, phases] of Object.entries(workflowPhases)) {
    for (const phase of phases) {
      if (terminalPhases.includes(phase)) continue;

      it(`compactGuidance_MentionsTool_${workflowType}_${phase}`, () => {
        const playbook = getPlaybook(workflowType, phase);
        expect(playbook).not.toBeNull();
        if (playbook!.tools.length > 0) {
          const mentionsTool = playbook.tools.some((t) =>
            playbook.compactGuidance.includes(t.tool),
          );
          expect(mentionsTool).toBe(true);
        }
      });

      it(`renderPlaybook_ContainsAllToolNames_${workflowType}_${phase}`, () => {
        const playbook = getPlaybook(workflowType, phase);
        expect(playbook).not.toBeNull();
        const rendered = renderPlaybook(playbook!);
        for (const tool of playbook.tools) {
          expect(rendered).toContain(tool.tool);
        }
      });

      it(`renderPlaybook_ContainsAllEventTypes_${workflowType}_${phase}`, () => {
        const playbook = getPlaybook(workflowType, phase);
        expect(playbook).not.toBeNull();
        const rendered = renderPlaybook(playbook!);
        for (const event of playbook.events) {
          expect(rendered).toContain(event.type);
        }
      });
    }
  }

  // Test: human checkpoint playbooks mention wait/pause/confirm
  for (const [workflowType, phases] of Object.entries(workflowPhases)) {
    for (const phase of phases) {
      const playbook = getPlaybook(workflowType, phase);
      if (!playbook || !playbook.humanCheckpoint) continue;

      it(`humanCheckpoint_GuidanceMentionsWait_${workflowType}_${phase}`, () => {
        const guidance = playbook!.compactGuidance.toLowerCase();
        const mentionsWait = ['wait', 'pause', 'confirm', 'checkpoint', 'human'].some(
          (w) => guidance.includes(w),
        );
        expect(mentionsWait).toBe(true);
      });
    }
  }
});

describe('Neuroanatomy pattern enrichment', () => {
  // DR-13/DR-14: Compression + carry-forward in ideate
  it('compactGuidance_FeatureIdeate_ContainsCompressionGuidance', () => {
    const playbook = getPlaybook('feature', 'ideate');
    expect(playbook).not.toBeNull();
    const guidance = playbook!.compactGuidance.toLowerCase();
    const hasCompression = guidance.includes('compress') || guidance.includes('summary');
    expect(hasCompression).toBe(true);
  });

  // DR-7: Two-step design in ideate
  it('compactGuidance_FeatureIdeate_ContainsTwoStepDesign', () => {
    const playbook = getPlaybook('feature', 'ideate');
    expect(playbook).not.toBeNull();
    const guidance = playbook!.compactGuidance.toLowerCase();
    expect(guidance.includes('reasoning')).toBe(true);
    expect(guidance.includes('format')).toBe(true);
  });

  // DR-13/DR-14: Context packaging in plan
  it('compactGuidance_FeaturePlan_ContainsContextPackaging', () => {
    const playbook = getPlaybook('feature', 'plan');
    expect(playbook).not.toBeNull();
    const guidance = playbook!.compactGuidance.toLowerCase();
    const hasContext = guidance.includes('context package') || guidance.includes('self-contained');
    expect(hasContext).toBe(true);
  });

  // DR-8: Three-stage decomposition in plan
  it('compactGuidance_FeaturePlan_ContainsThreeStageDecomposition', () => {
    const playbook = getPlaybook('feature', 'plan');
    expect(playbook).not.toBeNull();
    const guidance = playbook!.compactGuidance.toLowerCase();
    expect(guidance.includes('logical')).toBe(true);
    expect(guidance.includes('concrete')).toBe(true);
    expect(guidance.includes('parallelization')).toBe(true);
  });

  // DR-15: Self-consistency in plan-review
  it('compactGuidance_FeaturePlanReview_ContainsSelfConsistency', () => {
    const playbook = getPlaybook('feature', 'plan-review');
    expect(playbook).not.toBeNull();
    const guidance = playbook!.compactGuidance.toLowerCase();
    const hasSelfConsistency =
      guidance.includes('varied framing') ||
      guidance.includes('self-consistency') ||
      guidance.includes('3 framings');
    expect(hasSelfConsistency).toBe(true);
  });

  // DR-10/DR-11: Effort classification in delegate
  it('compactGuidance_FeatureDelegate_ContainsEffortClassification', () => {
    const playbook = getPlaybook('feature', 'delegate');
    expect(playbook).not.toBeNull();
    const guidance = playbook!.compactGuidance.toLowerCase();
    const hasClassification =
      guidance.includes('classify') ||
      guidance.includes('complexity') ||
      guidance.includes('task-classification');
    expect(hasClassification).toBe(true);
  });

  // DR-13/DR-14: Context scoping in delegate
  it('compactGuidance_FeatureDelegate_ContainsContextScoping', () => {
    const playbook = getPlaybook('feature', 'delegate');
    expect(playbook).not.toBeNull();
    const guidance = playbook!.compactGuidance.toLowerCase();
    expect(guidance.includes('context package')).toBe(true);
  });

  // DR-9: Two-pass evaluation in review
  it('compactGuidance_FeatureReview_ContainsTwoPassEvaluation', () => {
    const playbook = getPlaybook('feature', 'review');
    expect(playbook).not.toBeNull();
    const guidance = playbook!.compactGuidance.toLowerCase();
    const hasTwoPass = guidance.includes('two-pass') || guidance.includes('high-recall');
    expect(hasTwoPass).toBe(true);
  });

  // DR-9: Review strategy runbook reference in review
  it('compactGuidance_FeatureReview_ContainsReviewStrategy', () => {
    const playbook = getPlaybook('feature', 'review');
    expect(playbook).not.toBeNull();
    const guidance = playbook!.compactGuidance.toLowerCase();
    expect(guidance.includes('review-strategy')).toBe(true);
  });
});
