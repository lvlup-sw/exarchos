import { describe, it, expect } from 'vitest';
import { captureTrace } from './trace-capture.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('captureTrace', () => {
  it('captureTrace_ValidStream_ExtractsInputOutputPairs', () => {
    // Arrange — workflow started → transition in → transition out
    const events: WorkflowEvent[] = [
      makeEvent({
        type: 'workflow.started',
        data: { featureId: 'feat-1', workflowType: 'feature' },
      }, 1),
      makeEvent({
        type: 'workflow.transition',
        data: { from: 'ideate', to: 'plan', trigger: 'auto', featureId: 'feat-1' },
      }, 2),
      makeEvent({
        type: 'task.completed',
        data: { taskId: 'task-1', artifacts: ['file.ts'] },
      }, 3),
    ];

    // Act
    const cases = captureTrace(events);

    // Assert
    expect(cases.length).toBeGreaterThan(0);
    for (const evalCase of cases) {
      expect(evalCase.id).toBeTruthy();
      expect(evalCase.type).toBe('trace');
      expect(evalCase.input).toBeDefined();
      expect(evalCase.expected).toBeDefined();
      expect(evalCase.tags).toContain('captured');
    }
  });

  it('captureTrace_FilterBySkill_OnlyIncludesMatchingEvents', () => {
    // Arrange — events from different skills/sources
    const events: WorkflowEvent[] = [
      makeEvent({
        type: 'workflow.started',
        data: { featureId: 'feat-1', workflowType: 'feature' },
        source: 'delegation',
      }, 1),
      makeEvent({
        type: 'task.completed',
        data: { taskId: 'task-1' },
        source: 'delegation',
      }, 2),
      makeEvent({
        type: 'workflow.started',
        data: { featureId: 'feat-2', workflowType: 'debug' },
        source: 'quality-review',
      }, 3),
      makeEvent({
        type: 'task.completed',
        data: { taskId: 'task-2' },
        source: 'quality-review',
      }, 4),
    ];

    // Act
    const cases = captureTrace(events, { skill: 'delegation' });

    // Assert — only delegation events should be captured
    expect(cases.length).toBeGreaterThan(0);
    for (const evalCase of cases) {
      expect(evalCase.description).toContain('delegation');
    }
  });

  it('captureTrace_OutputFormat_ValidEvalCaseJSONL', () => {
    // Arrange
    const events: WorkflowEvent[] = [
      makeEvent({
        type: 'workflow.started',
        data: { featureId: 'feat-1', workflowType: 'feature' },
      }, 1),
      makeEvent({
        type: 'task.completed',
        data: { taskId: 'task-1', artifacts: ['output.ts'] },
      }, 2),
    ];

    // Act
    const cases = captureTrace(events);

    // Assert — each case should have the required EvalCase fields
    for (const evalCase of cases) {
      expect(typeof evalCase.id).toBe('string');
      expect(evalCase.id.length).toBeGreaterThan(0);
      expect(evalCase.type).toBe('trace');
      expect(typeof evalCase.description).toBe('string');
      expect(typeof evalCase.input).toBe('object');
      expect(typeof evalCase.expected).toBe('object');
      expect(Array.isArray(evalCase.tags)).toBe(true);
      expect(evalCase.tags).toContain('captured');

      // Should be valid JSON (for JSONL output)
      const json = JSON.stringify(evalCase);
      const parsed = JSON.parse(json);
      expect(parsed.id).toBe(evalCase.id);
    }
  });

  it('captureTrace_TrailingInputAfterPairs_CapturesUnmatched', () => {
    // Arrange — a matched pair followed by a trailing unmatched input
    const events: WorkflowEvent[] = [
      makeEvent({
        type: 'workflow.started',
        data: { featureId: 'feat-1', workflowType: 'feature' },
      }, 1),
      makeEvent({
        type: 'task.completed',
        data: { taskId: 'task-1' },
      }, 2),
      makeEvent({
        type: 'workflow.transition',
        data: { from: 'plan', to: 'delegate', trigger: 'auto', featureId: 'feat-1' },
      }, 3),
    ];

    // Act
    const cases = captureTrace(events);

    // Assert — should capture both the pair AND the trailing unmatched input
    expect(cases).toHaveLength(2);
    expect(cases[0].id).toBe('trace-1-2');
    expect(cases[1].id).toBe('trace-3-unmatched');
    expect(cases[1].description).toContain('unmatched');
  });

  it('captureTrace_EmptyStream_ReturnsEmptyArray', () => {
    // Arrange — empty events array
    const events: WorkflowEvent[] = [];

    // Act
    const cases = captureTrace(events);

    // Assert
    expect(cases).toEqual([]);
  });
});
