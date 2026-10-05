import { describe, it, expect } from 'vitest';
import { FEATURE_PHASES, DebugPhaseSchema, RefactorPhaseSchema } from '../../../src/workflow/schemas.js';
import { getPlaybook, renderPlaybook, oneshotPlaybook } from '../../../src/workflow/playbooks.js';

describe('HSM-Playbook Coverage', () => {
  const workflowPhases: Record<string, readonly string[]> = {
    feature: FEATURE_PHASES,
    debug: DebugPhaseSchema.options,
    refactor: RefactorPhaseSchema.options,
  };

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
  it('compactGuidance_FeaturePlan_ContainsCompressionGuidance', () => {
    const playbook = getPlaybook('feature', 'plan');
    expect(playbook).not.toBeNull();
    const guidance = playbook!.compactGuidance.toLowerCase();
    const hasCompression = guidance.includes('compress') || guidance.includes('summary');
    expect(hasCompression).toBe(true);
  });

  it('compactGuidance_FeaturePlan_ContainsTwoStepDesign', () => {
    const playbook = getPlaybook('feature', 'plan');
    expect(playbook).not.toBeNull();
    const guidance = playbook!.compactGuidance.toLowerCase();
    expect(guidance.includes('reasoning')).toBe(true);
    expect(guidance.includes('format')).toBe(true);
  });

  it('compactGuidance_FeaturePlan_ContainsContextPackaging', () => {
    const playbook = getPlaybook('feature', 'plan');
    expect(playbook).not.toBeNull();
    const guidance = playbook!.compactGuidance.toLowerCase();
    const hasContext = guidance.includes('context package') || guidance.includes('self-contained');
    expect(hasContext).toBe(true);
  });

  it('compactGuidance_FeaturePlan_ContainsThreeStageDecomposition', () => {
    const playbook = getPlaybook('feature', 'plan');
    expect(playbook).not.toBeNull();
    const guidance = playbook!.compactGuidance.toLowerCase();
    expect(guidance.includes('logical')).toBe(true);
    expect(guidance.includes('concrete')).toBe(true);
    expect(guidance.includes('parallelization')).toBe(true);
  });

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

  it('compactGuidance_FeatureDelegate_ContainsContextScoping', () => {
    const playbook = getPlaybook('feature', 'delegate');
    expect(playbook).not.toBeNull();
    const guidance = playbook!.compactGuidance.toLowerCase();
    expect(guidance.includes('context package')).toBe(true);
  });

  it('compactGuidance_FeatureReview_ContainsTwoPassEvaluation', () => {
    const playbook = getPlaybook('feature', 'review');
    expect(playbook).not.toBeNull();
    const guidance = playbook!.compactGuidance.toLowerCase();
    const hasTwoPass = guidance.includes('two-pass') || guidance.includes('high-recall');
    expect(hasTwoPass).toBe(true);
  });

  it('compactGuidance_FeatureReview_ContainsReviewStrategy', () => {
    const playbook = getPlaybook('feature', 'review');
    expect(playbook).not.toBeNull();
    const guidance = playbook!.compactGuidance.toLowerCase();
    expect(guidance.includes('review-strategy')).toBe(true);
  });
});

/** The coverage suite above does not include oneshot, so these tests read the exported `oneshotPlaybook` array. */
describe('Oneshot playbook invariants', () => {
  const terminalPhases = ['completed', 'cancelled'];

  it('oneshotPlaybook_nonTerminalPhases_HaveNonEmptyTransitionCriteria', () => {
    const nonTerminal = oneshotPlaybook.filter(
      (p) => !terminalPhases.includes(p.phase),
    );
    expect(nonTerminal.length).toBeGreaterThan(0);
    for (const pb of nonTerminal) {
      expect(
        pb.transitionCriteria.length,
        `oneshot:${pb.phase} has empty transitionCriteria`,
      ).toBeGreaterThan(0);
    }
  });

  it('oneshotPlaybook_nonTerminalPhases_HaveGuardPrerequisites', () => {
    const nonTerminal = oneshotPlaybook.filter(
      (p) => !terminalPhases.includes(p.phase),
    );
    for (const pb of nonTerminal) {
      expect(
        pb.guardPrerequisites.length,
        `oneshot:${pb.phase} has empty guardPrerequisites`,
      ).toBeGreaterThan(0);
    }
  });

  /** The test builds the graph from the phase names that each `transitionCriteria` string holds. */
  it('oneshotPlaybook_AllPhasesReachableFromPlan', () => {
    const phases = new Set(oneshotPlaybook.map((p) => p.phase));
    expect(phases.has('plan')).toBe(true);

    const edges: Record<string, string[]> = {};
    for (const pb of oneshotPlaybook) {
      const next: string[] = [];
      for (const candidate of phases) {
        if (candidate === pb.phase) continue;
        const rx = new RegExp(`\\b${candidate}\\b`, 'i');
        if (rx.test(pb.transitionCriteria)) next.push(candidate);
      }
      edges[pb.phase] = next;
    }

    const visited = new Set<string>();
    const stack = ['plan'];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const n of edges[cur] ?? []) stack.push(n);
    }

    for (const phase of phases) {
      expect(
        visited.has(phase),
        `oneshot:${phase} is not reachable from plan via transitionCriteria graph`,
      ).toBe(true);
    }
  });

  it('oneshotPlaybook_CompletedReachableFromBothImplementingBranches', () => {
    const implementing = oneshotPlaybook.find((p) => p.phase === 'implementing');
    expect(implementing).toBeDefined();
    expect(implementing!.transitionCriteria).toMatch(/completed/i);
    expect(implementing!.transitionCriteria).toMatch(/synthesize/i);
    const synthesize = oneshotPlaybook.find((p) => p.phase === 'synthesize');
    expect(synthesize).toBeDefined();
    expect(synthesize!.transitionCriteria).toMatch(/completed/i);
  });

  it('oneshotPlaybook_RendersWithoutErrorForEveryPhase', () => {
    for (const pb of oneshotPlaybook) {
      expect(() => renderPlaybook(pb)).not.toThrow();
      const rendered = renderPlaybook(pb);
      expect(typeof rendered).toBe('string');
      expect(rendered.length).toBeGreaterThan(0);
    }
  });
});
