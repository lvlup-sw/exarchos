import { describe, it, expect } from 'vitest';
import { triageTrace } from './auto-triage.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { EvalCase } from './types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('triageTrace', () => {
  it('TriageTrace_EmptyEvents_ReturnsEmptyResult', () => {
    // Arrange
    const events: WorkflowEvent[] = [];
    const existingDatasets = new Map<string, EvalCase[]>();

    // Act
    const result = triageTrace(events, existingDatasets, {});

    // Assert
    expect(result).toEqual({
      regressionCandidates: [],
      capabilityCandidates: [],
      discarded: 0,
    });
  });

  it('TriageTrace_ShortTrace_Discards', () => {
    // Arrange — fewer than 3 events
    const events = makeShortTrace();
    const existingDatasets = new Map<string, EvalCase[]>();

    // Act
    const result = triageTrace(events, existingDatasets, {});

    // Assert
    expect(result.regressionCandidates).toHaveLength(0);
    expect(result.capabilityCandidates).toHaveLength(0);
    expect(result.discarded).toBe(1);
  });

  it('TriageTrace_IncompleteWorkflow_Discards', () => {
    // Arrange — workflow without completion/cleanup terminal event
    const events = makeIncompleteTrace();
    const existingDatasets = new Map<string, EvalCase[]>();

    // Act
    const result = triageTrace(events, existingDatasets, {});

    // Assert
    expect(result.regressionCandidates).toHaveLength(0);
    expect(result.capabilityCandidates).toHaveLength(0);
    expect(result.discarded).toBe(1);
  });

  it('TriageTrace_SuccessfulWorkflow_ClassifiesAsRegression', () => {
    // Arrange — completed workflow, all gates passed, known skill
    const events = makeSuccessfulWorkflowTrace('delegation');
    const existingDatasets = new Map<string, EvalCase[]>();

    // Act
    const result = triageTrace(events, existingDatasets, { skill: 'delegation' });

    // Assert
    expect(result.regressionCandidates.length).toBeGreaterThan(0);
    expect(result.capabilityCandidates).toHaveLength(0);
    expect(result.discarded).toBe(0);
    for (const candidate of result.regressionCandidates) {
      expect(candidate.layer).toBe('regression');
      expect(candidate.type).toBe('trace');
    }
  });

  it('TriageTrace_WorkflowWithRetries_ClassifiesAsCapability', () => {
    // Arrange — completed workflow with self-corrections / retries
    const events = makeWorkflowWithRetries('delegation');
    const existingDatasets = new Map<string, EvalCase[]>();

    // Act
    const result = triageTrace(events, existingDatasets, { skill: 'delegation' });

    // Assert
    expect(result.capabilityCandidates.length).toBeGreaterThan(0);
    expect(result.regressionCandidates).toHaveLength(0);
    expect(result.discarded).toBe(0);
    for (const candidate of result.capabilityCandidates) {
      expect(candidate.layer).toBe('capability');
      expect(candidate.type).toBe('trace');
    }
  });

  it('TriageTrace_DuplicateOfExisting_Discards', () => {
    // Arrange — events that are a near-duplicate of an existing dataset case
    const events = makeSuccessfulWorkflowTrace('delegation');
    // Existing case mirrors what captureTrace produces from same events:
    // input event is workflow.transition (overwrites workflow.started), output is task.completed
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

    // Act
    const result = triageTrace(events, existingDatasets, {
      skill: 'delegation',
      deduplicationThreshold: 0.9,
    });

    // Assert — should be discarded as duplicate
    expect(result.regressionCandidates).toHaveLength(0);
    expect(result.capabilityCandidates).toHaveLength(0);
    expect(result.discarded).toBeGreaterThan(0);
  });

  it('TriageTrace_NovelPattern_ClassifiesAsCapability', () => {
    // Arrange — completed workflow with novel tool patterns not in existing datasets
    const events = makeNovelPatternTrace();
    const existingDatasets = new Map<string, EvalCase[]>();

    // Act
    const result = triageTrace(events, existingDatasets, {});

    // Assert — novel patterns go to capability for human review
    expect(result.capabilityCandidates.length).toBeGreaterThan(0);
    expect(result.discarded).toBe(0);
    for (const candidate of result.capabilityCandidates) {
      expect(candidate.layer).toBe('capability');
    }
  });

  it('TriageTrace_AllCategories_SumEqualsInput', () => {
    // Arrange — a mix of traces in one call cannot be tested directly since
    // triageTrace operates on a single trace. Instead, we verify that for any
    // single trace, the count is conserved: regression + capability + discarded = 1
    // (each trace produces exactly one classification).

    const successEvents = makeSuccessfulWorkflowTrace();
    const retryEvents = makeWorkflowWithRetries();
    const shortEvents = makeShortTrace();
    const incompleteEvents = makeIncompleteTrace();

    const existingDatasets = new Map<string, EvalCase[]>();

    // Act
    const successResult = triageTrace(successEvents, existingDatasets, {});
    const retryResult = triageTrace(retryEvents, existingDatasets, {});
    const shortResult = triageTrace(shortEvents, existingDatasets, {});
    const incompleteResult = triageTrace(incompleteEvents, existingDatasets, {});

    // Assert — conservation: each input produces exactly 1 classification
    for (const result of [successResult, retryResult, shortResult, incompleteResult]) {
      const total =
        result.regressionCandidates.length +
        result.capabilityCandidates.length +
        result.discarded;
      expect(total).toBe(1);
    }
  });

  it('TriageTrace_Determinism_SameInputSameOutput', () => {
    // Arrange
    const events = makeSuccessfulWorkflowTrace();
    const existingDatasets = new Map<string, EvalCase[]>();
    const options = { skill: 'delegation' };

    // Act
    const result1 = triageTrace(events, existingDatasets, options);
    const result2 = triageTrace(events, existingDatasets, options);

    // Assert — same input produces identical output
    expect(result1).toEqual(result2);
  });
});
