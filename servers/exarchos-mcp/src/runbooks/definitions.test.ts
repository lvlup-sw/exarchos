import { describe, it, expect } from 'vitest';
import { classifyTasksFailClosed } from '../verbs/team/prepare-delegation.js';
import type { TaskInput, TaskClassification } from '../verbs/team/prepare-delegation.js';
import { resolvePolicySkip } from '../verbs/gates/gate-utils.js';
import { runProbe, interpretProbeVerdict } from '../verbs/gates/test-adequacy.js';
import type { RunbookDefinition, RunbookStep } from './types.js';
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

  it('TaskCompletion_HasFiveSteps_TaskCompleteTerminal', () => {
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
    // WFQ-004 moved the cumulative `check_integration_suite` gate OUT of the
    // per-task loop to the wave boundary (AGENT_TEAMS_SAGA), taking the runbook
    // from 6 back to 5 steps and making `task_complete` terminal.
    expect(TASK_COMPLETION.steps).toHaveLength(5);
    expect(TASK_COMPLETION.steps[0].action).toBe('check_test_adequacy');
    expect(TASK_COMPLETION.steps[1].action).toBe('check_contract_drift');
    expect(TASK_COMPLETION.steps[2].action).toBe('check_mock_boundary');
    expect(TASK_COMPLETION.steps[3].action).toBe('check_static_analysis');
    expect(TASK_COMPLETION.steps[4].action).toBe('task_complete');
    expect(TASK_COMPLETION.phase).toBe('delegate');
  });

  it('QualityEvaluation_HasFiveSteps', () => {
    // Task 027 / DR-15: check_invariant_conformance was wired in as a review
    // dimension when it became a blocking gate (it now emits deterministic
    // check-mode findings), so the review runbook grew from 4 → 5 steps.
    expect(QUALITY_EVALUATION.steps).toHaveLength(5);
    expect(QUALITY_EVALUATION.steps[0].action).toBe('check_static_analysis');
    expect(QUALITY_EVALUATION.steps[3].action).toBe('check_invariant_conformance');
    expect(QUALITY_EVALUATION.steps[4].action).toBe('check_review_verdict');
    expect(QUALITY_EVALUATION.phase).toBe('review');
  });

  it('AgentTeamsSaga_HasThirteenSteps', () => {
    // WFQ-004: the cumulative `check_integration_suite` gate moved here from
    // the per-task runbook, taking the saga from 12 to 13 steps.
    expect(AGENT_TEAMS_SAGA.steps).toHaveLength(13);
    expect(AGENT_TEAMS_SAGA.phase).toBe('delegate');
    // First step should be event-first: team.spawned
    expect(AGENT_TEAMS_SAGA.steps[0].tool).toBe('exarchos_event');
    expect(AGENT_TEAMS_SAGA.steps[0].params?.type).toBe('team.spawned');
    // Last step should be workflow transition.
    // T5a.1/DR-4 (#1259, v2.11): the prior `set({phase: 'review'})` step
    // is replaced with `transition({target: 'review'})` after the `set`
    // action's hard-cut.
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
    // DR-2 (task 006): recovery emits ONLY `merge.recovered`; the legacy
    // `merge.rollback` write path is retired (read-tolerant, not emittable), so
    // it is no longer declared in autoEmits.
    expect(MERGE_ORCHESTRATION.autoEmits).toEqual(
      expect.arrayContaining([
        'merge.preflight',
        'merge.executed',
        'merge.recovered',
        'workflow.transition',
      ]),
    );
    expect(MERGE_ORCHESTRATION.autoEmits).not.toContain('merge.rollback');
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

  it('ReviewStrategy_HasTwoSteps_SizeThenFailures', () => {
    expect(REVIEW_STRATEGY.steps).toHaveLength(2);
    // Step 1: change size / file count
    expect(REVIEW_STRATEGY.steps[0].decide?.question).toMatch(/file|module|diff|size/i);
    // Step 2: prior failures (single adversarial review — no spec/quality stage split)
    expect(REVIEW_STRATEGY.steps[1].decide?.question).toMatch(/fail|fix cycle|prior/i);
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

  // ─── WFQ-004: wave-boundary integration gate + terminal task_complete ─────
  it('DelegateRunbook_TaskComplete_FollowsEveryBlockingPerTaskGate', () => {
    // The defect: `task_complete` sat at step 5 with a blocking
    // `check_integration_suite` at step 6, so a task could be recorded complete
    // and only THEN fail its last blocking gate. `task_complete` must be the
    // terminal step — no blocking gate may follow it.
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

  it('DelegateRunbook_CumulativeIntegrationSuite_RunsOnceAtWaveBoundary', () => {
    // #1329: per-task gates can be green while the *integration tip* cascades
    // (a file failing at import counts as "0 failed tests / 1 failed suite").
    // The cumulative gate still exists — but as a wave-boundary backstop,
    // matching its own action description, not a per-task gate. Running it per
    // task also created duplicate verification ownership (agent, lead, and
    // runbook each re-verifying the same claim).
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
    // It must land after the wave's task work and before the phase transition.
    const transitionIndex = waveActions.lastIndexOf('transition');
    expect(integrationIndex).toBeLessThan(transitionIndex);
    expect(waveActions.indexOf('post_delegation_check')).toBeGreaterThan(integrationIndex);

    const integrationStep = AGENT_TEAMS_SAGA.steps[integrationIndex];
    expect(integrationStep).toBeDefined();
    if (integrationStep === undefined) return;
    expect(integrationStep.tool).toBe('exarchos_orchestrate');
    // onFail must be 'stop' — a broken integration tip is a hard halt.
    expect(integrationStep.onFail).toBe('stop');

    const params = integrationStep.params as { repoRoot?: unknown } | undefined;
    expect(params, 'check_integration_suite step must pre-fill params').toBeDefined();
    // WFQ-004 executability: the wave-boundary run is post-merge, against the
    // INTEGRATION worktree — a location neither `worktreePath` (per-agent) nor
    // `taskId` (per-task `worktree.created` lookup) can derive, so
    // `repoRoot: 'auto'` could NEVER resolve here (resolveRepoRoot fails
    // closed → INVALID_INPUT → saga halt). The step instead binds the
    // `<repoRoot>` template var (declared in AGENT_TEAMS_SAGA.templateVars)
    // that the orchestrator fills with the integration worktree path.
    expect(params?.repoRoot).toBe('<repoRoot>');
    expect(
      AGENT_TEAMS_SAGA.templateVars,
      'the <repoRoot> placeholder must have a matching declared templateVar',
    ).toContain('repoRoot');
  });
});

// ─── DR-3: the frozen delegation stamp reaches the gate that consumes it ─────
//
// `riskTier` / `boundaryTouching` are resolved and FROZEN at prepare_delegation
// (`classifyTasksFailClosed` → `classifyTask` → `deriveRiskTier` /
// `deriveBoundaryTouching`). The defect: neither was a param nor a templateVar
// on TASK_COMPLETION / TASK_FIX, so every dispatch reached
// `interpretProbeVerdict` / `resolvePolicySkip` with an UNDEFINED tier and the
// frozen stamp never arrived at the gate.
//
// These tests exercise the real seam end to end — the production classifier
// produces the stamp, the runbook's declared templateVars + step params carry
// it, and the real gate code reads it. Nothing about the tier is a literal
// authored by the test: every asserted value is compared against the stamp the
// classifier froze.

/** Task fixtures. Their tiers are DERIVED by the production heuristic below,
 *  never asserted from a hand-written tier on the input. */
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

/**
 * Run the wave through the SAME classification boundary
 * `handlePrepareDelegation` calls, and return the frozen stamp for one task.
 */
function freezeDelegationStamp(task: TaskInput): TaskClassification {
  const classified = classifyTasksFailClosed([task]);
  if (!classified.ok) throw new Error(classified.blocked.reason);
  const stamp = classified.classifications[0];
  if (!stamp) throw new Error('prepare_delegation produced no classification');
  return stamp;
}

/**
 * The dispatch variables the orchestrator resolves for a task — the runbook's
 * `templateVars` filled from the frozen stamp plus the usual task coordinates.
 */
function dispatchVarsFrom(stamp: TaskClassification): Readonly<Record<string, unknown>> {
  return {
    taskId: stamp.taskId,
    featureId: 'wc-t04',
    streamId: 'wc-t04',
    branch: `task/${stamp.taskId}`,
    agentId: `agent-${stamp.taskId}`,
    failureContext: 'previous attempt failed',
    worktreePath: `/tmp/worktrees/${stamp.taskId}`,
    // The FROZEN stamp — read off the classification, never authored here.
    riskTier: stamp.riskTier,
    boundaryTouching: stamp.boundaryTouching,
  };
}

/**
 * The orchestrator's fill-in step: resolve a step's `<var>` placeholders from
 * the dispatch variables. A placeholder that is not a DECLARED templateVar is
 * exactly the DR-3 defect — the orchestrator has no contract obliging it to
 * supply that value — so the harness refuses to fill it.
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

/** Dispatch a runbook's adequacy step and return the params the gate receives. */
function dispatchAdequacyParams(
  runbook: RunbookDefinition,
  stamp: TaskClassification,
): Readonly<Record<string, unknown>> {
  return fillStepParams(runbook, adequacyStepOf(runbook), dispatchVarsFrom(stamp));
}

// The probe short-circuits on `no-new-tests` BEFORE it touches the tree, so
// these seams must never be reached. They throw rather than returning a stub
// value, so a change that made the probe mutate a real tree fails loudly.
const unreachableGitExec = (): never => {
  throw new Error('git must not run — the probe short-circuits before any tree mutation');
};
const unreachableRunTests = (): never => {
  throw new Error('the test command must not run — there are no probe-able tests');
};

/** A task diff that changes source but adds NO probe-able tests. */
const SOURCE_ONLY_DIFF = ['src/api/openapi.yaml'];

async function runGateWithParams(params: Readonly<Record<string, unknown>>) {
  return runProbe({
    gitExec: unreachableGitExec,
    runTests: unreachableRunTests,
    repoRoot: '/tmp/worktrees/unused',
    baseRef: 'main',
    changedFiles: SOURCE_ONLY_DIFF,
    // The gate reads the tier off the DISPATCHED params — the same object the
    // runbook filled from the frozen stamp.
    ...(params['riskTier'] === undefined ? {} : { riskTier: params['riskTier'] as string }),
  });
}

describe('DR-3 — delegation stamp threading (prepare_delegation → runbook → gate)', () => {
  it('DelegationStamp_UndefinedTier_CharacterizesTheVacuousAdvisoryPass', async () => {
    // CHARACTERIZATION of the pre-DR-3 behavior. The stamp said HIGH, but the
    // runbook carried no tier, so `interpretProbeVerdict` was called with
    // `undefined` — and a high-tier task that added NO probe-able tests came
    // back as a PASS. This is the exact hole DR-3 closes; it is pinned here so
    // the "undefined tier launders an unverified task into a pass" mechanism
    // stays visible and cannot be quietly re-introduced as acceptable.
    const stamp = freezeDelegationStamp(HIGH_BOUNDARY_TASK);
    expect(stamp.riskTier).toBe('high');

    const unstamped = await runGateWithParams({});
    expect(unstamped.passed).toBe(true);
    expect(unstamped.skipped).toBe(true);
    expect(unstamped.disposition).toBe('advisory-skip');

    // The SAME verdict, read at the stamp's tier, blocks. Only the tier the
    // gate received differed — which is why the tier must reach the gate.
    const atStampedTier = interpretProbeVerdict(unstamped.verdict, stamp.riskTier);
    expect(atStampedTier.passed).toBe(false);

    // And `boundaryTouching` never arrived either, so the policy router saw a
    // half-resolved profile and declined to route at all.
    expect(
      resolvePolicySkip({ gateName: 'check_test_adequacy', riskTier: stamp.riskTier }),
    ).toBeNull();
  });

  it('TaskCompletion_DelegationStamp_DeliversRiskTierToGate', async () => {
    // ── HIGH tier: the stamp must arrive, and the gate must BLOCK ──────────
    const highStamp = freezeDelegationStamp(HIGH_BOUNDARY_TASK);
    const highParams = dispatchAdequacyParams(TASK_COMPLETION, highStamp);

    // The value the gate receives IS the frozen stamp — not a literal the test
    // injected. If the runbook drops the param, this is `undefined`.
    expect(highParams['riskTier']).toBe(highStamp.riskTier);
    expect(highParams['boundaryTouching']).toBe(highStamp.boundaryTouching);

    // Acceptance: a HIGH-tier task adding no probe-able tests returns passed:false.
    const highResult = await runGateWithParams(highParams);
    expect(highResult.passed).toBe(false);
    expect(highResult.skipped).toBeUndefined();
    expect(highResult.disposition).toBe('blocked');
    expect(highResult.report).toContain(highStamp.riskTier);

    // ── LOW tier: the same runbook, the same fill-in, a different stamp ────
    const lowStamp = freezeDelegationStamp(LOW_TASK);
    const lowParams = dispatchAdequacyParams(TASK_COMPLETION, lowStamp);
    expect(lowParams['riskTier']).toBe(lowStamp.riskTier);
    expect(lowStamp.riskTier).not.toBe(highStamp.riskTier);

    // Acceptance: a LOW-tier task returns passed:true, skipped:true.
    const lowResult = await runGateWithParams(lowParams);
    expect(lowResult.passed).toBe(true);
    expect(lowResult.skipped).toBe(true);
    expect(lowResult.disposition).toBe('advisory-skip');

    // Both dispatches came from the SAME runbook step through the SAME fill-in
    // and reached the gate with the same non-stamp params; only the frozen
    // stamp differed, so the tier is what drove the divergent verdicts.
    expect(Object.keys(highParams).sort()).toEqual(Object.keys(lowParams).sort());
    expect(highParams['repoRoot']).toBe(lowParams['repoRoot']);
    expect(highParams['riskTier']).not.toBe(lowParams['riskTier']);
  });

  it('TaskFix_DelegationStamp_DeliversBoundaryTouchingToGate', async () => {
    // The fix chain must meet the same adequacy bar as a first-time completion,
    // so TASK_FIX threads the same frozen stamp. `boundaryTouching` is consumed
    // by the ladder router (`resolvePolicySkip`), which requires BOTH stamps —
    // a half-resolved profile is treated as no profile and never routes.
    const lowStamp = freezeDelegationStamp(LOW_TASK);
    const lowParams = dispatchAdequacyParams(TASK_FIX, lowStamp);

    // The boolean arriving at the gate IS the frozen stamp's, not a literal.
    expect(typeof lowStamp.boundaryTouching).toBe('boolean');
    expect(lowParams['boundaryTouching']).toBe(lowStamp.boundaryTouching);
    expect(lowParams['riskTier']).toBe(lowStamp.riskTier);

    // With BOTH stamps delivered the router can act: check_test_adequacy is not
    // in the low-tier sequence, so the gate self-skips by policy.
    const routed = resolvePolicySkip({
      gateName: 'check_test_adequacy',
      riskTier: lowParams['riskTier'] as 'low' | 'medium' | 'high',
      boundaryTouching: lowParams['boundaryTouching'] as boolean,
    });
    expect(routed).not.toBeNull();
    expect(routed?.reason).toContain(`boundaryTouching=${lowStamp.boundaryTouching}`);
    expect(routed?.reason).toContain(`riskTier='${lowStamp.riskTier}'`);

    // Drop ONLY boundaryTouching (the pre-DR-3 dispatch) and the router goes
    // blind again — which is why the flag, not just the tier, must be threaded.
    expect(
      resolvePolicySkip({
        gateName: 'check_test_adequacy',
        riskTier: lowParams['riskTier'] as 'low' | 'medium' | 'high',
      }),
    ).toBeNull();

    // A HIGH boundary-touching stamp keeps the gate IN the sequence — the same
    // threading, the opposite routing decision.
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

    // …and the gate that does run blocks the un-probed high-tier fix.
    const highResult = await runGateWithParams(highParams);
    expect(highResult.passed).toBe(false);
  });
});

