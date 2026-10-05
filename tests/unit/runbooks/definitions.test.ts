import { describe, it, expect } from 'vitest';
import { classifyTasksFailClosed } from '../../../src/verbs/team/prepare-delegation.js';
import type { TaskInput, TaskClassification } from '../../../src/verbs/team/prepare-delegation.js';
import { resolvePolicySkip } from '../../../src/verbs/gates/gate-utils.js';
import { runProbe, interpretProbeVerdict } from '../../../src/verbs/gates/test-adequacy.js';
import type { RunbookDefinition, RunbookStep } from '../../../src/runbooks/types.js';
import {
  TASK_COMPLETION,
  QUALITY_EVALUATION,
  AGENT_TEAMS_SAGA,
  SYNTHESIS_FLOW,
  SYNTHESIS_CLOSEOUT,
  SHEPHERD_ITERATION,
  TASK_FIX,
  TASK_CLASSIFICATION,
  REVIEW_STRATEGY,
  DESIGN_REFINEMENT,
  PLAN_CLOSEOUT,
  PLAN_COVERAGE_CHECK,
  PHASE_COMPRESSION,
  MERGE_ORCHESTRATION,
  ALL_RUNBOOKS,
} from '../../../src/runbooks/definitions.js';

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

  it('TaskCompletion_HasFiveSteps_TaskCompleteTerminal', () => {
    expect(TASK_COMPLETION.steps).toHaveLength(5);
    expect(TASK_COMPLETION.steps[0].action).toBe('check_test_adequacy');
    expect(TASK_COMPLETION.steps[1].action).toBe('check_contract_drift');
    expect(TASK_COMPLETION.steps[2].action).toBe('check_mock_boundary');
    expect(TASK_COMPLETION.steps[3].action).toBe('check_static_analysis');
    expect(TASK_COMPLETION.steps[4].action).toBe('task_complete');
    expect(TASK_COMPLETION.phase).toBe('delegate');
  });

  it('QualityEvaluation_HasFiveSteps', () => {
    expect(QUALITY_EVALUATION.steps).toHaveLength(5);
    expect(QUALITY_EVALUATION.steps[0].action).toBe('check_static_analysis');
    expect(QUALITY_EVALUATION.steps[3].action).toBe('check_invariant_conformance');
    expect(QUALITY_EVALUATION.steps[4].action).toBe('check_review_verdict');
    expect(QUALITY_EVALUATION.phase).toBe('review');
  });

  /** The saga emits `team.spawned` first, and its last step is the workflow transition. */
  it('AgentTeamsSaga_HasThirteenSteps', () => {
    expect(AGENT_TEAMS_SAGA.steps).toHaveLength(13);
    expect(AGENT_TEAMS_SAGA.phase).toBe('delegate');
    expect(AGENT_TEAMS_SAGA.steps[0].tool).toBe('exarchos_event');
    expect(AGENT_TEAMS_SAGA.steps[0].params?.type).toBe('team.spawned');
    expect(AGENT_TEAMS_SAGA.steps[12].tool).toBe('exarchos_workflow');
    expect(AGENT_TEAMS_SAGA.steps[12].action).toBe('transition');
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

  /**
   * The fix chain runs the same kill probe as `TASK_COMPLETION`, so a fixed task
   * gets the same adequacy check as a first completion. The probe runs before static
   * analysis, and static analysis before `task_complete`.
   */
  it('TaskFixRunbook_IncludesAdequacyAndStaticGates_NoRetiredTddGate', () => {
    const actions = TASK_FIX.steps.map(s => s.action);
    expect(actions).not.toContain('check_tdd_compliance');
    const adequacyIndex = actions.indexOf('check_test_adequacy');
    const staticIndex = actions.indexOf('check_static_analysis');
    const completeIndex = actions.indexOf('task_complete');
    expect(adequacyIndex).toBeGreaterThan(-1);
    expect(adequacyIndex).toBeLessThan(staticIndex);
    expect(staticIndex).toBeLessThan(completeIndex);
  });

  /** The kill probe must run in the agent worktree, so the step binds `repoRoot: 'auto'` and `<worktreePath>`. */
  it('TaskFixRunbook_AdequacyStepThreadsWorktreePath', () => {
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
    expect(ALL_RUNBOOKS).toHaveLength(20);
  });

  /** Both steps stop on failure. The body check guards the create, and the create is a remote side effect. */
  it('SynthesisCloseout_HasTwoSteps_BodyCheckThenCreate', () => {
    expect(SYNTHESIS_CLOSEOUT.phase).toBe('synthesize');
    expect(SYNTHESIS_CLOSEOUT.steps).toHaveLength(2);
    expect(SYNTHESIS_CLOSEOUT.steps[0].action).toBe('validate_pr_body');
    expect(SYNTHESIS_CLOSEOUT.steps[1].action).toBe('create_pr');
    expect(SYNTHESIS_CLOSEOUT.steps.map((step) => step.onFail)).toEqual(['stop', 'stop']);
  });

  /** The two gates stop the segment on failure. The matrix generator is not a gate, so it continues. */
  it('PlanCloseout_HasThreeSteps_TwoBlockingGatesFirst', () => {
    expect(PLAN_CLOSEOUT.phase).toBe('plan');
    expect(PLAN_CLOSEOUT.steps).toHaveLength(3);
    expect(PLAN_CLOSEOUT.steps[0].action).toBe('check_plan_coverage');
    expect(PLAN_CLOSEOUT.steps[1].action).toBe('check_provenance_chain');
    expect(PLAN_CLOSEOUT.steps[2].action).toBe('generate_traceability');
    expect(PLAN_CLOSEOUT.steps.map((step) => step.onFail)).toEqual([
      'stop',
      'stop',
      'continue',
    ]);
  });

  /**
   * `MERGE_ORCHESTRATION` is the runbook of the `merge-pending` phase: a dry-run
   * preflight, the merge, then a transition to `delegate`. Recovery emits only
   * `merge.recovered`, so `autoEmits` must not name `merge.rollback`.
   */
  it('Runbook_PhaseMergePending_ReturnsPopulatedSteps', () => {
    expect(MERGE_ORCHESTRATION).toBeDefined();
    expect(MERGE_ORCHESTRATION.id).toBe('merge-orchestration');
    expect(MERGE_ORCHESTRATION.phase).toBe('merge-pending');
    expect(MERGE_ORCHESTRATION.steps).toHaveLength(3);
    expect(MERGE_ORCHESTRATION.autoEmits).toEqual(
      expect.arrayContaining([
        'merge.preflight',
        'merge.executed',
        'merge.recovered',
        'workflow.transition',
      ]),
    );
    expect(MERGE_ORCHESTRATION.autoEmits).not.toContain('merge.rollback');
    expect(MERGE_ORCHESTRATION.steps[0].tool).toBe('exarchos_orchestrate');
    expect(MERGE_ORCHESTRATION.steps[0].action).toBe('merge_orchestrate');
    expect(MERGE_ORCHESTRATION.steps[0].params?.dryRun).toBe(true);
    expect(MERGE_ORCHESTRATION.steps[1].tool).toBe('exarchos_orchestrate');
    expect(MERGE_ORCHESTRATION.steps[1].action).toBe('merge_orchestrate');
    expect(MERGE_ORCHESTRATION.steps[2].tool).toBe('exarchos_workflow');
    expect(MERGE_ORCHESTRATION.steps[2].action).toBe('transition');
    expect(MERGE_ORCHESTRATION.steps[2].params?.target).toBe('delegate');
  });

  it('TaskClassification_HasCorrectPhase_Delegate', () => {
    expect(TASK_CLASSIFICATION.phase).toBe('delegate');
  });

  it('TaskClassification_HasThreeSteps_ScaffoldingThenComplexityThenContext', () => {
    expect(TASK_CLASSIFICATION.steps).toHaveLength(3);
    expect(TASK_CLASSIFICATION.steps[0].decide?.question).toMatch(/scaffolding/i);
    expect(TASK_CLASSIFICATION.steps[1].decide?.question).toMatch(/edge case|algorithm|multi-dependenc|complex/i);
    expect(TASK_CLASSIFICATION.steps[2].decide?.question).toMatch(/context|token|size/i);
  });

  it('ReviewStrategy_HasCorrectPhase_Review', () => {
    expect(REVIEW_STRATEGY.phase).toBe('review');
  });

  it('ReviewStrategy_HasTwoSteps_SizeThenFailures', () => {
    expect(REVIEW_STRATEGY.steps).toHaveLength(2);
    expect(REVIEW_STRATEGY.steps[0].decide?.question).toMatch(/file|module|diff|size/i);
    expect(REVIEW_STRATEGY.steps[1].decide?.question).toMatch(/fail|fix cycle|prior/i);
  });

  /** Design authoring is part of the `plan` phase. */
  it('DesignRefinement_HasCorrectPhase_Plan', () => {
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

  /**
   * `check_static_analysis` must run in the agent worktree, not in the orchestrator
   * directory. The gate resolves the worktree from `repoRoot: 'auto'` and
   * `worktreePath`. Thus the runbook must declare the `worktreePath` variable, and the
   * step must bind both params.
   */
  it('TaskCompletionRunbook_StaticAnalysisStep_ReceivesWorktreePath', () => {
    expect(TASK_COMPLETION.templateVars).toContain('worktreePath');

    const staticStep = TASK_COMPLETION.steps.find(
      (s) => s.action === 'check_static_analysis',
    );
    expect(staticStep, 'task-completion must have a check_static_analysis step').toBeDefined();

    const params = staticStep?.params as
      | { repoRoot?: unknown; worktreePath?: unknown }
      | undefined;
    expect(params, 'check_static_analysis step must pre-fill params').toBeDefined();
    expect(params?.repoRoot).toBe('auto');
    expect(params?.repoRoot).not.toBe('.');
    expect(params?.worktreePath).toBe('<worktreePath>');
  });

  /**
   * `task_complete` must be the last step. If a blocking gate follows it, the record
   * can show a complete task that then fails that gate.
   */
  it('DelegateRunbook_TaskComplete_FollowsEveryBlockingPerTaskGate', () => {
    const actions = TASK_COMPLETION.steps.map((s) => s.action);
    const completeIndex = actions.indexOf('task_complete');

    expect(completeIndex, 'task-completion must retain a task_complete step').toBeGreaterThan(-1);
    expect(completeIndex).toBe(TASK_COMPLETION.steps.length - 1);

    const blockingAfterComplete = TASK_COMPLETION.steps
      .slice(completeIndex + 1)
      .filter((step) => step.onFail === 'stop');
    expect(
      blockingAfterComplete.map((step) => step.action),
      'no blocking per-task gate may run after task_complete',
    ).toEqual([]);
  });

  /**
   * Per-task gates can pass while the integration tip fails, as when a file fails at
   * import. Thus the cumulative suite runs one time per wave in `AGENT_TEAMS_SAGA`,
   * before `post_delegation_check` and the transition, and a failure stops the saga.
   * It runs in the integration worktree. `repoRoot: 'auto'` cannot resolve that path
   * from a task or an agent, so the step binds `<repoRoot>` for the orchestrator to fill.
   */
  it('DelegateRunbook_CumulativeIntegrationSuite_RunsOnceAtWaveBoundary', () => {
    const perTaskActions = TASK_COMPLETION.steps.map((s) => s.action);
    expect(
      perTaskActions,
      'the cumulative suite must not run inside the per-task loop',
    ).not.toContain('check_integration_suite');

    const waveActions = AGENT_TEAMS_SAGA.steps.map((s) => s.action);
    const integrationIndices = waveActions
      .map((action, index) => (action === 'check_integration_suite' ? index : -1))
      .filter((index) => index >= 0);
    expect(
      integrationIndices,
      'the cumulative suite runs exactly once per wave',
    ).toHaveLength(1);

    const [integrationIndex, ...extraIndices] = integrationIndices;
    expect(extraIndices).toEqual([]);
    expect(integrationIndex).toBeDefined();
    if (integrationIndex === undefined) return;
    const transitionIndex = waveActions.lastIndexOf('transition');
    expect(integrationIndex).toBeLessThan(transitionIndex);
    expect(waveActions.indexOf('post_delegation_check')).toBeGreaterThan(integrationIndex);

    const integrationStep = AGENT_TEAMS_SAGA.steps[integrationIndex];
    expect(integrationStep).toBeDefined();
    if (integrationStep === undefined) return;
    expect(integrationStep.tool).toBe('exarchos_orchestrate');
    expect(integrationStep.onFail).toBe('stop');

    const params = integrationStep.params as { repoRoot?: unknown } | undefined;
    expect(params, 'check_integration_suite step must pre-fill params').toBeDefined();
    expect(params?.repoRoot).toBe('<repoRoot>');
    expect(
      AGENT_TEAMS_SAGA.templateVars,
      'the <repoRoot> placeholder must have a matching declared templateVar',
    ).toContain('repoRoot');
  });
});

/** A task fixture with no tier field. The production heuristic derives the tier, as it does for `LOW_TASK`. */
const HIGH_BOUNDARY_TASK: TaskInput = {
  id: 'T-high',
  title: 'Rework the published API contract',
  files: ['src/api/openapi.yaml'],
  testLayer: 'integration',
};

const LOW_TASK: TaskInput = {
  id: 'T-low',
  title: 'Refresh the onboarding docs',
  files: ['docs/onboarding.md'],
};

/** Classifies one task through `classifyTasksFailClosed`, as `handlePrepareDelegation` does, and returns its stamp. */
function freezeDelegationStamp(task: TaskInput): TaskClassification {
  const classified = classifyTasksFailClosed([task]);
  if (!classified.ok) throw new Error(classified.blocked.reason);
  const stamp = classified.classifications[0];
  if (!stamp) throw new Error('prepare_delegation produced no classification');
  return stamp;
}

/** The dispatch variables for a task: the two stamp fields from the classification, and fixed task coordinates. */
function dispatchVarsFrom(stamp: TaskClassification): Readonly<Record<string, unknown>> {
  return {
    taskId: stamp.taskId,
    featureId: 'wc-t04',
    streamId: 'wc-t04',
    branch: `task/${stamp.taskId}`,
    agentId: `agent-${stamp.taskId}`,
    failureContext: 'previous attempt failed',
    worktreePath: `/tmp/worktrees/${stamp.taskId}`,
    riskTier: stamp.riskTier,
    boundaryTouching: stamp.boundaryTouching,
  };
}

/**
 * Fills the `<var>` placeholders of a step from the dispatch variables, in place of
 * the orchestrator. It throws for a placeholder that is not a declared
 * `templateVar`, because the orchestrator has no contract to supply that value.
 */
function fillStepParams(
  runbook: RunbookDefinition,
  step: RunbookStep,
  vars: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const filled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(step.params ?? {})) {
    const placeholder =
      typeof value === 'string' && value.startsWith('<') && value.endsWith('>')
        ? value.slice(1, -1)
        : null;
    if (placeholder === null) {
      filled[key] = value;
      continue;
    }
    if (!runbook.templateVars.includes(placeholder)) {
      throw new Error(
        `runbook '${runbook.id}' step '${step.action}' references <${placeholder}>, ` +
          `which is not a declared templateVar — the orchestrator cannot supply it`,
      );
    }
    filled[key] = vars[placeholder];
  }
  return filled;
}

function adequacyStepOf(runbook: RunbookDefinition): RunbookStep {
  const step = runbook.steps.find((s) => s.action === 'check_test_adequacy');
  if (!step) throw new Error(`runbook '${runbook.id}' has no check_test_adequacy step`);
  return step;
}

/** Returns the params that the gate gets from the adequacy step of a runbook. */
function dispatchAdequacyParams(
  runbook: RunbookDefinition,
  stamp: TaskClassification,
): Readonly<Record<string, unknown>> {
  return fillStepParams(runbook, adequacyStepOf(runbook), dispatchVarsFrom(stamp));
}

/**
 * The probe returns `no-new-tests` before it changes the tree, so it must not call
 * this seam or `unreachableRunTests`. Each one throws, so a probe that reaches the
 * tree fails the test.
 */
const unreachableGitExec = (): never => {
  throw new Error('git must not run — the probe short-circuits before any tree mutation');
};
const unreachableRunTests = (): never => {
  throw new Error('the test command must not run — there are no probe-able tests');
};

/** A task diff that changes source and adds no test file. */
const SOURCE_ONLY_DIFF = ['src/api/openapi.yaml'];

/** Runs the probe with the tier from the dispatched params, the object that the runbook step filled from the stamp. */
async function runGateWithParams(params: Readonly<Record<string, unknown>>) {
  return runProbe({
    gitExec: unreachableGitExec,
    runTests: unreachableRunTests,
    repoRoot: '/tmp/worktrees/unused',
    baseRef: 'main',
    changedFiles: SOURCE_ONLY_DIFF,
    ...(params['riskTier'] === undefined ? {} : { riskTier: params['riskTier'] as string }),
  });
}

/**
 * `prepare_delegation` freezes `riskTier` and `boundaryTouching` for each task. In
 * these tests the production classifier makes the stamp, the runbook `templateVars`
 * and step `params` carry it, and the production probe reads it. No test gives a
 * tier to the gate by hand: each value that reaches the gate comes from the stamp.
 */
describe('DR-3 — delegation stamp threading (prepare_delegation → runbook → gate)', () => {
  /**
   * Characterizes a gate that gets no tier. The stamp is high, but with an unset tier
   * a task with no new test gets an advisory skip. The same verdict blocks at the
   * tier of the stamp. Without `boundaryTouching`, `resolvePolicySkip` returns null.
   */
  it('DelegationStamp_UndefinedTier_CharacterizesTheVacuousAdvisoryPass', async () => {
    const stamp = freezeDelegationStamp(HIGH_BOUNDARY_TASK);
    expect(stamp.riskTier).toBe('high');

    const unstamped = await runGateWithParams({});
    expect(unstamped.passed).toBe(true);
    expect(unstamped.skipped).toBe(true);
    expect(unstamped.disposition).toBe('advisory-skip');

    const atStampedTier = interpretProbeVerdict(unstamped.verdict, stamp.riskTier);
    expect(atStampedTier.passed).toBe(false);

    expect(
      resolvePolicySkip({ gateName: 'check_test_adequacy', riskTier: stamp.riskTier }),
    ).toBeNull();
  });

  /**
   * The gate gets the frozen tier through the runbook step. If the runbook drops the
   * param, the tier is `undefined`. With no new test, the high-tier task blocks and
   * the low-tier task gets an advisory skip. Both dispatches use the same step and
   * the same fill, so only the stamp can cause the different verdicts.
   */
  it('TaskCompletion_DelegationStamp_DeliversRiskTierToGate', async () => {
    const highStamp = freezeDelegationStamp(HIGH_BOUNDARY_TASK);
    const highParams = dispatchAdequacyParams(TASK_COMPLETION, highStamp);

    expect(highParams['riskTier']).toBe(highStamp.riskTier);
    expect(highParams['boundaryTouching']).toBe(highStamp.boundaryTouching);

    const highResult = await runGateWithParams(highParams);
    expect(highResult.passed).toBe(false);
    expect(highResult.skipped).toBeUndefined();
    expect(highResult.disposition).toBe('blocked');
    expect(highResult.report).toContain(highStamp.riskTier);

    const lowStamp = freezeDelegationStamp(LOW_TASK);
    const lowParams = dispatchAdequacyParams(TASK_COMPLETION, lowStamp);
    expect(lowParams['riskTier']).toBe(lowStamp.riskTier);
    expect(lowStamp.riskTier).not.toBe(highStamp.riskTier);

    const lowResult = await runGateWithParams(lowParams);
    expect(lowResult.passed).toBe(true);
    expect(lowResult.skipped).toBe(true);
    expect(lowResult.disposition).toBe('advisory-skip');

    expect(Object.keys(highParams).sort()).toEqual(Object.keys(lowParams).sort());
    expect(highParams['repoRoot']).toBe(lowParams['repoRoot']);
    expect(highParams['riskTier']).not.toBe(lowParams['riskTier']);
  });

  /**
   * `TASK_FIX` carries the same stamp, so a fix gets the same adequacy check as a
   * first completion. `resolvePolicySkip` needs both stamp fields. With both, the
   * low-tier profile skips `check_test_adequacy` by policy, and the high-tier
   * boundary profile keeps it. With `boundaryTouching` absent, it returns null. The
   * probe then blocks the high-tier fix that has no new test.
   */
  it('TaskFix_DelegationStamp_DeliversBoundaryTouchingToGate', async () => {
    const lowStamp = freezeDelegationStamp(LOW_TASK);
    const lowParams = dispatchAdequacyParams(TASK_FIX, lowStamp);

    expect(typeof lowStamp.boundaryTouching).toBe('boolean');
    expect(lowParams['boundaryTouching']).toBe(lowStamp.boundaryTouching);
    expect(lowParams['riskTier']).toBe(lowStamp.riskTier);

    const routed = resolvePolicySkip({
      gateName: 'check_test_adequacy',
      riskTier: lowParams['riskTier'] as 'low' | 'medium' | 'high',
      boundaryTouching: lowParams['boundaryTouching'] as boolean,
    });
    expect(routed).not.toBeNull();
    expect(routed?.reason).toContain(`boundaryTouching=${lowStamp.boundaryTouching}`);
    expect(routed?.reason).toContain(`riskTier='${lowStamp.riskTier}'`);

    expect(
      resolvePolicySkip({
        gateName: 'check_test_adequacy',
        riskTier: lowParams['riskTier'] as 'low' | 'medium' | 'high',
      }),
    ).toBeNull();

    const highStamp = freezeDelegationStamp(HIGH_BOUNDARY_TASK);
    const highParams = dispatchAdequacyParams(TASK_FIX, highStamp);
    expect(highParams['boundaryTouching']).toBe(highStamp.boundaryTouching);
    expect(highStamp.boundaryTouching).toBe(true);
    expect(
      resolvePolicySkip({
        gateName: 'check_test_adequacy',
        riskTier: highParams['riskTier'] as 'low' | 'medium' | 'high',
        boundaryTouching: highParams['boundaryTouching'] as boolean,
      }),
    ).toBeNull();

    const highResult = await runGateWithParams(highParams);
    expect(highResult.passed).toBe(false);
  });
});

