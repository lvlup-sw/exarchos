import { describe, it, expect } from 'vitest';
import type { RunbookStep, RunbookDefinition, ResolvedRunbookStep } from './types.js';

describe('Runbook types', () => {
  it('RunbookStep_ValidStep_Compiles', () => {
    const step: RunbookStep = {
      tool: 'exarchos_orchestrate',
      action: 'check_tdd_compliance',
      onFail: 'stop',
    };
    expect(step.tool).toBe('exarchos_orchestrate');
    expect(step.onFail).toBe('stop');
  });

  it('RunbookStep_WithOptionalFields_Compiles', () => {
    const step: RunbookStep = {
      tool: 'exarchos_event',
      action: 'append',
      onFail: 'continue',
      params: { type: 'team.spawned' },
      note: 'Event-first: emit before TeamCreate',
    };
    expect(step.params).toEqual({ type: 'team.spawned' });
    expect(step.note).toBeDefined();
  });

  it('RunbookDefinition_ValidDefinition_Compiles', () => {
    const def: RunbookDefinition = {
      id: 'test-runbook',
      phase: 'delegate',
      description: 'A test runbook',
      steps: [
        { tool: 'exarchos_orchestrate', action: 'task_complete', onFail: 'stop' },
      ],
      templateVars: ['taskId'],
      autoEmits: ['task.completed'],
    };
    expect(def.id).toBe('test-runbook');
    expect(def.steps).toHaveLength(1);
  });

  it('ResolvedRunbookStep_HasSeqAndSchema', () => {
    const resolved: ResolvedRunbookStep = {
      seq: 1,
      tool: 'exarchos_orchestrate',
      action: 'check_tdd_compliance',
      onFail: 'stop',
      schema: { type: 'object', properties: {} },
      description: 'TDD compliance check',
      gate: { blocking: true, dimension: 'D1' },
    };
    expect(resolved.seq).toBe(1);
    expect(resolved.gate?.blocking).toBe(true);
  });
});
