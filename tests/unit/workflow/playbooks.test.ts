import { describe, it, expect, vi } from 'vitest';
import {
  getPlaybook,
  renderPlaybook,
  serializePlaybooks,
  listPlaybookWorkflowTypes,
  oneshotPlaybook,
  workflowPlaybooks,
} from '../../../src/workflow/playbooks.js';
import type { SerializedPlaybooks, SerializedPhasePlaybook } from '../../../src/workflow/playbooks.js';
import { phaseRuntimeEmissions } from '../../../src/workflow/topology/phase-events.js';
import {
  getRequiredReviews,
  getRequiredReviewsPrerequisite,
  REQUIRED_REVIEWS_BY_WORKFLOW_TYPE,
} from '../../../src/workflow/review-contract.js';

describe('getPlaybook', () => {
  it('getPlaybook_ValidPhase_ReturnsPlaybook', () => {
    const playbook = getPlaybook('feature', 'plan');
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

  /** The render must list `task.completed` and `task.failed` apart from `events:`, so the model does not emit them itself. */
  it('renderPlaybook_DelegatePhase_IncludesAutoEmittedEvents', () => {
    const playbook = getPlaybook('feature', 'delegate')!;
    const rendered = renderPlaybook(playbook);
    expect(rendered).toMatch(/Auto-?emitted|auto[- ]emit/i);
    expect(rendered).toContain('task.completed');
    expect(rendered).toContain('task.failed');
    expect(rendered).toContain('exarchos_orchestrate task_complete');
  });
});

describe('Feature workflow playbooks', () => {
  it('getPlaybook_FeaturePlan_HasPlanningSkill', () => {
    const playbook = getPlaybook('feature', 'plan')!;
    expect(playbook.skill).toBe('plan');
  });

  /**
   * `plan` is the initial phase of the feature HSM, and it authors both the design and the decomposition sections.
   * So its guidance must hold the design-authoring half, not only the decomposition half.
   */
  it('getPlaybook_FeaturePlan_FoldsDesignAuthoringGuidance', () => {
    const playbook = getPlaybook('feature', 'plan')!;
    expect(playbook.compactGuidance).toContain('@skills/ideate/SKILL.md');
    expect(playbook.compactGuidance).toContain('Design & Rationale');
    expect(playbook.compactGuidance.toLowerCase()).toContain('parallelization');
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
      s.includes('pre_synthesis'),
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

  /**
   * The design phase is the design-time step of a debug workflow.
   * Its guidance must point at the Constraints step of `.exarchos/invariants.md`, so the constraint survives a compacted resume.
   * It must name `invariants.catalogs` and must not name `devCatalog`.
   */
  it('getPlaybook_DebugDesign_CompactGuidanceReferencesDesignTimeConstraints', () => {
    const playbook = getPlaybook('debug', 'design')!;
    expect(playbook.compactGuidance).toContain('.exarchos/invariants.md');
    expect(playbook.compactGuidance.toLowerCase()).toContain('constraints');
    expect(playbook.compactGuidance.toLowerCase()).toContain(
      'invariants.catalogs',
    );
    expect(playbook.compactGuidance.toLowerCase()).not.toContain('devcatalog');
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

describe('Refactor workflow playbooks', () => {
  it('getPlaybook_RefactorExplore_HasRefactorSkill', () => {
    const playbook = getPlaybook('refactor', 'explore')!;
    expect(playbook.skill).toBe('refactor');
  });

  it('getPlaybook_RefactorBrief_HasRefactorSkill', () => {
    const playbook = getPlaybook('refactor', 'brief')!;
    expect(playbook.skill).toBe('refactor');
  });

  /**
   * The brief phase is the design-time step of a refactor workflow.
   * Its guidance must point at the Constraints step of `.exarchos/invariants.md`, so the constraint survives a compacted resume.
   * It must name `invariants.catalogs` and must not name `devCatalog`.
   */
  it('getPlaybook_RefactorBrief_CompactGuidanceReferencesDesignTimeConstraints', () => {
    const playbook = getPlaybook('refactor', 'brief')!;
    expect(playbook.compactGuidance).toContain('.exarchos/invariants.md');
    expect(playbook.compactGuidance.toLowerCase()).toContain('constraints');
    expect(playbook.compactGuidance.toLowerCase()).toContain(
      'invariants.catalogs',
    );
    expect(playbook.compactGuidance.toLowerCase()).not.toContain('devcatalog');
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
    expect(playbook.skill).toBe('plan');
  });

  it('getPlaybook_OverhaulDelegate_HasDelegationSkill', () => {
    const playbook = getPlaybook('refactor', 'overhaul-delegate')!;
    expect(playbook.skill).toBe('delegate');
  });

  it('getPlaybook_OverhaulReview_HasReviewSkill', () => {
    const playbook = getPlaybook('refactor', 'overhaul-review')!;
    expect(playbook.skill).toBe('review');
    expect(playbook.skillRef).toBe('@skills/review/SKILL.md');
  });

  it('getPlaybook_OverhaulUpdateDocs_HasRefactorSkill', () => {
    const playbook = getPlaybook('refactor', 'overhaul-update-docs')!;
    expect(playbook.skill).toBe('refactor');
  });

  it('getPlaybook_RefactorSynthesize_HasSynthesisSkill', () => {
    const playbook = getPlaybook('refactor', 'synthesize')!;
    expect(playbook.skill).toBe('synthesize');
  });

  it('getPlaybook_RefactorSynthesize_IsHumanCheckpoint', () => {
    const playbook = getPlaybook('refactor', 'synthesize')!;
    expect(playbook.humanCheckpoint).toBe(true);
  });
});

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

describe('serializePlaybooks', () => {
  it('SerializePlaybooks_Feature_ReturnsAllPhases', () => {
    const result: SerializedPlaybooks = serializePlaybooks('feature');

    expect(result.workflowType).toBe('feature');

    const expectedPhases = [
      'plan', 'plan-review', 'delegate',
      'merge-pending',
      'review', 'synthesize', 'completed', 'cancelled', 'blocked',
    ];
    for (const phase of expectedPhases) {
      expect(result.phases).toHaveProperty(phase);
    }
    expect(result.phaseCount).toBe(expectedPhases.length);

    const plan: SerializedPhasePlaybook = result.phases['plan'];
    expect(plan.skill).toBe('plan');
    expect(plan.skillRef).toBe('@skills/plan/SKILL.md');
    expect(plan.tools.length).toBeGreaterThanOrEqual(1);
    expect(plan.transitionCriteria).toBeTruthy();
    expect(plan.humanCheckpoint).toBe(false);
    expect(typeof plan.compactGuidance).toBe('string');
  });

  it('SerializePlaybooks_Unknown_Throws', () => {
    expect(() => serializePlaybooks('nonexistent')).toThrow();
  });

  /** The serialized delegate phase must keep `autoEmittedEvents`, with `type`, `source`, `emittedBy`, `when` and `fields` for each event. */
  it('SerializePlaybooks_DelegatePhase_IncludesAutoEmittedEvents', () => {
    const result = serializePlaybooks('feature');
    const delegate = result.phases['delegate'] as {
      autoEmittedEvents?: readonly {
        type: string;
        source: string;
        emittedBy: string;
        when: string;
        fields?: readonly string[];
      }[];
    };
    expect(delegate.autoEmittedEvents).toBeDefined();
    const auto = delegate.autoEmittedEvents!;
    const types = auto.map((e) => e.type);
    expect(types).toContain('task.completed');
    expect(types).toContain('task.failed');
    const completed = auto.find((e) => e.type === 'task.completed')!;
    expect(completed.source).toBe('auto');
    expect(completed.emittedBy).toBe('exarchos_orchestrate task_complete (directly, or as the terminal leaf settle composes)');
    expect(completed.fields).toContain('taskId');
  });

  /** A phase without runtime-emitted events has no `autoEmittedEvents` field, not an empty array. */
  it('SerializePlaybooks_NonDelegatePhase_OmitsAutoEmittedEvents', () => {
    const result = serializePlaybooks('feature');
    const plan = result.phases['plan'] as {
      autoEmittedEvents?: readonly unknown[];
    };
    expect(plan.autoEmittedEvents).toBeUndefined();
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

describe('EventInstruction fields property', () => {
  /** The gates emit `gate.executed`, so no phase instructs it. The phases that disclose it list the fields that its schema requires. */
  it('EventInstruction_GateExecuted_IsDisclosedAsRuntimeEmittedNeverInstructed', () => {
    const playbooks = serializePlaybooks('feature');
    const instructing = Object.entries(playbooks.phases).filter(([, pb]) =>
      pb.events.some((e) => e.type === 'gate.executed'),
    );
    expect(instructing.map(([phase]) => phase)).toEqual([]);
    const disclosing = Object.entries(playbooks.phases).filter(([, pb]) =>
      (pb.autoEmittedEvents ?? []).some((e) => e.type === 'gate.executed'),
    );
    expect(disclosing.length).toBeGreaterThan(0);
    for (const [, pb] of disclosing) {
      const gateEvent = (pb.autoEmittedEvents ?? []).find((e) => e.type === 'gate.executed');
      expect(gateEvent?.fields).toBeDefined();
      expect(gateEvent?.fields).toContain('gateName');
      expect(gateEvent?.fields).toContain('layer');
      expect(gateEvent?.fields).toContain('passed');
    }
  });

  /**
   * `prepare` and `prepare_delegation` append `task.assigned`, so no phase instructs it.
   * The delegation phases disclose it with the fields that the projections key on.
   * The test checks each route by its full name, because `prepare` is a prefix of `prepare_delegation`.
   */
  it('EventInstruction_TaskAssigned_IsDisclosedAsTheRuntimesNotInstructed', () => {
    const playbooks = serializePlaybooks('feature');
    const instructed = Object.entries(playbooks.phases).filter(
      ([, pb]) => pb.events.some((e) => e.type === 'task.assigned'),
    );
    expect(instructed.map(([phase]) => phase)).toEqual([]);
    for (const phase of ['delegate', 'overhaul-delegate']) {
      const disclosed = phaseRuntimeEmissions(phase)?.find((e) => e.type === 'task.assigned');
      expect(disclosed, phase).toBeDefined();
      expect(disclosed?.fields).toEqual(expect.arrayContaining(['taskId', 'title']));
      expect(disclosed?.emittedBy).toContain('prepare (the capsule path)');
      expect(disclosed?.emittedBy).toContain('prepare_delegation (the primitive path)');
    }
  });
});

describe('compactGuidance describe hint', () => {
  it('Playbook_CompactGuidance_ContainsDescribeHint', () => {
    const playbooks = serializePlaybooks('feature');
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

/**
 * `review-contract.ts` owns the required review dimensions.
 * The set handler writes them to `_requiredReviews`, and the review playbook names them in `guardPrerequisites`.
 * Each declared dimension must appear in the playbook, so a rename must change both.
 */
describe('Review contract consistency across playbooks and tools.ts', () => {
  it('ReviewContract_EveryWorkflowType_HasMatchingReviewPlaybook', () => {
    for (const workflowType of Object.keys(REQUIRED_REVIEWS_BY_WORKFLOW_TYPE)) {
      const playbook = getPlaybook(workflowType, 'review');
      expect(
        playbook,
        `Workflow type "${workflowType}" declares required reviews but has no "review" phase playbook`,
      ).not.toBeNull();
    }
  });

  it('ReviewContract_GuardPrerequisites_MentionsEveryRequiredDimension', () => {
    for (const workflowType of Object.keys(REQUIRED_REVIEWS_BY_WORKFLOW_TYPE)) {
      const playbook = getPlaybook(workflowType, 'review')!;
      const dimensions = getRequiredReviews(workflowType);
      for (const dim of dimensions) {
        expect(
          playbook.guardPrerequisites,
          `${workflowType}:review guardPrerequisites does not mention required dimension "${dim}" — tools.ts and playbooks.ts have drifted`,
        ).toContain(dim);
      }
    }
  });

  /** The dimension names must match the skill folder names under `content/`, so a skill and the state key it writes are the same. */
  it('ReviewContract_FeatureWorkflow_UsesSkillFolderNames', () => {
    expect(getRequiredReviews('feature')).toEqual(['review']);
  });
});

/** Review verdicts go through `check_review_verdict`, so the review playbook must not instruct the model to emit `review.completed`. */
describe('review.completed in review phase', () => {
  it('ReviewPlaybook_Events_DoNotInstructReviewCompleted', () => {
    const playbooks = serializePlaybooks('feature');
    const reviewPhase = playbooks.phases['review'];
    expect(reviewPhase).toBeDefined();
    expect(reviewPhase?.events.map((e) => e.type)).not.toContain('review.completed');
    expect(reviewPhase?.events.length).toBeGreaterThan(0);
  });
});

describe('Delegation playbook gate prerequisites', () => {
  it('DelegationPlaybook_CompactGuidance_MentionsGatePrerequisites', () => {
    const playbook = getPlaybook('feature', 'delegate')!;
    expect(playbook).toBeDefined();
    expect(playbook.compactGuidance).toContain('check_test_adequacy');
    expect(playbook.compactGuidance).toContain('check_static_analysis');
    expect(playbook.compactGuidance).toContain('task_complete');
  });

  it('OverhaulDelegatePlaybook_CompactGuidance_MentionsGatePrerequisites', () => {
    const playbook = getPlaybook('refactor', 'overhaul-delegate')!;
    expect(playbook).toBeDefined();
    expect(playbook.compactGuidance).toContain('check_test_adequacy');
    expect(playbook.compactGuidance).toContain('check_static_analysis');
    expect(playbook.compactGuidance).toContain('task_complete');
  });
});

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

  it('compactGuidance_AllNonTerminalPhases_Under1000Chars', () => {
    const playbooks = getAllPlaybooks();
    const nonTerminal = playbooks.filter((p) => !terminalPhases.includes(p.phase));
    expect(nonTerminal.length).toBeGreaterThan(0);
    for (const p of nonTerminal) {
      expect(
        p.guidance.length,
        `${p.workflowType}:${p.phase} compactGuidance is ${p.guidance.length} chars, exceeds 1000`,
      ).toBeLessThanOrEqual(1000);
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

  /** A playbook with a `skillRef` hands its guidance to that skill, so the check skips it. */
  it('compactGuidance_NonTerminalNonBlockedPhases_ExceedsMinLength', () => {
    const playbooks = getAllPlaybooks();
    const active = playbooks.filter(
      (p) => !terminalPhases.includes(p.phase) && !blockedPhases.includes(p.phase),
    );
    expect(active.length).toBeGreaterThan(0);
    for (const p of active) {
      if (p.skillRef) continue;
      expect(
        p.guidance.length,
        `${p.workflowType}:${p.phase} compactGuidance is ${p.guidance.length} chars, below 200 minimum`,
      ).toBeGreaterThanOrEqual(200);
    }
  });

  /** A playbook with a `skillRef` hands its guidance to that skill, so the check skips it. */
  it('compactGuidance_AllNonTerminalNonBlockedPhases_MentionsToolOrAction', () => {
    const playbooks = getAllPlaybooks();
    const active = playbooks.filter(
      (p) => !terminalPhases.includes(p.phase) && !blockedPhases.includes(p.phase),
    );
    const toolOrActionPattern =
      /exarchos_workflow|exarchos_event|exarchos_orchestrate|exarchos_view|exarchos_sync|transition|emit|record|dispatch/i;
    expect(active.length).toBeGreaterThan(0);
    for (const p of active) {
      if (p.skillRef) continue;
      expect(
        toolOrActionPattern.test(p.guidance),
        `${p.workflowType}:${p.phase} compactGuidance does not mention any tool or action keyword`,
      ).toBe(true);
    }
  });
});

describe('Oneshot workflow playbooks', () => {
  it('oneshotPlaybook_declaresAllFourPhases', () => {
    expect(Array.isArray(oneshotPlaybook)).toBe(true);
    const phases = oneshotPlaybook.map((p) => p.phase);
    expect(phases).toContain('plan');
    expect(phases).toContain('implementing');
    expect(phases).toContain('synthesize');
    expect(phases).toContain('completed');
  });

  it('oneshotPlaybook_allEntriesDeclareWorkflowTypeOneshot', () => {
    expect(oneshotPlaybook.length).toBeGreaterThan(0);
    for (const entry of oneshotPlaybook) {
      expect(entry.workflowType).toBe('oneshot');
    }
  });

  it('oneshotPlaybook_implementingTransitionCriteria_mentionsChoiceState', () => {
    const implementing = oneshotPlaybook.find((p) => p.phase === 'implementing');
    expect(implementing).toBeDefined();
    expect(implementing!.transitionCriteria).toMatch(/synthesize/i);
    expect(implementing!.transitionCriteria).toMatch(/completed/i);
  });

  it('oneshotPlaybook_implementingGuardPrerequisites_mentionsSynthesisChoice', () => {
    const implementing = oneshotPlaybook.find((p) => p.phase === 'implementing');
    expect(implementing).toBeDefined();
    const guard = implementing!.guardPrerequisites.toLowerCase();
    expect(guard).toMatch(/synthesi/);
  });

  it('oneshotPlaybook_planTransitionCriteria_reachesImplementing', () => {
    const plan = oneshotPlaybook.find((p) => p.phase === 'plan');
    expect(plan).toBeDefined();
    expect(plan!.transitionCriteria).toMatch(/implementing/);
  });

  it('oneshotPlaybook_synthesizeTransitionCriteria_reachesCompleted', () => {
    const synthesize = oneshotPlaybook.find((p) => p.phase === 'synthesize');
    expect(synthesize).toBeDefined();
    expect(synthesize!.transitionCriteria).toMatch(/completed/);
  });

  it('oneshotPlaybook_completedIsTerminal', () => {
    const completed = oneshotPlaybook.find((p) => p.phase === 'completed');
    expect(completed).toBeDefined();
    expect(completed!.tools).toHaveLength(0);
    expect(completed!.events).toHaveLength(0);
  });

  it('oneshotPlaybook_registeredInWorkflowPlaybooksMap', () => {
    const entries = workflowPlaybooks.get('oneshot');
    expect(entries).toBeDefined();
    expect(entries!.length).toBeGreaterThan(0);
    expect(entries).toBe(oneshotPlaybook);
  });

  it('oneshotPlaybook_lookupsViaGetPlaybook_ReturnSameEntries', () => {
    for (const entry of oneshotPlaybook) {
      const looked = getPlaybook('oneshot', entry.phase);
      expect(looked).not.toBeNull();
      expect(looked!.phase).toBe(entry.phase);
      expect(looked!.workflowType).toBe('oneshot');
    }
  });

  it('oneshotPlaybook_RegisteredWorkflowType_ListedByHelper', () => {
    const types = listPlaybookWorkflowTypes();
    expect(types).toContain('oneshot');
  });

  it('oneshotPlaybook_Serialization_IncludesAllPhases', () => {
    const serialized: SerializedPlaybooks = serializePlaybooks('oneshot');
    expect(serialized.workflowType).toBe('oneshot');
    expect(serialized.phases).toHaveProperty('plan');
    expect(serialized.phases).toHaveProperty('implementing');
    expect(serialized.phases).toHaveProperty('synthesize');
    expect(serialized.phases).toHaveProperty('completed');
    const planPhase: SerializedPhasePlaybook = serialized.phases['plan'];
    expect(typeof planPhase.transitionCriteria).toBe('string');
    expect(planPhase.transitionCriteria.length).toBeGreaterThan(0);
  });
});

/**
 * The `task_complete` and `task_fail` handlers emit `task.completed` and `task.failed`.
 * The model must not emit them, so the `events` array omits them.
 * `autoEmittedEvents` lists them for telemetry, docs and agent context.
 * `tests/unit/workflow/topology/phase-events.test.ts` tests the refusal of a wrongly sourced event.
 */
describe('T6: autoEmittedEvents sibling field (#1227)', () => {
  it('PhaseRegistration_DelegatePhase_ExposesAutoEmittedEvents', () => {
    const playbook = getPlaybook('feature', 'delegate')!;
    expect(playbook).not.toBeNull();
    const auto = (playbook as { autoEmittedEvents?: readonly { type: string }[] })
      .autoEmittedEvents;
    expect(auto).toBeDefined();
    expect(Array.isArray(auto)).toBe(true);
    const types = new Set((auto ?? []).map((e) => e.type));
    expect(types.has('task.completed')).toBe(true);
    expect(types.has('task.failed')).toBe(true);
  });

  it('AutoEmittedEvents_TaskCompleted_HasEmittedByMetadata', () => {
    const playbook = getPlaybook('feature', 'delegate')!;
    const auto = (playbook as {
      autoEmittedEvents?: readonly {
        type: string;
        source: string;
        emittedBy?: string;
        when?: string;
        fields?: readonly string[];
      }[];
    }).autoEmittedEvents;
    expect(auto).toBeDefined();
    const completed = (auto ?? []).find((e) => e.type === 'task.completed');
    expect(completed).toBeDefined();
    expect(completed!.source).toBe('auto');
    expect(completed!.emittedBy).toBe('exarchos_orchestrate task_complete (directly, or as the terminal leaf settle composes)');
    expect(completed!.when).toBeTruthy();
    const fields = completed!.fields ?? [];
    expect(fields).toContain('taskId');
    expect(fields).toContain('evidence');
    expect(fields).toContain('verified');
    expect(fields).toContain('files');
    expect(fields).toContain('implements');
  });

  it('AutoEmittedEvents_TaskFailed_HasEmittedByMetadata', () => {
    const playbook = getPlaybook('feature', 'delegate')!;
    const auto = (playbook as {
      autoEmittedEvents?: readonly {
        type: string;
        source: string;
        emittedBy?: string;
        when?: string;
        fields?: readonly string[];
      }[];
    }).autoEmittedEvents;
    expect(auto).toBeDefined();
    const failed = (auto ?? []).find((e) => e.type === 'task.failed');
    expect(failed).toBeDefined();
    expect(failed!.source).toBe('auto');
    expect(failed!.emittedBy).toBe('exarchos_orchestrate task_fail');
    expect(failed!.when).toBeTruthy();
    const fields = failed!.fields ?? [];
    expect(fields).toContain('taskId');
    expect(fields).toContain('error');
    expect(fields).toContain('diagnostics');
  });

  it('PhaseEvents_NoOverlapWithAutoEmitted_DelegatePhase', () => {
    const playbook = getPlaybook('feature', 'delegate')!;
    const eventTypes = new Set(playbook.events.map((e) => e.type));
    const auto = (playbook as { autoEmittedEvents?: readonly { type: string }[] })
      .autoEmittedEvents;
    expect(auto).toBeDefined();
    const autoTypes = new Set((auto ?? []).map((e) => e.type));
    const intersection = [...autoTypes].filter((t) => eventTypes.has(t));
    expect(
      intersection,
      `events array and autoEmittedEvents must not overlap, found: ${intersection.join(', ')}`,
    ).toEqual([]);
  });

  it('PhaseEvents_OverhaulDelegatePhase_ExposesAutoEmittedEvents', () => {
    const playbook = getPlaybook('refactor', 'overhaul-delegate')!;
    expect(playbook).not.toBeNull();
    const auto = (playbook as { autoEmittedEvents?: readonly { type: string }[] })
      .autoEmittedEvents;
    expect(auto).toBeDefined();
    expect(Array.isArray(auto)).toBe(true);
    const types = new Set((auto ?? []).map((e) => e.type));
    expect(types.has('task.completed')).toBe(true);
    expect(types.has('task.failed')).toBe(true);
  });
});

/** The delegate guidance must take its gate names from `resolveVerificationSequence`, so a change to the policy table changes the guidance. */
describe('PlaybookDelegatePhase_GateGuidance_SourcedFromVerificationPolicy', () => {
  it('delegate compactGuidance contains every gate the policy yields for the medium tier', async () => {
    const { resolveVerificationSequence } = await import('../../../src/workflow/verification-policy.js');
    const playbook = getPlaybook('feature', 'delegate')!;
    expect(playbook).not.toBeNull();

    const mediumGates = resolveVerificationSequence('medium', false);
    expect(mediumGates.length).toBeGreaterThan(0);

    for (const gate of mediumGates) {
      expect(playbook.compactGuidance).toContain(gate);
    }
  });

  /** A boundary adds `check_contract_drift` at the medium tier, so guidance built from the policy names it too. */
  it('delegate guidance follows the policy table (table-change-propagates)', async () => {
    const { resolveVerificationSequence } = await import('../../../src/workflow/verification-policy.js');
    const playbook = getPlaybook('feature', 'delegate')!;

    const mediumBoundary = resolveVerificationSequence('medium', true);
    const contractDrift = mediumBoundary.find((g) => g === 'check_contract_drift');
    expect(contractDrift).toBeDefined();
    expect(playbook.compactGuidance).toContain(contractDrift!);
  });
});

/**
 * `IMPLEMENT_WORK_PHASES` holds the four phases where an agent implements.
 * `delegate` and `overhaul-delegate` are dispatch phases, so they keep their `check_tdd_compliance` guidance for the orchestrator.
 * The verification obligation comes from the kind resolver, not from test-first prose in the playbook.
 */
describe('Task 005: implement-phase mandatory-TDD prose removed (DR-5)', () => {
  const IMPLEMENT_WORK_PHASES = [
    { wf: 'debug', phase: 'debug-implement', transition: 'debug-validate', escalation: true },
    { wf: 'debug', phase: 'hotfix-implement', transition: 'hotfix-validate', escalation: true },
    { wf: 'refactor', phase: 'polish-implement', transition: 'polish-validate', escalation: true },
    { wf: 'oneshot', phase: 'implementing', transition: 'synthesize', escalation: false },
  ] as const;

  const MANDATORY_TDD_PROSE =
    /write failing test first|fixing without a failing test|TDD rules remain mandatory|Follow TDD/i;

  it('Playbooks_ImplementPhases_NoMandatoryTddProse', () => {
    for (const { wf, phase } of IMPLEMENT_WORK_PHASES) {
      const playbook = getPlaybook(wf, phase);
      expect(playbook, `${wf}:${phase} playbook should exist`).not.toBeNull();
      expect(
        MANDATORY_TDD_PROSE.test(playbook!.compactGuidance),
        `${wf}:${phase} still carries hardcoded mandatory-TDD prose`,
      ).toBe(false);
    }
  });

  it('Playbooks_ImplementPhases_RetainTransitionAndEscalation', () => {
    for (const { wf, phase, transition, escalation } of IMPLEMENT_WORK_PHASES) {
      const playbook = getPlaybook(wf, phase)!;
      expect(
        playbook.transitionCriteria,
        `${wf}:${phase} should retain its transition target`,
      ).toContain(transition);
      if (escalation) {
        expect(
          playbook.compactGuidance,
          `${wf}:${phase} should retain its escalation rule`,
        ).toMatch(/Escalate/i);
      }
    }
  });
});

/**
 * The registry `phases` sets bind gates to phases, and the review playbook derives its prerequisite from `review-contract.ts`.
 * These guards fail when a playbook hardcodes a gate list or drifts from that source.
 */
describe('DR-11: gate selection is resolver/SoT-derived, not hardcoded in playbooks', () => {
  const PLAN_GATE_NAMES = [
    'check_task_decomposition',
    'check_plan_coverage',
    'spec_coverage_check',
    'check_provenance_chain',
    'generate_traceability',
  ] as const;

  it('ReviewPlaybook_GuardPrerequisites_IsSoTDerivedNotHardcoded', () => {
    const pb = getPlaybook('feature', 'review');
    expect(pb).not.toBeNull();
    expect(pb?.guardPrerequisites).toBe(getRequiredReviewsPrerequisite('feature'));
  });

  it('PlanReviewSynthesisPlaybooks_ValidationScripts_CarryNoPhaseKindGateNames', () => {
    for (const phase of ['plan-review', 'review', 'synthesize']) {
      const pb = getPlaybook('feature', phase);
      expect(pb, `playbook feature:${phase}`).not.toBeNull();
      for (const gate of PLAN_GATE_NAMES) {
        expect(pb?.validationScripts ?? [], `feature:${phase} validationScripts`).not.toContain(
          gate,
        );
      }
    }
  });
});
