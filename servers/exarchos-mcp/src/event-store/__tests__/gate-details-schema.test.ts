import { describe, it, expect } from 'vitest';
import { GateExecutedDetailsSchema } from '../schemas.js';
import {
  codeQualityProjection,
} from '../../views/code-quality-view.js';
import type { WorkflowEvent } from '../schemas.js';

const makeEvent = (type: string, data: Record<string, unknown>, seq = 1): WorkflowEvent => ({
  streamId: 'test',
  sequence: seq,
  timestamp: new Date().toISOString(),
  type: type as WorkflowEvent['type'],
  data,
  schemaVersion: '1.0',
});

describe('GateExecutedDetailsSchema', () => {
  it('GateExecutedDetailsSchema_WithPromptVersion_ParsesSuccessfully', () => {
    const input = { promptVersion: '2.1.0' };
    const result = GateExecutedDetailsSchema.parse(input);
    expect(result.promptVersion).toBe('2.1.0');
  });

  it('GateExecutedDetailsSchema_AllFieldsOptional_EmptyObjectValid', () => {
    const result = GateExecutedDetailsSchema.parse({});
    expect(result).toEqual({});
  });

  it('GateExecutedDetailsSchema_WithAllFields_ParsesSuccessfully', () => {
    const input = {
      skill: 'delegation',
      model: 'claude-opus-4-6',
      commit: 'abc123',
      reason: 'type error',
      category: 'typescript',
      taskId: 'task-1',
      attemptNumber: 1,
      promptVersion: '1.0.0',
    };
    const result = GateExecutedDetailsSchema.parse(input);
    expect(result).toEqual(input);
  });
});

describe('CodeQualityView - promptVersion', () => {
  it('CodeQualityView_GateWithPromptVersion_StoresInMetrics', () => {
    const state = codeQualityProjection.init();
    const event = makeEvent('gate.executed', {
      gateName: 'typecheck',
      layer: 'build',
      passed: true,
      duration: 1200,
      details: { skill: 'delegation', promptVersion: '2.1.0' },
    });

    const next = codeQualityProjection.apply(state, event);
    expect(next.skills['delegation']).toBeDefined();
    expect(next.skills['delegation'].latestPromptVersion).toBe('2.1.0');
  });
});
