import { describe, it, expect } from 'vitest';
import { captureTrace } from './trace-capture.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';

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

describe('captureTrace', () => {
  it('captureTrace_ValidStream_ExtractsInputOutputPairs', () => {
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

    const cases = captureTrace(events);

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

    const cases = captureTrace(events, { skill: 'delegation' });

    expect(cases.length).toBeGreaterThan(0);
    for (const evalCase of cases) {
      expect(evalCase.description).toContain('delegation');
    }
  });

  it('captureTrace_OutputFormat_ValidEvalCaseJSONL', () => {
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

    const cases = captureTrace(events);

    for (const evalCase of cases) {
      expect(typeof evalCase.id).toBe('string');
      expect(evalCase.id.length).toBeGreaterThan(0);
      expect(evalCase.type).toBe('trace');
      expect(typeof evalCase.description).toBe('string');
      expect(typeof evalCase.input).toBe('object');
      expect(typeof evalCase.expected).toBe('object');
      expect(Array.isArray(evalCase.tags)).toBe(true);
      expect(evalCase.tags).toContain('captured');

      const json = JSON.stringify(evalCase);
      const parsed = JSON.parse(json);
      expect(parsed.id).toBe(evalCase.id);
    }
  });

  /** A matched pair and then an input with no output give two cases: the pair and the unmatched input. */
  it('captureTrace_TrailingInputAfterPairs_CapturesUnmatched', () => {
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

    const cases = captureTrace(events);

    expect(cases).toHaveLength(2);
    expect(cases[0].id).toBe('trace-1-2');
    expect(cases[1].id).toBe('trace-3-unmatched');
    expect(cases[1].description).toContain('unmatched');
  });

  it('captureTrace_EmptyStream_ReturnsEmptyArray', () => {
    const events: WorkflowEvent[] = [];

    const cases = captureTrace(events);

    expect(cases).toEqual([]);
  });
});
