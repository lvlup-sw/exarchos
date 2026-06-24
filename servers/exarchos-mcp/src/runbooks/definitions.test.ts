import { describe, it, expect } from 'vitest';
import {
  TASK_COMPLETION,
  QUALITY_EVALUATION,
  AGENT_TEAMS_SAGA,
  SYNTHESIS_FLOW,
  SHEPHERD_ITERATION,
  TASK_FIX,
  TASK_CLASSIFICATION,
  REVIEW_STRATEGY,
  DESIGN_REFINEMENT,
  PLAN_COVERAGE_CHECK,
  PHASE_COMPRESSION,
  MERGE_ORCHESTRATION,
  ALL_RUNBOOKS,
} from './definitions.js';

describe('Runbook definitions', () => {
  it('AllRunbooks_HaveUniqueIds', () => {
    const ids = ALL_RUNBOOKS.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('AllRunbooks_HaveAtLeastOneStep', () => {
    for (const rb of ALL_RUNBOOKS) {
      expect(rb.steps.length, `${rb.id} should have steps`).toBeGreaterThan(0);
    }
  });

  it('AllRunbooks_HaveNonEmptyTemplateVars', () => {
    for (const rb of ALL_RUNBOOKS) {
      expect(rb.templateVars.length, `${rb.id} should have templateVars`).toBeGreaterThan(0);
    }
  });

  it('AllRunbooks_StepsHaveValidOnFail', () => {
    const validValues = new Set(['stop', 'continue', 'retry']);
    for (const rb of ALL_RUNBOOKS) {
      for (const step of rb.steps) {
        expect(validValues.has(step.onFail), `${rb.id} step ${step.action} has invalid onFail: ${step.onFail}`).toBe(true);
      }
    }
  });

  it('TaskCompletion_HasSixSteps_InCorrectOrder', () => {
    // #1329 / T-07 appended a post-merge `check_integration_suite` gate after
    // `task_complete`, taking the runbook from 3 to 4 steps. Verification-ladder
    // slice 1 prepended the `check_test_adequacy` kill-probe gate as the new
    // load-bearing per-task verification. Bundle B3 inserted the
    // `check_contract_drift` gate right after the kill probe. SIV-4
    // (#1530) inserted the advisory `check_mock_boundary` gate after
    // contract-drift — it flags unowned mocks in new test hunks and steers
    // toward hermetic fixtures, but is `onFail:'continue'` (advisory). #1587
    // RETIRED the advisory `check_tdd_compliance` step (test-FIRST ordering
    // gate), taking the runbook from 7 back to 6 steps; `check_test_adequacy`
    // is the sole per-task verification gate.
    expect(TASK_COMPLETION.steps).toHaveLength(6);
    expect(TASK_COMPLETION.steps[0].action).toBe('check_test_adequacy');
    expect(TASK_COMPLETION.steps[1].action).toBe('check_contract_drift');
    expect(TASK_COMPLETION.steps[2].action).toBe('check_mock_boundary');
    expect(TASK_COMPLETION.steps[3].action).toBe('check_static_analysis');
    expect(TASK_COMPLETION.steps[4].action).toBe('task_complete');
    expect(TASK_COMPLETION.steps[5].action).toBe('check_integration_suite');
    expect(TASK_COMPLETION.phase).toBe('delegate');
  });

  it('QualityEvaluation_HasFourSteps', () => {
    expect(QUALITY_EVALUATION.steps).toHaveLength(4);
    expect(QUALITY_EVALUATION.steps[0].action).toBe('check_static_analysis');
    expect(QUALITY_EVALUATION.steps[3].action).toBe('check_review_verdict');
    expect(QUALITY_EVALUATION.phase).toBe('review');
  });

  it('AgentTeamsSaga_HasTwelveSteps', () => {
    expect(AGENT_TEAMS_SAGA.steps).toHaveLength(12);
    expect(AGENT_TEAMS_SAGA.phase).toBe('delegate');
    // First step should be event-first: team.spawned
    expect(AGENT_TEAMS_SAGA.steps[0].tool).toBe('exarchos_event');
    expect(AGENT_TEAMS_SAGA.steps[0].params?.type).toBe('team.spawned');
    // Last step should be workflow transition.
    // T5a.1/DR-4 (#1259, v2.11): the prior `set({phase: 'review'})` step
    // is replaced with `transition({target: 'review'})` after the `set`
    // action's hard-cut.
    expect(AGENT_TEAMS_SAGA.steps[11].tool).toBe('exarchos_workflow');
    expect(AGENT_TEAMS_SAGA.steps[11].action).toBe('transition');
  });

  it('SynthesisFlow_HasFiveSteps', () => {
    expect(SYNTHESIS_FLOW.steps).toHaveLength(5);
    expect(SYNTHESIS_FLOW.steps[0].action).toBe('prepare_synthesis');
    expect(SYNTHESIS_FLOW.phase).toBe('synthesize');
  });

  it('ShepherdIteration_HasSixSteps', () => {
    expect(SHEPHERD_ITERATION.steps).toHaveLength(6);
    expect(SHEPHERD_ITERATION.steps[0].action).toBe('assess_stack');
    expect(SHEPHERD_ITERATION.phase).toBe('synthesize');
  });

  it('TaskFixRunbook_HasCorrectPhase_Delegate', () => {
    expect(TASK_FIX.phase).toBe('delegate');
  });

  it('TaskFixRunbook_FirstStepIsResumeOrSpawn_NativeTask', () => {
    expect(TASK_FIX.steps[0].tool).toBe('native:Task');
    expect(TASK_FIX.steps[0].action).toBe('resume_or_spawn');
  });

  it('TaskFixRunbook_IncludesAdequacyAndStaticGates_NoRetiredTddGate', () => {
    // #1587 retired check_tdd_compliance from the fix chain. Its replacement —
    // check_test_adequacy (the kill-probe) — gates the fix chain just as it
    // gates TASK_COMPLETION, so a fixed task meets the same adequacy bar as a
    // first-time completion. Order: adequacy → static analysis → task_complete.
    const actions = TASK_FIX.steps.map(s => s.action);
    expect(actions).not.toContain('check_tdd_compliance');
    const adequacyIndex = actions.indexOf('check_test_adequacy');
    const staticIndex = actions.indexOf('check_static_analysis');
    const completeIndex = actions.indexOf('task_complete');
    expect(adequacyIndex).toBeGreaterThan(-1);
    expect(adequacyIndex).toBeLessThan(staticIndex);
    expect(staticIndex).toBeLessThan(completeIndex);
  });

  it('TaskFixRunbook_AdequacyStepThreadsWorktreePath', () => {
    // The kill-probe must run against the agent worktree (#1330): repoRoot:auto
    // + the worktreePath template var, matching TASK_COMPLETION.
    expect(TASK_FIX.templateVars).toContain('worktreePath');
    const adequacyStep = TASK_FIX.steps.find(s => s.action === 'check_test_adequacy');
    expect(adequacyStep).toBeDefined();
    const params = adequacyStep?.params as { repoRoot?: unknown; worktreePath?: unknown } | undefined;
    expect(params?.repoRoot).toBe('auto');
    expect(params?.worktreePath).toBe('<worktreePath>');
  });

  it('TaskFixRunbook_TemplateVarsIncludeAgentId_ForResume', () => {
    expect(TASK_FIX.templateVars).toContain('agentId');
  });

  it('AllRunbooks_Count', () => {
    expect(ALL_RUNBOOKS).toHaveLength(18);
  });

  it('Runbook_PhaseMergePending_ReturnsPopulatedSteps', () => {
    // MERGE_ORCHESTRATION is the runbook counterpart to the merge-orchestrator
    // skill. Per #1363, exarchos_orchestrate({action: 'runbook', phase:
    // 'merge-pending'}) previously returned [] because the registry had no
    // entry for this phase.
    expect(MERGE_ORCHESTRATION).toBeDefined();
    expect(MERGE_ORCHESTRATION.id).toBe('merge-orchestration');
    expect(MERGE_ORCHESTRATION.phase).toBe('merge-pending');
    expect(MERGE_ORCHESTRATION.steps).toHaveLength(3);
    expect(MERGE_ORCHESTRATION.autoEmits).toEqual(
      expect.arrayContaining([
        'merge.preflight',
        'merge.executed',
        'merge.rollback',
        'workflow.transition',
      ]),
    );
    // Step 1: preflight dryRun
    expect(MERGE_ORCHESTRATION.steps[0].tool).toBe('exarchos_orchestrate');
    expect(MERGE_ORCHESTRATION.steps[0].action).toBe('merge_orchestrate');
    expect(MERGE_ORCHESTRATION.steps[0].params?.dryRun).toBe(true);
    // Step 2: real merge
    expect(MERGE_ORCHESTRATION.steps[1].tool).toBe('exarchos_orchestrate');
    expect(MERGE_ORCHESTRATION.steps[1].action).toBe('merge_orchestrate');
    // Step 3: HSM transition back to delegate
    expect(MERGE_ORCHESTRATION.steps[2].tool).toBe('exarchos_workflow');
    expect(MERGE_ORCHESTRATION.steps[2].action).toBe('transition');
    expect(MERGE_ORCHESTRATION.steps[2].params?.target).toBe('delegate');
  });

  it('TaskClassification_HasCorrectPhase_Delegate', () => {
    expect(TASK_CLASSIFICATION.phase).toBe('delegate');
  });

  it('TaskClassification_HasThreeSteps_ScaffoldingThenComplexityThenContext', () => {
    expect(TASK_CLASSIFICATION.steps).toHaveLength(3);
    // Step 1: scaffolding check
    expect(TASK_CLASSIFICATION.steps[0].decide?.question).toMatch(/scaffolding/i);
    // Step 2: complexity assessment
    expect(TASK_CLASSIFICATION.steps[1].decide?.question).toMatch(/edge case|algorithm|multi-dependenc|complex/i);
    // Step 3: context size check
    expect(TASK_CLASSIFICATION.steps[2].decide?.question).toMatch(/context|token|size/i);
  });

  it('ReviewStrategy_HasCorrectPhase_Review', () => {
    expect(REVIEW_STRATEGY.phase).toBe('review');
  });

  it('ReviewStrategy_HasThreeSteps_SizeThenFailuresThenStage', () => {
    expect(REVIEW_STRATEGY.steps).toHaveLength(3);
    // Step 1: change size / file count
    expect(REVIEW_STRATEGY.steps[0].decide?.question).toMatch(/file|module|diff|size/i);
    // Step 2: prior failures
    expect(REVIEW_STRATEGY.steps[1].decide?.question).toMatch(/fail|fix cycle|prior/i);
    // Step 3: stage type
    expect(REVIEW_STRATEGY.steps[2].decide?.question).toMatch(/spec.review|quality.review|stage/i);
  });

  it('DesignRefinement_HasCorrectPhase_Plan', () => {
    // #1581 (DR-4): design authoring folded into the `plan` phase (ex-ideate)
    expect(DESIGN_REFINEMENT.phase).toBe('plan');
  });

  it('DesignRefinement_HasTwoSteps_ComplexityThenCompression', () => {
    expect(DESIGN_REFINEMENT.steps).toHaveLength(2);
    expect(DESIGN_REFINEMENT.steps[0].decide?.question).toMatch(/requirement|trade-off|complex/i);
    expect(DESIGN_REFINEMENT.steps[1].decide?.question).toMatch(/compress|summary/i);
  });

  it('PlanCoverageCheck_HasCorrectPhase_PlanReview', () => {
    expect(PLAN_COVERAGE_CHECK.phase).toBe('plan-review');
  });

  it('PlanCoverageCheck_HasFourSteps_ThreeFramingsPlusConvergence', () => {
    expect(PLAN_COVERAGE_CHECK.steps).toHaveLength(4);
    expect(PLAN_COVERAGE_CHECK.steps[0].decide?.question).toMatch(/DR-N.*NO corresponding|gap/i);
    expect(PLAN_COVERAGE_CHECK.steps[1].decide?.question).toMatch(/FULLY address/i);
    expect(PLAN_COVERAGE_CHECK.steps[2].decide?.question).toMatch(/orphan|trace back/i);
    expect(PLAN_COVERAGE_CHECK.steps[3].decide?.question).toMatch(/agree|convergence/i);
  });

  it('PhaseCompression_HasCorrectPhase_Delegate', () => {
    expect(PHASE_COMPRESSION.phase).toBe('delegate');
  });

  it('PhaseCompression_HasTwoSteps_ArtifactTypeThenVerification', () => {
    expect(PHASE_COMPRESSION.steps).toHaveLength(2);
    expect(PHASE_COMPRESSION.steps[0].decide?.question).toMatch(/source artifact|compress/i);
    expect(PHASE_COMPRESSION.steps[1].decide?.question).toMatch(/load-bearing|preserve/i);
  });

  // ─── #1330 / T-05: worktree-aware task-completion gate ─────────────────────
  it('TaskCompletionRunbook_StaticAnalysisStep_ReceivesWorktreePath', () => {
    // The task-completion runbook runs `check_static_analysis` against the
    // agent's worktree, not the orchestrator's cwd (#1330). The gate's
    // worktree-aware resolver (T-04) keys off `repoRoot: 'auto'` plus a
    // threaded `worktreePath`. For the runbook to thread that path, the
    // `worktreePath` template var must exist AND the static-analysis step
    // must pre-fill `params.repoRoot: 'auto'` with `params.worktreePath`
    // pointing at the template var (angle-bracket placeholder convention),
    // rather than running against a literal '.'/absent root.
    expect(TASK_COMPLETION.templateVars).toContain('worktreePath');

    const staticStep = TASK_COMPLETION.steps.find(
      (s) => s.action === 'check_static_analysis',
    );
    expect(staticStep, 'task-completion must have a check_static_analysis step').toBeDefined();

    const params = staticStep?.params as
      | { repoRoot?: unknown; worktreePath?: unknown }
      | undefined;
    expect(params, 'check_static_analysis step must pre-fill params').toBeDefined();
    // repoRoot must request worktree-aware resolution, not a literal '.'.
    expect(params?.repoRoot).toBe('auto');
    expect(params?.repoRoot).not.toBe('.');
    // worktreePath must thread the `worktreePath` template var.
    expect(params?.worktreePath).toBe('<worktreePath>');
  });

  // ─── #1329 / T-07: post-merge integration-suite gate ───────────────────────
  it('DelegateRunbook_AfterTaskMerge_RunsIntegrationSuiteGate', () => {
    // #1329: per-task TDD/static gates can be green while the *integration tip*
    // cascades (a file failing at import counts as "0 failed tests / 1 failed
    // suite" — invisible to per-task gates). The `check_integration_suite` gate
    // (T-06) runs the FULL suite against the integration tip and folds those
    // load-failures into the failure count.
    //
    // It must be wired into the delegate-phase task-completion runbook AFTER
    // `task_complete` (i.e. after the task lands on the integration tip), with
    // `onFail: 'stop'` so a broken integration tip halts the loop before the
    // next dispatch. It threads the same worktree-aware resolution the static
    // gate uses (#1330): `repoRoot: 'auto'` + `worktreePath` template var.
    const actions = TASK_COMPLETION.steps.map((s) => s.action);
    const completeIndex = actions.indexOf('task_complete');
    const integrationIndex = actions.indexOf('check_integration_suite');

    expect(completeIndex, 'task-completion must retain a task_complete step').toBeGreaterThan(-1);
    expect(
      integrationIndex,
      'task-completion must include a check_integration_suite step',
    ).toBeGreaterThan(-1);
    // The integration-suite gate runs AFTER the task merges (task_complete), so
    // a cascaded integration tip blocks the next dispatch.
    expect(integrationIndex).toBeGreaterThan(completeIndex);

    const integrationStep = TASK_COMPLETION.steps[integrationIndex];
    expect(integrationStep.tool).toBe('exarchos_orchestrate');
    // onFail must be 'stop' — a broken integration tip is a hard halt.
    expect(integrationStep.onFail).toBe('stop');

    const params = integrationStep.params as
      | { repoRoot?: unknown; worktreePath?: unknown }
      | undefined;
    expect(params, 'check_integration_suite step must pre-fill params').toBeDefined();
    // Worktree-aware resolution against the integration tip (#1330 resolver).
    expect(params?.repoRoot).toBe('auto');
    expect(params?.worktreePath).toBe('<worktreePath>');
  });
});
