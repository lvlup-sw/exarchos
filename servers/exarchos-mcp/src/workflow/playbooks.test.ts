import { describe, it, expect, vi } from 'vitest';
import {
  getPlaybook,
  renderPlaybook,
  serializePlaybooks,
  listPlaybookWorkflowTypes,
  oneshotPlaybook,
  workflowPlaybooks,
} from './playbooks.js';
import type { SerializedPlaybooks, SerializedPhasePlaybook } from './playbooks.js';
import { getRequiredReviews, REQUIRED_REVIEWS_BY_WORKFLOW_TYPE } from './review-contract.js';

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

  it('renderPlaybook_DelegatePhase_IncludesAutoEmittedEvents', () => {
    // CodeRabbit major on PR #1297: PhasePlaybook gained an
    // autoEmittedEvents field but renderPlaybook() never surfaces it,
    // so consumers reading the rendered guidance can't tell that
    // task.completed / task.failed are runtime-emitted. The render
    // MUST advertise them as a distinct surface from `events:` so the
    // model knows not to manually re-emit them.
    const playbook = getPlaybook('feature', 'delegate')!;
    const rendered = renderPlaybook(playbook);
    expect(rendered).toMatch(/Auto-?emitted|auto[- ]emit/i);
    expect(rendered).toContain('task.completed');
    expect(rendered).toContain('task.failed');
    expect(rendered).toContain('exarchos_orchestrate task_complete');
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

  it('getPlaybook_DebugDesign_CompactGuidanceReferencesDesignTimeConstraints', () => {
    // #1498: the design phase is /debug's design-time surface; its
    // compactGuidance must point at the .exarchos/invariants.md Constraints
    // step (devCatalog-gated) so the constraint survives a compacted resume.
    const playbook = getPlaybook('debug', 'design')!;
    expect(playbook.compactGuidance).toContain('.exarchos/invariants.md');
    expect(playbook.compactGuidance.toLowerCase()).toContain('constraints');
    expect(playbook.compactGuidance.toLowerCase()).toContain('devcatalog');
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

  it('getPlaybook_RefactorBrief_CompactGuidanceReferencesDesignTimeConstraints', () => {
    // #1498: the brief phase is /refactor's design-time surface; its
    // compactGuidance must point at the .exarchos/invariants.md Constraints
    // step (devCatalog-gated) so the constraint survives a compacted resume.
    const playbook = getPlaybook('refactor', 'brief')!;
    expect(playbook.compactGuidance).toContain('.exarchos/invariants.md');
    expect(playbook.compactGuidance.toLowerCase()).toContain('constraints');
    expect(playbook.compactGuidance.toLowerCase()).toContain('devcatalog');
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
      'merge-pending',
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

  it('SerializePlaybooks_DelegatePhase_IncludesAutoEmittedEvents', () => {
    // CodeRabbit major on PR #1297: PhasePlaybook gained an
    // autoEmittedEvents field but serializePlaybooks() drops it on the
    // way out, so any consumer reading the serialized contract (CLI
    // describe, telemetry, agent context) sees no auto-emit surface
    // for the delegate phase. The serialized shape MUST carry the
    // field through with type, source, emittedBy, when, and fields
    // intact for each runtime-emitted event.
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
    expect(completed.emittedBy).toBe('exarchos_orchestrate task_complete');
    expect(completed.fields).toContain('taskId');
  });

  it('SerializePlaybooks_NonDelegatePhase_OmitsAutoEmittedEvents', () => {
    // Phases without runtime-emitted events leave the field undefined
    // on the in-memory PhasePlaybook; the serialized shape must mirror
    // that — explicit absence (not `[]`) keeps the contract minimal.
    const result = serializePlaybooks('feature');
    const ideate = result.phases['ideate'] as {
      autoEmittedEvents?: readonly unknown[];
    };
    expect(ideate.autoEmittedEvents).toBeUndefined();
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

// ─── Review contract consistency (prevents #1073 drift) ───────────────────
//
// The review-state contract is shared between three places that must agree:
//   1. `review-contract.ts`   → REQUIRED_REVIEWS_BY_WORKFLOW_TYPE (source of truth)
//   2. `tools.ts`             → _requiredReviews injection (calls getRequiredReviews)
//   3. `playbooks.ts`         → review-phase guardPrerequisites string
//
// PR #1045 drifted these apart by updating (2) without updating (3) or the
// skill documentation. This suite asserts that every dimension declared in
// the source of truth appears in the corresponding phase playbook's
// guardPrerequisites, so any future rename forces a coordinated update.

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

  it('ReviewContract_FeatureWorkflow_UsesSkillFolderNames', () => {
    // The dimension names MUST match skill folder names under skills-src/
    // so the skill an agent runs and the state key it writes are identical.
    // Changing this assertion requires renaming skill folders too.
    expect(getRequiredReviews('feature')).toEqual(['spec-review', 'quality-review']);
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

// ─── DR-3: Gate prerequisites in delegation compactGuidance ─────────────────

describe('Delegation playbook gate prerequisites', () => {
  it('DelegationPlaybook_CompactGuidance_MentionsGatePrerequisites', () => {
    const playbook = getPlaybook('feature', 'delegate')!;
    expect(playbook).toBeDefined();
    expect(playbook.compactGuidance).toContain('check_tdd_compliance');
    expect(playbook.compactGuidance).toContain('check_static_analysis');
    expect(playbook.compactGuidance).toContain('task_complete');
  });

  it('OverhaulDelegatePlaybook_CompactGuidance_MentionsGatePrerequisites', () => {
    const playbook = getPlaybook('refactor', 'overhaul-delegate')!;
    expect(playbook).toBeDefined();
    expect(playbook.compactGuidance).toContain('check_tdd_compliance');
    expect(playbook.compactGuidance).toContain('check_static_analysis');
    expect(playbook.compactGuidance).toContain('task_complete');
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

// ─── T10: Oneshot workflow playbook entries ────────────────────────────────

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
    // The choice-state transition criteria must mention both branches:
    // opted-in → synthesize AND opted-out → completed.
    expect(implementing!.transitionCriteria).toMatch(/synthesize/i);
    expect(implementing!.transitionCriteria).toMatch(/completed/i);
  });

  it('oneshotPlaybook_implementingGuardPrerequisites_mentionsSynthesisChoice', () => {
    const implementing = oneshotPlaybook.find((p) => p.phase === 'implementing');
    expect(implementing).toBeDefined();
    const guard = implementing!.guardPrerequisites.toLowerCase();
    // Design: "Tests pass + synthesis choice made (policy or event)".
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
    // Same reference as the exported array (single source of truth)
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

// ─── T6 (#1227): autoEmittedEvents sibling field on delegate-phase playbooks ─
//
// Auto-emitted events (`task.completed`, `task.failed`) are fired by
// `task_complete` / `task_fail` orchestrate handlers — the model must NOT
// emit them directly, so they're filtered out of the `events` array. But
// downstream surfaces (telemetry, docs, agent context) still need to know
// these events are part of the delegate-phase contract. The
// `autoEmittedEvents` sibling field exposes them WITHOUT inviting the model
// to manually re-emit them.

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
    expect(completed!.emittedBy).toBe('exarchos_orchestrate task_complete');
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

  it('AutoEmittedEvents_SoTConsistency_ThrowsOnMissingMetadata', async () => {
    // If a new auto-source event sneaks into the SoT registry without a
    // corresponding DELEGATE_PHASE_AUTO_EVENT_METADATA entry, module load
    // must throw — mirroring the existing model-event SoT check. Simulate
    // by stubbing getRegisteredEventTypes to include an auto-source event
    // that has no metadata entry (`workflow.cleanup`).
    vi.resetModules();
    vi.doMock('../projections/rehydration/reducer.js', () => ({
      getRegisteredEventTypes: (phase: string) =>
        phase === 'delegate' || phase === 'overhaul-delegate'
          ? ['task.assigned', 'task.completed', 'task.failed', 'workflow.cleanup']
          : [],
    }));
    await expect(import('./playbooks.js')).rejects.toThrow(
      /DELEGATE_PHASE_AUTO_EVENT_METADATA/,
    );
    vi.doUnmock('../projections/rehydration/reducer.js');
    vi.resetModules();
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

// ─── vls1-b1 (task 008): delegate-phase gate guidance from policy ───────────
//
// The delegate-phase playbook guidance must SOURCE its verification-gate names
// from the verification policy (`resolveVerificationSequence`), not hand-rolled
// literals. We prove the wiring by computing the expected gate names from the
// policy in the test and asserting the guidance contains them — so changing the
// policy table changes the guidance.

describe('PlaybookDelegatePhase_GateGuidance_SourcedFromVerificationPolicy', () => {
  it('delegate compactGuidance contains every gate the policy yields for the medium tier', async () => {
    const { resolveVerificationSequence } = await import('./verification-policy.js');
    const playbook = getPlaybook('feature', 'delegate')!;
    expect(playbook).not.toBeNull();

    // Medium tier base sequence — the minimum ladder a non-trivial task clears.
    const mediumGates = resolveVerificationSequence('medium', false);
    expect(mediumGates.length).toBeGreaterThan(0);

    for (const gate of mediumGates) {
      expect(playbook.compactGuidance).toContain(gate);
    }
  });

  it('delegate guidance follows the policy table (table-change-propagates)', async () => {
    // Stronger guarantee: the guidance must be BUILT from the policy values, so
    // the full set of policy gate names (across every tier/boundary combo) that
    // the delegate guidance advertises stays in lockstep with the table. We
    // assert the guidance references the exported gate names rather than ad-hoc
    // strings by checking that the medium+boundary sequence's added gate
    // (contract drift) is also surfaced.
    const { resolveVerificationSequence } = await import('./verification-policy.js');
    const playbook = getPlaybook('feature', 'delegate')!;

    const mediumBoundary = resolveVerificationSequence('medium', true);
    // contract_drift is the boundary-added gate; if guidance is policy-sourced
    // it should advertise the boundary gate too.
    const contractDrift = mediumBoundary.find((g) => g === 'check_contract_drift');
    expect(contractDrift).toBeDefined();
    expect(playbook.compactGuidance).toContain(contractDrift!);
  });
});

// ─── Task 005: implement-phase mandatory-TDD prose removed (DR-5) ────────────

describe('Task 005: implement-phase mandatory-TDD prose removed (DR-5)', () => {
  // The four work-implement phases an agent actually occupies while implementing.
  // (delegate / overhaul-delegate are dispatch phases — their check_tdd_compliance
  // gate-running guidance is orchestrator-facing and intentionally retained.)
  const IMPLEMENT_WORK_PHASES = [
    { wf: 'debug', phase: 'debug-implement', transition: 'debug-validate', escalation: true },
    { wf: 'debug', phase: 'hotfix-implement', transition: 'hotfix-validate', escalation: true },
    { wf: 'refactor', phase: 'polish-implement', transition: 'polish-validate', escalation: true },
    { wf: 'oneshot', phase: 'implementing', transition: 'synthesize', escalation: false },
  ] as const;

  // The verification obligation now flows from the kind resolver (Task 004),
  // not from hardcoded test-first prose baked into the playbook string.
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
