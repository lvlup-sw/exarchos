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

  // ─── Decision Runbook Types ──────────────────────────────────────────

  it('DecisionField_ValidBranches_TypeChecks', () => {
    // Create a decision step that compiles correctly
    const step: RunbookStep = {
      tool: 'none',
      action: 'decide',
      onFail: 'stop' as const,
      decide: {
        question: 'Is the bug reproducible?',
        source: 'human' as const,
        branches: {
          'yes': { label: 'Reproducible', guidance: 'Write failing test first.', nextStep: 'check-scope' },
          'no': { label: 'Not reproducible', guidance: 'Investigate further.', escalate: true },
        },
      },
    };
    expect(step.decide?.question).toBe('Is the bug reproducible?');
    expect(step.decide?.branches['yes'].nextStep).toBe('check-scope');
    expect(step.decide?.branches['no'].escalate).toBe(true);
  });

  it('RunbookStep_WithoutDecide_StillValid', () => {
    // Existing steps without decide should still compile
    const step: RunbookStep = {
      tool: 'exarchos_orchestrate',
      action: 'check_tdd_compliance',
      onFail: 'stop' as const,
    };
    expect(step.decide).toBeUndefined();
  });

  it('ResolvedRunbookStep_WithDecide_IncludesDecisionFields', () => {
    const resolved: ResolvedRunbookStep = {
      seq: 1,
      tool: 'none',
      action: 'decide',
      onFail: 'stop' as const,
      decide: {
        question: 'Test question?',
        source: 'human' as const,
        branches: {
          'yes': { label: 'Yes', guidance: 'Do this.' },
        },
      },
    };
    expect(resolved.decide?.question).toBe('Test question?');
  });

  it('RunbookDefinition_WithDecisionSteps_IsValid', () => {
    const definition: RunbookDefinition = {
      id: 'test-decision',
      phase: 'test',
      description: 'Test decision runbook',
      steps: [
        {
          tool: 'none',
          action: 'decide',
          onFail: 'stop' as const,
          decide: {
            question: 'Choose a path?',
            source: 'human' as const,
            branches: {
              'a': { label: 'Path A', guidance: 'Go here.' },
              'b': { label: 'Path B', guidance: 'Go there.', escalate: true },
            },
          },
        },
      ],
      templateVars: [],
      autoEmits: [],
    };
    expect(definition.steps[0].decide?.branches['b'].escalate).toBe(true);
  });
});
