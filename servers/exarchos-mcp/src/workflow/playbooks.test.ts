import { describe, it, expect } from 'vitest';
import { getPlaybook, renderPlaybook, serializePlaybooks, listPlaybookWorkflowTypes } from './playbooks.js';
import type { SerializedPlaybooks, SerializedPhasePlaybook } from './playbooks.js';

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

  it('getPlaybook_FeatureReview_HasEmptyValidationScripts', () => {
    const playbook = getPlaybook('feature', 'review')!;
    expect(playbook.validationScripts).toEqual([]);
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

  it('getPlaybook_HotfixValidate_IsHumanCheckpoint', () => {
    const playbook = getPlaybook('debug', 'hotfix-validate')!;
    expect(playbook.humanCheckpoint).toBe(true);
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

// ─── Task 5: Graphite Removal from Synthesize Playbooks ──────────────────────

describe('Synthesize phase guidance references GitHub CLI', () => {
  it('playbookGuidance_FeatureSynthesizePhase_ReferencesGhCli', () => {
    const playbook = getPlaybook('feature', 'synthesize')!;
    expect(playbook.compactGuidance).not.toContain('Graphite');
    expect(playbook.compactGuidance).toContain('GitHub CLI');
  });

  it('playbookGuidance_DebugSynthesizePhase_ReferencesGhCli', () => {
    const playbook = getPlaybook('debug', 'synthesize')!;
    expect(playbook.compactGuidance).not.toContain('Graphite');
    expect(playbook.compactGuidance).toContain('GitHub CLI');
  });

  it('playbookGuidance_RefactorSynthesizePhase_ReferencesGhCli', () => {
    const playbook = getPlaybook('refactor', 'synthesize')!;
    expect(playbook.compactGuidance).not.toContain('Graphite');
    expect(playbook.compactGuidance).toContain('GitHub CLI');
  });
});

// ─── Task 5: Playbook Serialization ──────────────────────────────────────────

describe('serializePlaybooks', () => {
  it('SerializePlaybooks_Feature_ReturnsAllPhases', () => {
    const result: SerializedPlaybooks = serializePlaybooks('feature');

    expect(result.workflowType).toBe('feature');

    const expectedPhases = [
      'ideate', 'plan', 'plan-review', 'delegate',
      'review', 'synthesize', 'completed', 'cancelled', 'blocked',
    ];
    for (const phase of expectedPhases) {
      expect(result.phases).toHaveProperty(phase);
    }
    expect(result.phaseCount).toBe(expectedPhases.length);

    // Verify structure of a representative phase
    const ideate: SerializedPhasePlaybook = result.phases['ideate'];
    expect(ideate.skill).toBe('brainstorming');
    expect(ideate.skillRef).toBe('@skills/brainstorming/SKILL.md');
    expect(ideate.tools.length).toBeGreaterThanOrEqual(1);
    expect(ideate.transitionCriteria).toBeTruthy();
    expect(ideate.humanCheckpoint).toBe(false);
    expect(typeof ideate.compactGuidance).toBe('string');
  });

  it('SerializePlaybooks_Unknown_Throws', () => {
    expect(() => serializePlaybooks('nonexistent')).toThrow();
  });
});

describe('listPlaybookWorkflowTypes', () => {
  it('ListPlaybookWorkflowTypes_ReturnsKnownTypes', () => {
    const types = listPlaybookWorkflowTypes();
    expect(types).toContain('feature');
    expect(types).toContain('debug');
    expect(types).toContain('refactor');
    expect(types.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── DR-5: EventInstruction fields + compactGuidance describe hint ──────────

describe('EventInstruction fields property', () => {
  it('EventInstruction_GateExecuted_HasRequiredFields', () => {
    const playbooks = serializePlaybooks('feature');
    // Find any phase with a gate.executed event
    const phasesWithGateExecuted = Object.entries(playbooks.phases).filter(
      ([, pb]) => pb.events.some((e) => e.type === 'gate.executed'),
    );
    expect(phasesWithGateExecuted.length).toBeGreaterThan(0);
    for (const [, pb] of phasesWithGateExecuted) {
      const gateEvent = pb.events.find((e) => e.type === 'gate.executed');
      expect(gateEvent).toBeDefined();
      expect((gateEvent as { fields?: readonly string[] }).fields).toBeDefined();
      const fields = (gateEvent as { fields?: readonly string[] }).fields!;
      expect(fields).toContain('gateName');
      expect(fields).toContain('layer');
      expect(fields).toContain('passed');
    }
  });

  it('EventInstruction_TaskAssigned_HasRequiredFields', () => {
    const playbooks = serializePlaybooks('feature');
    const phasesWithTaskAssigned = Object.entries(playbooks.phases).filter(
      ([, pb]) => pb.events.some((e) => e.type === 'task.assigned'),
    );
    expect(phasesWithTaskAssigned.length).toBeGreaterThan(0);
    for (const [, pb] of phasesWithTaskAssigned) {
      const taskEvent = pb.events.find((e) => e.type === 'task.assigned');
      expect(taskEvent).toBeDefined();
      const fields = (taskEvent as { fields?: readonly string[] }).fields!;
      expect(fields).toBeDefined();
      expect(fields).toContain('taskId');
    }
  });
});

describe('compactGuidance describe hint', () => {
  it('Playbook_CompactGuidance_ContainsDescribeHint', () => {
    const playbooks = serializePlaybooks('feature');
    // Find phases that have events to emit
    const phasesWithEvents = Object.entries(playbooks.phases).filter(
      ([, pb]) => pb.events.length > 0,
    );
    expect(phasesWithEvents.length).toBeGreaterThan(0);
    for (const [, pb] of phasesWithEvents) {
      const guidance = pb.compactGuidance.toLowerCase();
      expect(
        guidance.includes('describe') || guidance.includes('exarchos_event'),
        `Expected compactGuidance to reference describe or exarchos_event for phase with events`,
      ).toBe(true);
    }
  });
});

// ─── DR-6: review.completed in review phase playbook ─────────────────────────

describe('review.completed in review phase', () => {
  it('ReviewPlaybook_Events_IncludesReviewCompleted', () => {
    const playbooks = serializePlaybooks('feature');
    const reviewPhase = playbooks.phases['review'];
    expect(reviewPhase).toBeDefined();
    const hasReviewCompleted = reviewPhase.events.some((e) => e.type === 'review.completed');
    expect(hasReviewCompleted).toBe(true);
  });
});

// ─── DR-4: compactGuidance drift tests ──────────────────────────────────────

describe('compactGuidance drift tests', () => {
  const terminalPhases = ['completed', 'cancelled'];
  const blockedPhases = ['blocked'];

  function getAllPlaybooks(): Array<{ workflowType: string; phase: string; guidance: string; skillRef: string }> {
    const result: Array<{ workflowType: string; phase: string; guidance: string; skillRef: string }> = [];
    const types = listPlaybookWorkflowTypes();
    for (const wt of types) {
      const serialized = serializePlaybooks(wt);
      for (const [phase, pb] of Object.entries(serialized.phases)) {
        result.push({ workflowType: wt, phase, guidance: pb.compactGuidance, skillRef: pb.skillRef });
      }
    }
    return result;
  }

  it('compactGuidance_AllNonTerminalPhases_Under750Chars', () => {
    const playbooks = getAllPlaybooks();
    const nonTerminal = playbooks.filter((p) => !terminalPhases.includes(p.phase));
    expect(nonTerminal.length).toBeGreaterThan(0);
    for (const p of nonTerminal) {
      expect(
        p.guidance.length,
        `${p.workflowType}:${p.phase} compactGuidance is ${p.guidance.length} chars, exceeds 750`,
      ).toBeLessThanOrEqual(750);
    }
  });

  it('compactGuidance_AllRegisteredPlaybooks_HaveGuidance', () => {
    const playbooks = getAllPlaybooks();
    expect(playbooks.length).toBeGreaterThan(0);
    for (const p of playbooks) {
      expect(
        p.guidance.length,
        `${p.workflowType}:${p.phase} has empty compactGuidance`,
      ).toBeGreaterThan(0);
    }
  });

  it('compactGuidance_NonTerminalNonBlockedPhases_ExceedsMinLength', () => {
    const playbooks = getAllPlaybooks();
    const active = playbooks.filter(
      (p) => !terminalPhases.includes(p.phase) && !blockedPhases.includes(p.phase),
    );
    expect(active.length).toBeGreaterThan(0);
    for (const p of active) {
      // Skill-ref playbooks delegate guidance to the referenced skill — skip min-length check
      if (p.skillRef) continue;
      expect(
        p.guidance.length,
        `${p.workflowType}:${p.phase} compactGuidance is ${p.guidance.length} chars, below 200 minimum`,
      ).toBeGreaterThanOrEqual(200);
    }
  });

  it('compactGuidance_AllNonTerminalNonBlockedPhases_MentionsToolOrAction', () => {
    const playbooks = getAllPlaybooks();
    const active = playbooks.filter(
      (p) => !terminalPhases.includes(p.phase) && !blockedPhases.includes(p.phase),
    );
    const toolOrActionPattern =
      /exarchos_workflow|exarchos_event|exarchos_orchestrate|exarchos_view|exarchos_sync|transition|emit|record|dispatch/i;
    expect(active.length).toBeGreaterThan(0);
    for (const p of active) {
      // Skill-ref playbooks delegate guidance to the referenced skill — skip tool/action check
      if (p.skillRef) continue;
      expect(
        toolOrActionPattern.test(p.guidance),
        `${p.workflowType}:${p.phase} compactGuidance does not mention any tool or action keyword`,
      ).toBe(true);
    }
  });
});
