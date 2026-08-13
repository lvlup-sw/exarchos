import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { buildValidatedEvent, buildEvent } from './event-factory.js';

describe('buildValidatedEvent', () => {
  it('buildValidatedEvent_ValidInput_ReturnsWorkflowEvent', () => {
    const event = buildValidatedEvent('stream-1', 1, {
      type: 'workflow.started',
      data: { featureId: 'test-feature', workflowType: 'feature' },
    });
    expect(event.streamId).toBe('stream-1');
    expect(event.sequence).toBe(1);
    expect(event.type).toBe('workflow.started');
    expect(event.timestamp).toBeDefined();
  });

  it('buildValidatedEvent_InvalidInput_ThrowsZodError', () => {
    expect(() => buildValidatedEvent('', 1, { type: '' })).toThrow();
  });

  it('buildValidatedEvent_PreservesOptionalFields', () => {
    const event = buildValidatedEvent('stream-1', 1, {
      type: 'workflow.started',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      agentId: 'agent-1',
      source: 'test',
    });
    expect(event.correlationId).toBe('corr-1');
    expect(event.causationId).toBe('cause-1');
    expect(event.agentId).toBe('agent-1');
    expect(event.source).toBe('test');
  });

  it('buildValidatedEvent_PreservesProvidedTimestamp', () => {
    const fixedTime = '2025-01-15T10:00:00.000Z';
    const event = buildValidatedEvent('stream-1', 1, {
      type: 'workflow.started',
      timestamp: fixedTime,
    });
    expect(event.timestamp).toBe(fixedTime);
  });

  it('buildValidatedEvent_SetsSchemaVersionDefault', () => {
    const event = buildValidatedEvent('stream-1', 1, {
      type: 'workflow.started',
    });
    expect(event.schemaVersion).toBe('1.0');
  });

  // ─── T3: Type-specific data validation ──────────────────────────────────────

  it('BuildValidatedEvent_ModelEventWithValidData_Succeeds', () => {
    // team.spawned is a model event with a known data schema
    const event = buildValidatedEvent('stream-1', 1, {
      type: 'team.spawned',
      data: {
        teamSize: 3,
        teammateNames: ['a', 'b', 'c'],
        taskCount: 5,
        dispatchMode: 'agent-team',
      },
    });
    expect(event.type).toBe('team.spawned');
    expect(event.data).toBeDefined();
  });

  it('BuildValidatedEvent_ModelEventWithInvalidData_Throws', () => {
    // team.spawned with garbage data should throw a ZodError
    expect(() =>
      buildValidatedEvent('stream-1', 1, {
        type: 'team.spawned',
        data: { foo: 'bar' },
      }),
    ).toThrow(ZodError);
  });

  it('BuildValidatedEvent_AutoEventWithValidData_Succeeds', () => {
    // workflow.transition is auto-emitted but has a mapped schema — use valid data
    const event = buildValidatedEvent('stream-1', 1, {
      type: 'workflow.transition',
      data: {
        from: 'ideate',
        to: 'plan',
        trigger: 'approve',
        featureId: 'feat-1',
      },
    });
    expect(event.type).toBe('workflow.transition');
  });

  it('BuildValidatedEvent_EventWithNoData_Succeeds', () => {
    // event with data: undefined passes regardless of schema
    const event = buildValidatedEvent('stream-1', 1, {
      type: 'team.spawned',
    });
    expect(event.type).toBe('team.spawned');
    expect(event.data).toBeUndefined();
  });
});

describe('buildEvent', () => {
  it('buildEvent_ValidInput_ReturnsWorkflowEvent', () => {
    const event = buildEvent('stream-1', 1, {
      type: 'workflow.started',
      data: { featureId: 'test-feature', workflowType: 'feature' },
    });
    expect(event.streamId).toBe('stream-1');
    expect(event.sequence).toBe(1);
    expect(event.type).toBe('workflow.started');
  });

  it('buildEvent_InvalidInput_DoesNotThrow', () => {
    // buildEvent skips validation — invalid streamId/sequence won't throw
    expect(() => buildEvent('', 0, { type: 'workflow.started' })).not.toThrow();
  });

  it('buildEvent_SetsTimestampWhenMissing', () => {
    const before = new Date().toISOString();
    const event = buildEvent('stream-1', 1, {
      type: 'workflow.started',
    });
    const after = new Date().toISOString();
    expect(event.timestamp).toBeDefined();
    expect(event.timestamp >= before).toBe(true);
    expect(event.timestamp <= after).toBe(true);
    expect(event.schemaVersion).toBe('1.0');
  });

  it('buildEvent_PreservesProvidedTimestamp', () => {
    const fixedTime = '2025-01-15T10:00:00.000Z';
    const event = buildEvent('stream-1', 1, {
      type: 'workflow.started',
      timestamp: fixedTime,
    });
    expect(event.timestamp).toBe(fixedTime);
  });
});
