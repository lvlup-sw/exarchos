import { describe, it, expect } from 'vitest';
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
    // buildEvent skips validation — empty strings won't throw
    expect(() => buildEvent('', 0, { type: '' })).not.toThrow();
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
