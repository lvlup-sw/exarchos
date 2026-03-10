import { describe, it, expect } from 'vitest';
import {
  TASK_COMPLETION,
  QUALITY_EVALUATION,
  AGENT_TEAMS_SAGA,
  SYNTHESIS_FLOW,
  SHEPHERD_ITERATION,
  TASK_FIX,
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
    expect(ALL_RUNBOOKS).toHaveLength(12);
  });
});
