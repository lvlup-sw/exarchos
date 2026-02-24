import { describe, it, expect } from 'vitest';
import { getPlaybook, renderPlaybook } from './playbooks.js';

// ─── Task 1: Core getPlaybook / renderPlaybook ──────────────────────────────

describe('getPlaybook', () => {
  it('getPlaybook_ValidPhase_ReturnsPlaybook', () => {
    const playbook = getPlaybook('feature', 'ideate');
    expect(playbook).not.toBeNull();
  });

  it('getPlaybook_UnknownPhase_ReturnsNull', () => {
    const playbook = getPlaybook('feature', 'nonexistent');
    expect(playbook).toBeNull();
  });

  it('getPlaybook_TerminalPhase_ReturnsMinimalPlaybook', () => {
    const playbook = getPlaybook('feature', 'completed');
    expect(playbook).not.toBeNull();
    expect(playbook!.tools).toHaveLength(0);
  });
});

describe('renderPlaybook', () => {
  it('renderPlaybook_DelegatePhase_IncludesToolsAndEvents', () => {
    const playbook = getPlaybook('feature', 'delegate')!;
    const rendered = renderPlaybook(playbook);
    expect(rendered).toContain('exarchos_workflow');
    expect(rendered).toContain('task.assigned');
  });

  it('renderPlaybook_TerminalPhase_ReturnsMinimalGuidance', () => {
    const playbook = getPlaybook('feature', 'completed')!;
    const rendered = renderPlaybook(playbook);
    expect(rendered.length).toBeLessThan(300);
  });
});

// ─── Task 2: Feature Workflow Playbook Entries ──────────────────────────────

describe('Feature workflow playbooks', () => {
  it('getPlaybook_FeatureIdeate_HasBrainstormingSkill', () => {
    const playbook = getPlaybook('feature', 'ideate')!;
    expect(playbook.skill).toBe('brainstorming');
  });

  it('getPlaybook_FeaturePlan_HasPlanningSkill', () => {
    const playbook = getPlaybook('feature', 'plan')!;
    expect(playbook.skill).toBe('implementation-planning');
  });

  it('getPlaybook_FeaturePlanReview_IsHumanCheckpoint', () => {
    const playbook = getPlaybook('feature', 'plan-review')!;
    expect(playbook.humanCheckpoint).toBe(true);
  });

  it('getPlaybook_FeatureDelegate_HasEventInstructions', () => {
    const playbook = getPlaybook('feature', 'delegate')!;
    expect(playbook.events.length).toBeGreaterThanOrEqual(3);
  });

  it('getPlaybook_FeatureReview_HasStaticAnalysisScript', () => {
    const playbook = getPlaybook('feature', 'review')!;
    const hasStaticAnalysis = playbook.validationScripts.some((s) =>
      s.includes('static-analysis'),
    );
    expect(hasStaticAnalysis).toBe(true);
  });

  it('getPlaybook_FeatureSynthesize_HasPreSynthesisScript', () => {
    const playbook = getPlaybook('feature', 'synthesize')!;
    const hasPreSynthesis = playbook.validationScripts.some((s) =>
      s.includes('pre-synthesis'),
    );
    expect(hasPreSynthesis).toBe(true);
  });

  it('getPlaybook_FeatureSynthesize_IsHumanCheckpoint', () => {
    const playbook = getPlaybook('feature', 'synthesize')!;
    expect(playbook.humanCheckpoint).toBe(true);
  });

  it('getPlaybook_FeatureCompleted_IsMinimal', () => {
    const playbook = getPlaybook('feature', 'completed')!;
    expect(playbook.tools).toHaveLength(0);
  });

  it('getPlaybook_FeatureCancelled_IsMinimal', () => {
    const playbook = getPlaybook('feature', 'cancelled')!;
    expect(playbook.tools).toHaveLength(0);
  });

  it('getPlaybook_FeatureBlocked_HasUnblockGuidance', () => {
    const playbook = getPlaybook('feature', 'blocked')!;
    const guidance = playbook.compactGuidance.toLowerCase();
    expect(guidance.includes('block') || guidance.includes('wait')).toBe(true);
  });
});

// ─── Task 3: Debug Workflow Playbook Entries ────────────────────────────────

describe('Debug workflow playbooks', () => {
  it('getPlaybook_DebugTriage_HasDebugSkill', () => {
    const playbook = getPlaybook('debug', 'triage')!;
    expect(playbook.skill).toBe('debug');
  });

  it('getPlaybook_DebugInvestigate_HasDebugSkill', () => {
    const playbook = getPlaybook('debug', 'investigate')!;
    expect(playbook.skill).toBe('debug');
  });

  it('getPlaybook_DebugRca_HasRcaArtifactGuard', () => {
    const playbook = getPlaybook('debug', 'rca')!;
    expect(playbook.guardPrerequisites.toLowerCase()).toContain('rca');
  });

  it('getPlaybook_DebugDesign_HasFixDesignGuard', () => {
    const playbook = getPlaybook('debug', 'design')!;
    const guard = playbook.guardPrerequisites.toLowerCase();
    expect(guard.includes('fixdesign') || guard.includes('design')).toBe(true);
  });

  it('getPlaybook_DebugImplement_HasDebugSkill', () => {
    const playbook = getPlaybook('debug', 'debug-implement')!;
    expect(playbook.skill).toBe('debug');
  });

  it('getPlaybook_DebugValidate_HasValidationGuidance', () => {
    const playbook = getPlaybook('debug', 'debug-validate')!;
    expect(playbook.compactGuidance.toLowerCase()).toContain('validat');
  });

  it('getPlaybook_DebugReview_HasReviewGuidance', () => {
    const playbook = getPlaybook('debug', 'debug-review')!;
    expect(playbook.compactGuidance.toLowerCase()).toContain('review');
  });

  it('getPlaybook_HotfixImplement_HasDebugSkill', () => {
    const playbook = getPlaybook('debug', 'hotfix-implement')!;
    expect(playbook.skill).toBe('debug');
  });

  it('getPlaybook_HotfixValidate_HasDebugSkill', () => {
    const playbook = getPlaybook('debug', 'hotfix-validate')!;
    expect(playbook.skill).toBe('debug');
  });

  it('getPlaybook_DebugSynthesize_IsHumanCheckpoint', () => {
    const playbook = getPlaybook('debug', 'synthesize')!;
    expect(playbook.humanCheckpoint).toBe(true);
  });
});

// ─── Task 4: Refactor Workflow Playbook Entries ─────────────────────────────

describe('Refactor workflow playbooks', () => {
  it('getPlaybook_RefactorExplore_HasRefactorSkill', () => {
    const playbook = getPlaybook('refactor', 'explore')!;
    expect(playbook.skill).toBe('refactor');
  });

  it('getPlaybook_RefactorBrief_HasRefactorSkill', () => {
    const playbook = getPlaybook('refactor', 'brief')!;
    expect(playbook.skill).toBe('refactor');
  });

  it('getPlaybook_PolishImplement_HasRefactorSkill', () => {
    const playbook = getPlaybook('refactor', 'polish-implement')!;
    expect(playbook.skill).toBe('refactor');
  });

  it('getPlaybook_PolishValidate_HasRefactorSkill', () => {
    const playbook = getPlaybook('refactor', 'polish-validate')!;
    expect(playbook.skill).toBe('refactor');
  });

  it('getPlaybook_PolishUpdateDocs_IsHumanCheckpoint', () => {
    const playbook = getPlaybook('refactor', 'polish-update-docs')!;
    expect(playbook.humanCheckpoint).toBe(true);
  });

  it('getPlaybook_OverhaulPlan_HasPlanSkill', () => {
    const playbook = getPlaybook('refactor', 'overhaul-plan')!;
    expect(playbook.skill).toBe('implementation-planning');
  });

  it('getPlaybook_OverhaulDelegate_HasDelegationSkill', () => {
    const playbook = getPlaybook('refactor', 'overhaul-delegate')!;
    expect(playbook.skill).toBe('delegation');
  });

  it('getPlaybook_OverhaulReview_HasReviewSkill', () => {
    const playbook = getPlaybook('refactor', 'overhaul-review')!;
    expect(playbook.skill).toBe('quality-review');
  });

  it('getPlaybook_OverhaulUpdateDocs_HasRefactorSkill', () => {
    const playbook = getPlaybook('refactor', 'overhaul-update-docs')!;
    expect(playbook.skill).toBe('refactor');
  });

  it('getPlaybook_RefactorSynthesize_HasSynthesisSkill', () => {
    const playbook = getPlaybook('refactor', 'synthesize')!;
    expect(playbook.skill).toBe('synthesis');
  });

  it('getPlaybook_RefactorSynthesize_IsHumanCheckpoint', () => {
    const playbook = getPlaybook('refactor', 'synthesize')!;
    expect(playbook.humanCheckpoint).toBe(true);
  });
});
