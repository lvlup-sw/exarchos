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

  it('TaskCompletion_HasThreeSteps_InCorrectOrder', () => {
    expect(TASK_COMPLETION.steps).toHaveLength(3);
    expect(TASK_COMPLETION.steps[0].action).toBe('check_tdd_compliance');
    expect(TASK_COMPLETION.steps[1].action).toBe('check_static_analysis');
    expect(TASK_COMPLETION.steps[2].action).toBe('task_complete');
    expect(TASK_COMPLETION.phase).toBe('delegate');
  });

  it('QualityEvaluation_HasFourSteps', () => {
    expect(QUALITY_EVALUATION.steps).toHaveLength(4);
    expect(QUALITY_EVALUATION.steps[0].action).toBe('check_static_analysis');
    expect(QUALITY_EVALUATION.steps[3].action).toBe('check_review_verdict');
    expect(QUALITY_EVALUATION.phase).toBe('review');
  });

  it('AgentTeamsSaga_HasElevenSteps', () => {
    expect(AGENT_TEAMS_SAGA.steps).toHaveLength(11);
    expect(AGENT_TEAMS_SAGA.phase).toBe('delegate');
    // First step should be event-first: team.spawned
    expect(AGENT_TEAMS_SAGA.steps[0].tool).toBe('exarchos_event');
    expect(AGENT_TEAMS_SAGA.steps[0].params?.type).toBe('team.spawned');
    // Last step should be workflow transition
    expect(AGENT_TEAMS_SAGA.steps[10].tool).toBe('exarchos_workflow');
    expect(AGENT_TEAMS_SAGA.steps[10].action).toBe('set');
  });

  it('SynthesisFlow_HasFourSteps', () => {
    expect(SYNTHESIS_FLOW.steps).toHaveLength(4);
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

  it('TaskFixRunbook_IncludesGateChain_TddThenStatic', () => {
    const actions = TASK_FIX.steps.map(s => s.action);
    const tddIndex = actions.indexOf('check_tdd_compliance');
    const staticIndex = actions.indexOf('check_static_analysis');
    expect(tddIndex).toBeGreaterThan(-1);
    expect(staticIndex).toBeGreaterThan(-1);
    expect(tddIndex).toBeLessThan(staticIndex);
  });

  it('TaskFixRunbook_TemplateVarsIncludeAgentId_ForResume', () => {
    expect(TASK_FIX.templateVars).toContain('agentId');
  });

  it('AllRunbooks_Count', () => {
    expect(ALL_RUNBOOKS).toHaveLength(14);
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
});
