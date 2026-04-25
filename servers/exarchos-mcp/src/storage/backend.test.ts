import { describe, it, expect } from 'vitest';
import type { StorageBackend, QueryFilters, ViewCacheEntry, DrainResult, EventSender } from './backend.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { WorkflowState } from '../workflow/types.js';

// ─── StorageBackend Interface Contract ──────────────────────────────────────

describe('StorageBackend Interface Contract', () => {
  it('StorageBackend_InterfaceContract_AllMethodsDefined', () => {
    // Verify that a conforming object satisfies the StorageBackend interface
    const backend: StorageBackend = {
      appendEvent: (_streamId: string, _event: WorkflowEvent): void => {},
      queryEvents: (_streamId: string, _filters?: QueryFilters): WorkflowEvent[] => [],
      getSequence: (_streamId: string): number => 0,
      listStreams: (): string[] => [],
      getState: (_featureId: string): WorkflowState | null => null,
      setState: (_featureId: string, _state: WorkflowState, _expectedVersion?: number): void => {},
      listStates: (): Array<{ featureId: string; state: WorkflowState }> => [],
      addOutboxEntry: (_streamId: string, _event: WorkflowEvent): string => '',
      drainOutbox: async (_streamId: string, _sender: EventSender, _batchSize?: number): Promise<DrainResult> => ({ sent: 0, failed: 0 }),
      getViewCache: (_streamId: string, _viewName: string): ViewCacheEntry | null => null,
      setViewCache: (_streamId: string, _viewName: string, _state: unknown, _hwm: number): void => {},
      deleteStream: (_streamId: string): void => {},
      deleteState: (_featureId: string): void => {},
      pruneEvents: (_streamId: string, _beforeTimestamp: string): number => 0,
      initialize: (): void => {},
      close: (): void => {},
    };

    // Verify all 16 methods exist
    expect(typeof backend.appendEvent).toBe('function');
    expect(typeof backend.queryEvents).toBe('function');
    expect(typeof backend.getSequence).toBe('function');
    expect(typeof backend.listStreams).toBe('function');
    expect(typeof backend.getState).toBe('function');
    expect(typeof backend.setState).toBe('function');
    expect(typeof backend.listStates).toBe('function');
    expect(typeof backend.addOutboxEntry).toBe('function');
    expect(typeof backend.drainOutbox).toBe('function');
    expect(typeof backend.getViewCache).toBe('function');
    expect(typeof backend.setViewCache).toBe('function');
    expect(typeof backend.deleteStream).toBe('function');
    expect(typeof backend.deleteState).toBe('function');
    expect(typeof backend.pruneEvents).toBe('function');
    expect(typeof backend.initialize).toBe('function');
    expect(typeof backend.close).toBe('function');
  });
});

// ─── InMemoryBackend Event Operations ───────────────────────────────────────

describe('InMemoryBackend Event Operations', () => {
  // Helper to create a minimal valid event
  function makeEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
    return {
      streamId: 'test-stream',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'workflow.started',
      schemaVersion: '1.0',
      ...overrides,
    } as WorkflowEvent;
  }

  it('InMemoryBackend_appendEvent_IncrementsSequence', async () => {
    const { InMemoryBackend } = await import('./memory-backend.js');
    const backend = new InMemoryBackend();
    backend.initialize();

    const event1 = makeEvent({ sequence: 1, type: 'workflow.started' });
    const event2 = makeEvent({ sequence: 2, type: 'task.assigned' });

    backend.appendEvent('test-stream', event1);
    backend.appendEvent('test-stream', event2);

    expect(backend.getSequence('test-stream')).toBe(2);
  });

  it('InMemoryBackend_queryEvents_FiltersBySinceSequence', async () => {
    const { InMemoryBackend } = await import('./memory-backend.js');
    const backend = new InMemoryBackend();
    backend.initialize();

    const event1 = makeEvent({ sequence: 1, type: 'workflow.started' });
    const event2 = makeEvent({ sequence: 2, type: 'task.assigned' });
    const event3 = makeEvent({ sequence: 3, type: 'task.completed' });

    backend.appendEvent('test-stream', event1);
    backend.appendEvent('test-stream', event2);
    backend.appendEvent('test-stream', event3);

    const result = backend.queryEvents('test-stream', { sinceSequence: 1 });
    expect(result).toHaveLength(2);
    expect(result[0].sequence).toBe(2);
    expect(result[1].sequence).toBe(3);
  });

  it('InMemoryBackend_queryEvents_FiltersByType', async () => {
    const { InMemoryBackend } = await import('./memory-backend.js');
    const backend = new InMemoryBackend();
    backend.initialize();

    const event1 = makeEvent({ sequence: 1, type: 'workflow.started' });
    const event2 = makeEvent({ sequence: 2, type: 'task.assigned' });
    const event3 = makeEvent({ sequence: 3, type: 'workflow.started' });

    backend.appendEvent('test-stream', event1);
    backend.appendEvent('test-stream', event2);
    backend.appendEvent('test-stream', event3);

    const result = backend.queryEvents('test-stream', { type: 'workflow.started' });
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.type === 'workflow.started')).toBe(true);
  });

  it('InMemoryBackend_getSequence_ReturnsZeroForUnknownStream', async () => {
    const { InMemoryBackend } = await import('./memory-backend.js');
    const backend = new InMemoryBackend();
    backend.initialize();

    expect(backend.getSequence('nonexistent-stream')).toBe(0);
  });
});
