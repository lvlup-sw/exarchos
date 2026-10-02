import { describe, it, expect } from 'vitest';
import { triageTrace } from './auto-triage.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import type { EvalCase } from './types.js';

function makeEvent(
  overrides: Partial<WorkflowEvent> & { type: string },
  sequence: number = 1,
): WorkflowEvent {
  return {
    streamId: 'test-stream',
    sequence,
    timestamp: '2025-01-01T00:00:00.000Z',
    schemaVersion: '1.0',
    ...overrides,
  } as WorkflowEvent;
}

/** Build a minimal successful workflow trace (started + transitions + gate passed + cleanup). */
function makeSuccessfulWorkflowTrace(skill: string = 'delegation'): WorkflowEvent[] {
  return [
    makeEvent({
      type: 'workflow.started',
      source: skill,
      data: { featureId: 'feat-1', workflowType: 'feature' },
    }, 1),
    makeEvent({
      type: 'workflow.transition',
      source: skill,
      data: { from: 'ideate', to: 'plan', trigger: 'auto', featureId: 'feat-1' },
    }, 2),
    makeEvent({
      type: 'gate.executed',
      source: skill,
      data: { gateName: 'typecheck', layer: 'build', passed: true },
    }, 3),
    makeEvent({
      type: 'task.completed',
      source: skill,
      data: { taskId: 'task-1', artifacts: ['file.ts'] },
    }, 4),
    makeEvent({
      type: 'workflow.cleanup',
      source: skill,
      data: { from: 'synthesize', to: 'completed', trigger: 'auto', featureId: 'feat-1' },
    }, 5),
  ];
}

/** Build a workflow trace that includes retries / self-corrections. */
function makeWorkflowWithRetries(skill: string = 'delegation'): WorkflowEvent[] {
  return [
    makeEvent({
      type: 'workflow.started',
      source: skill,
      data: { featureId: 'feat-2', workflowType: 'feature' },
    }, 1),
    makeEvent({
      type: 'workflow.transition',
      source: skill,
      data: { from: 'ideate', to: 'plan', trigger: 'auto', featureId: 'feat-2' },
    }, 2),
    makeEvent({
      type: 'task.failed',
      source: skill,
      data: { taskId: 'task-1', error: 'typecheck failed' },
    }, 3),
    makeEvent({
      type: 'workflow.fix-cycle',
      source: skill,
      data: { compoundStateId: 'delegate', count: 1, featureId: 'feat-2' },
    }, 4),
    makeEvent({
      type: 'task.completed',
      source: skill,
      data: { taskId: 'task-1', artifacts: ['fixed.ts'] },
    }, 5),
    makeEvent({
      type: 'workflow.cleanup',
      source: skill,
      data: { from: 'synthesize', to: 'completed', trigger: 'auto', featureId: 'feat-2' },
    }, 6),
  ];
}

/** Build a short trace with fewer than 3 events. */
function makeShortTrace(): WorkflowEvent[] {
  return [
    makeEvent({
      type: 'workflow.started',
      data: { featureId: 'feat-3', workflowType: 'feature' },
    }, 1),
    makeEvent({
      type: 'workflow.transition',
      data: { from: 'ideate', to: 'plan', trigger: 'auto', featureId: 'feat-3' },
    }, 2),
  ];
}

/** Build an incomplete workflow trace (no cleanup/completion terminal event). */
function makeIncompleteTrace(): WorkflowEvent[] {
  return [
    makeEvent({
      type: 'workflow.started',
      data: { featureId: 'feat-4', workflowType: 'feature' },
    }, 1),
    makeEvent({
      type: 'workflow.transition',
      data: { from: 'ideate', to: 'plan', trigger: 'auto', featureId: 'feat-4' },
    }, 2),
    makeEvent({
      type: 'task.assigned',
      data: { taskId: 'task-1', title: 'Implement feature' },
    }, 3),
    makeEvent({
      type: 'task.progressed',
      source: 'agent-1',
      agentId: 'agent-1',
      data: { taskId: 'task-1', tddPhase: 'red', detail: 'writing tests' },
    }, 4),
  ];
}

/** Build a workflow trace with novel tool patterns. */
function makeNovelPatternTrace(): WorkflowEvent[] {
  return [
    makeEvent({
      type: 'workflow.started',
      source: 'novel-skill',
      data: { featureId: 'feat-novel', workflowType: 'feature' },
    }, 1),
    makeEvent({
      type: 'workflow.transition',
      source: 'novel-skill',
      data: { from: 'ideate', to: 'plan', trigger: 'auto', featureId: 'feat-novel' },
    }, 2),
    makeEvent({
      type: 'tool.invoked',
      source: 'novel-skill',
      data: { tool: 'never-seen-tool' },
    }, 3),
    makeEvent({
      type: 'tool.completed',
      source: 'novel-skill',
      data: { tool: 'never-seen-tool', durationMs: 100, responseBytes: 500, tokenEstimate: 50 },
    }, 4),
    makeEvent({
      type: 'task.completed',
      source: 'novel-skill',
      data: { taskId: 'task-novel', artifacts: ['output.ts'] },
    }, 5),
    makeEvent({
      type: 'workflow.cleanup',
      source: 'novel-skill',
      data: { from: 'synthesize', to: 'completed', trigger: 'auto', featureId: 'feat-novel' },
    }, 6),
  ];
}

describe('triageTrace', () => {
  it('TriageTrace_EmptyEvents_ReturnsEmptyResult', () => {
    const events: WorkflowEvent[] = [];
    const existingDatasets = new Map<string, EvalCase[]>();

    const result = triageTrace(events, existingDatasets, {});

    expect(result).toEqual({
      regressionCandidates: [],
      capabilityCandidates: [],
      discarded: 0,
    });
  });

  it('TriageTrace_ShortTrace_Discards', () => {
    const events = makeShortTrace();
    const existingDatasets = new Map<string, EvalCase[]>();

    const result = triageTrace(events, existingDatasets, {});

    expect(result.regressionCandidates).toHaveLength(0);
    expect(result.capabilityCandidates).toHaveLength(0);
    expect(result.discarded).toBe(1);
  });

  it('TriageTrace_IncompleteWorkflow_Discards', () => {
    const events = makeIncompleteTrace();
    const existingDatasets = new Map<string, EvalCase[]>();

    const result = triageTrace(events, existingDatasets, {});

    expect(result.regressionCandidates).toHaveLength(0);
    expect(result.capabilityCandidates).toHaveLength(0);
    expect(result.discarded).toBe(1);
  });

  it('TriageTrace_SuccessfulWorkflow_ClassifiesAsRegression', () => {
    const events = makeSuccessfulWorkflowTrace('delegation');
    const existingDatasets = new Map<string, EvalCase[]>();

    const result = triageTrace(events, existingDatasets, { skill: 'delegation' });

    expect(result.regressionCandidates.length).toBeGreaterThan(0);
    expect(result.capabilityCandidates).toHaveLength(0);
    expect(result.discarded).toBe(0);
    for (const candidate of result.regressionCandidates) {
      expect(candidate.layer).toBe('regression');
      expect(candidate.type).toBe('trace');
    }
  });

  it('TriageTrace_WorkflowWithRetries_ClassifiesAsCapability', () => {
    const events = makeWorkflowWithRetries('delegation');
    const existingDatasets = new Map<string, EvalCase[]>();

    const result = triageTrace(events, existingDatasets, { skill: 'delegation' });

    expect(result.capabilityCandidates.length).toBeGreaterThan(0);
    expect(result.regressionCandidates).toHaveLength(0);
    expect(result.discarded).toBe(0);
    for (const candidate of result.capabilityCandidates) {
      expect(candidate.layer).toBe('capability');
      expect(candidate.type).toBe('trace');
    }
  });

  /**
   * The existing case mirrors what `captureTrace` makes from the same events. Its input is the
   * `workflow.transition` event, which replaces `workflow.started`, and its output is `task.completed`.
   */
  it('TriageTrace_DuplicateOfExisting_Discards', () => {
    const events = makeSuccessfulWorkflowTrace('delegation');
    const existingCase: EvalCase = {
      id: 'existing-case-1',
      type: 'trace',
      description: 'Existing captured trace',
      input: {
        from: 'ideate',
        to: 'plan',
        trigger: 'auto',
        featureId: 'feat-1',
        eventType: 'workflow.transition',
      },
      expected: {
        taskId: 'task-1',
        artifacts: ['file.ts'],
        eventType: 'task.completed',
      },
      tags: ['captured'],
      layer: 'regression',
    };
    const existingDatasets = new Map<string, EvalCase[]>([
      ['delegation', [existingCase]],
    ]);

    const result = triageTrace(events, existingDatasets, {
      skill: 'delegation',
      deduplicationThreshold: 0.9,
    });

    expect(result.regressionCandidates).toHaveLength(0);
    expect(result.capabilityCandidates).toHaveLength(0);
    expect(result.discarded).toBeGreaterThan(0);
  });

  /** A tool event marks a novel pattern, so the trace goes to capability. */
  it('TriageTrace_NovelPattern_ClassifiesAsCapability', () => {
    const events = makeNovelPatternTrace();
    const existingDatasets = new Map<string, EvalCase[]>();

    const result = triageTrace(events, existingDatasets, {});

    expect(result.capabilityCandidates.length).toBeGreaterThan(0);
    expect(result.discarded).toBe(0);
    for (const candidate of result.capabilityCandidates) {
      expect(candidate.layer).toBe('capability');
    }
  });

  /** `triageTrace` takes one trace, so the test checks that each trace gets exactly one classification. */
  it('TriageTrace_AllCategories_SumEqualsInput', () => {
    const successEvents = makeSuccessfulWorkflowTrace();
    const retryEvents = makeWorkflowWithRetries();
    const shortEvents = makeShortTrace();
    const incompleteEvents = makeIncompleteTrace();

    const existingDatasets = new Map<string, EvalCase[]>();

    const successResult = triageTrace(successEvents, existingDatasets, {});
    const retryResult = triageTrace(retryEvents, existingDatasets, {});
    const shortResult = triageTrace(shortEvents, existingDatasets, {});
    const incompleteResult = triageTrace(incompleteEvents, existingDatasets, {});

    for (const result of [successResult, retryResult, shortResult, incompleteResult]) {
      const total =
        result.regressionCandidates.length +
        result.capabilityCandidates.length +
        result.discarded;
      expect(total).toBe(1);
    }
  });

  it('TriageTrace_Determinism_SameInputSameOutput', () => {
    const events = makeSuccessfulWorkflowTrace();
    const existingDatasets = new Map<string, EvalCase[]>();
    const options = { skill: 'delegation' };

    const result1 = triageTrace(events, existingDatasets, options);
    const result2 = triageTrace(events, existingDatasets, options);

    expect(result1).toEqual(result2);
  });
});
