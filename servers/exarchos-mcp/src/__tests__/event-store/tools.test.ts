import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from '../../event-store/store.js';
import { handleEventAppend, handleEventQuery, registerEventTools } from '../../event-store/tools.js';

let tempDir: string;
let eventStore: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'event-tools-test-'));
  eventStore = new EventStore(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── Event Append Tool ──────────────────────────────────────────────────────

describe('handleEventAppend', () => {
  it('should append a valid event and return success', async () => {
    const result = await handleEventAppend(
      {
        stream: 'my-workflow',
        event: {
          type: 'workflow.started',
          data: { featureId: 'test-feature', workflowType: 'feature' },
        },
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.streamId).toBe('my-workflow');
    expect(result.data!.sequence).toBe(1);
    expect(result.data!.type).toBe('workflow.started');
  });

  it('should increment sequence on multiple appends', async () => {
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'workflow.started' } },
      tempDir,
      eventStore,
    );
    const result = await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'task.assigned' } },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    expect(result.data!.sequence).toBe(2);
  });

  it('should return error for missing stream', async () => {
    const result = await handleEventAppend(
      { stream: '', event: { type: 'task.assigned' } },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should return error for missing event type', async () => {
    const result = await handleEventAppend(
      { stream: 'my-workflow', event: {} },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should support optimistic concurrency via expectedSequence', async () => {
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'workflow.started' } },
      tempDir,
      eventStore,
    );

    // Correct expected sequence
    const result = await handleEventAppend(
      {
        stream: 'my-workflow',
        event: { type: 'task.assigned' },
        expectedSequence: 1,
      },
      tempDir,
      eventStore,
    );
    expect(result.success).toBe(true);
    expect(result.data!.sequence).toBe(2);
  });

  it('should return an EventAck with only streamId, sequence, type keys', async () => {
    const result = await handleEventAppend(
      {
        stream: 'my-workflow',
        event: {
          type: 'workflow.started',
          data: { featureId: 'test-feature', workflowType: 'feature' },
          correlationId: 'corr-1',
          agentId: 'agent-1',
        },
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    // Ack should contain ONLY these three keys
    const keys = Object.keys(result.data as Record<string, unknown>).sort();
    expect(keys).toEqual(['sequence', 'streamId', 'type']);

    // Must NOT contain full event fields
    const data = result.data as Record<string, unknown>;
    expect(data).not.toHaveProperty('correlationId');
    expect(data).not.toHaveProperty('causationId');
    expect(data).not.toHaveProperty('agentId');
    expect(data).not.toHaveProperty('data');
    expect(data).not.toHaveProperty('agentRole');
    expect(data).not.toHaveProperty('source');
    expect(data).not.toHaveProperty('timestamp');
    expect(data).not.toHaveProperty('schemaVersion');
  });

  it('should return ack with correct streamId, sequence, and type values', async () => {
    const result = await handleEventAppend(
      {
        stream: 'my-workflow',
        event: { type: 'workflow.started' },
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    const ack = result.data as { streamId: string; sequence: number; type: string };
    expect(ack.streamId).toBe('my-workflow');
    expect(ack.sequence).toBe(1);
    expect(ack.type).toBe('workflow.started');
  });

  it('should still persist full event to JSONL despite returning ack', async () => {
    await handleEventAppend(
      {
        stream: 'my-workflow',
        event: {
          type: 'workflow.started',
          data: { featureId: 'test-feature', workflowType: 'feature' },
          correlationId: 'corr-1',
          agentId: 'agent-1',
        },
      },
      tempDir,
      eventStore,
    );

    // Query the store to verify the full event is persisted
    const queryResult = await handleEventQuery({ stream: 'my-workflow' }, tempDir, eventStore);
    expect(queryResult.success).toBe(true);

    const events = queryResult.data as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].streamId).toBe('my-workflow');
    expect(events[0].sequence).toBe(1);
    expect(events[0].type).toBe('workflow.started');
    expect(events[0].data).toEqual({ featureId: 'test-feature', workflowType: 'feature' });
    expect(events[0].correlationId).toBe('corr-1');
    expect(events[0].agentId).toBe('agent-1');
  });

  it('should return conflict error for stale expectedSequence', async () => {
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'workflow.started' } },
      tempDir,
      eventStore,
    );
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'task.assigned' } },
      tempDir,
      eventStore,
    );

    // Expected 1, but actual is 2
    const result = await handleEventAppend(
      {
        stream: 'my-workflow',
        event: { type: 'workflow.transition' },
        expectedSequence: 1,
      },
      tempDir,
      eventStore,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SEQUENCE_CONFLICT');
  });
});

// ─── Event Query Tool ───────────────────────────────────────────────────────

describe('handleEventQuery', () => {
  it('should return all events for a stream', async () => {
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'workflow.started' } },
      tempDir,
      eventStore,
    );
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'task.assigned' } },
      tempDir,
      eventStore,
    );

    const result = await handleEventQuery({ stream: 'my-workflow' }, tempDir, eventStore);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('should filter by type', async () => {
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'workflow.started' } },
      tempDir,
      eventStore,
    );
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'task.assigned' } },
      tempDir,
      eventStore,
    );
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'workflow.started' } },
      tempDir,
      eventStore,
    );

    const result = await handleEventQuery(
      { stream: 'my-workflow', filter: { type: 'workflow.started' } },
      tempDir,
      eventStore,
    );
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('should filter by sinceSequence', async () => {
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'workflow.started' } },
      tempDir,
      eventStore,
    );
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'task.assigned' } },
      tempDir,
      eventStore,
    );
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'workflow.transition' } },
      tempDir,
      eventStore,
    );

    const result = await handleEventQuery(
      { stream: 'my-workflow', filter: { sinceSequence: 2 } },
      tempDir,
      eventStore,
    );
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data![0].sequence).toBe(3);
  });

  it('should return empty for nonexistent stream', async () => {
    const result = await handleEventQuery({ stream: 'nonexistent' }, tempDir, eventStore);
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('should return error when stream is missing', async () => {
    const result = await handleEventQuery({}, tempDir, eventStore);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ─── handleEventQuery Pagination ─────────────────────────────────────────────

describe('handleEventQuery Pagination', () => {
  it('handleEventQuery_WithLimit_PassesToStore', async () => {
    for (let i = 0; i < 5; i++) {
      await handleEventAppend(
        { stream: 'my-workflow', event: { type: 'task.assigned' } },
        tempDir,
        eventStore,
      );
    }

    const result = await handleEventQuery(
      { stream: 'my-workflow', limit: 2 },
      tempDir,
      eventStore,
    );
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('handleEventQuery_WithOffset_PassesToStore', async () => {
    for (let i = 0; i < 5; i++) {
      await handleEventAppend(
        { stream: 'my-workflow', event: { type: 'task.assigned' } },
        tempDir,
        eventStore,
      );
    }

    const result = await handleEventQuery(
      { stream: 'my-workflow', offset: 3 },
      tempDir,
      eventStore,
    );
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('handleEventQuery_WithLimitAndOffset_Combined', async () => {
    for (let i = 0; i < 10; i++) {
      await handleEventAppend(
        { stream: 'my-workflow', event: { type: 'task.assigned' } },
        tempDir,
        eventStore,
      );
    }

    const result = await handleEventQuery(
      { stream: 'my-workflow', limit: 3, offset: 2 },
      tempDir,
      eventStore,
    );
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(3);
  });
});

// ─── handleEventQuery Fields Projection ──────────────────────────────────────

describe('handleEventQuery Fields Projection', () => {
  it('handleEventQuery_WithFields_ReturnsOnlyRequestedFields', async () => {
    await handleEventAppend(
      {
        stream: 'my-workflow',
        event: {
          type: 'workflow.started',
          data: { featureId: 'test', workflowType: 'feature' },
          correlationId: 'corr-1',
          agentId: 'agent-1',
        },
      },
      tempDir,
      eventStore,
    );

    const result = await handleEventQuery(
      { stream: 'my-workflow', fields: ['type', 'sequence'] },
      tempDir,
      eventStore,
    );
    expect(result.success).toBe(true);
    const events = result.data as Record<string, unknown>[];
    expect(events).toHaveLength(1);

    // Only requested fields should be present
    const keys = Object.keys(events[0]).sort();
    expect(keys).toEqual(['sequence', 'type']);
    expect(events[0].type).toBe('workflow.started');
    expect(events[0].sequence).toBe(1);
  });

  it('handleEventQuery_WithFieldsTypeTimestamp_ReturnsMinimalEvents', async () => {
    await handleEventAppend(
      {
        stream: 'my-workflow',
        event: {
          type: 'workflow.started',
          data: { featureId: 'test', workflowType: 'feature' },
          agentId: 'agent-1',
        },
      },
      tempDir,
      eventStore,
    );
    await handleEventAppend(
      {
        stream: 'my-workflow',
        event: {
          type: 'task.assigned',
          data: { taskId: 'task-1', title: 'Test task' },
        },
      },
      tempDir,
      eventStore,
    );

    const result = await handleEventQuery(
      { stream: 'my-workflow', fields: ['type', 'timestamp'] },
      tempDir,
      eventStore,
    );
    expect(result.success).toBe(true);
    const events = result.data as Record<string, unknown>[];
    expect(events).toHaveLength(2);

    for (const event of events) {
      const keys = Object.keys(event).sort();
      expect(keys).toEqual(['timestamp', 'type']);
      expect(event).not.toHaveProperty('sequence');
      expect(event).not.toHaveProperty('streamId');
      expect(event).not.toHaveProperty('data');
      expect(event).not.toHaveProperty('agentId');
    }
  });

  it('handleEventQuery_WithoutFields_ReturnsFullEvents', async () => {
    await handleEventAppend(
      {
        stream: 'my-workflow',
        event: {
          type: 'workflow.started',
          data: { featureId: 'test', workflowType: 'feature' },
          correlationId: 'corr-1',
        },
      },
      tempDir,
      eventStore,
    );

    const result = await handleEventQuery(
      { stream: 'my-workflow' },
      tempDir,
      eventStore,
    );
    expect(result.success).toBe(true);
    const events = result.data as Record<string, unknown>[];
    expect(events).toHaveLength(1);

    // Full events should have standard fields
    expect(events[0]).toHaveProperty('type');
    expect(events[0]).toHaveProperty('sequence');
    expect(events[0]).toHaveProperty('streamId');
    expect(events[0]).toHaveProperty('timestamp');
    expect(events[0]).toHaveProperty('data');
    expect(events[0]).toHaveProperty('correlationId');
  });

  it('handleEventQuery_WithFieldsAndNonexistentField_SkipsMissingFields', async () => {
    await handleEventAppend(
      {
        stream: 'my-workflow',
        event: { type: 'workflow.started' },
      },
      tempDir,
      eventStore,
    );

    const result = await handleEventQuery(
      { stream: 'my-workflow', fields: ['type', 'nonexistent'] },
      tempDir,
      eventStore,
    );
    expect(result.success).toBe(true);
    const events = result.data as Record<string, unknown>[];
    expect(events).toHaveLength(1);

    // Only 'type' should be present; 'nonexistent' is skipped
    const keys = Object.keys(events[0]);
    expect(keys).toEqual(['type']);
  });
});

// ─── EventStore Consolidation ────────────────────────────────────────────────

describe('registerEventTools', () => {
  it('should accept eventStore parameter in registration', () => {
    const mockServer = { tool: vi.fn() } as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
    const store = new EventStore(tempDir);
    expect(() => registerEventTools(mockServer, tempDir, store)).not.toThrow();
    expect(registerEventTools.length).toBe(3);
  });

  it('should register handlers that use the provided EventStore', async () => {
    const store = new EventStore(tempDir);
    const mockServer = { tool: vi.fn() } as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
    registerEventTools(mockServer, tempDir, store);

    const result = await handleEventAppend(
      { stream: 'wf-consolidation', event: { type: 'workflow.started', data: { featureId: 'test', workflowType: 'feature' } } },
      tempDir,
      store,
    );
    expect(result.success).toBe(true);

    const events = await store.query('wf-consolidation');
    expect(events).toHaveLength(1);
  });

  it('eventStore threaded via parameter ensures consistent store usage', async () => {
    // EventStore is now threaded via DispatchContext — multiple calls with
    // the same store instance should share state (no orphan instances)
    const result1 = await handleEventAppend(
      { stream: 'wf-cache-test', event: { type: 'workflow.started', data: { featureId: 'cache1', workflowType: 'feature' } } },
      tempDir,
      eventStore,
    );
    expect(result1.success).toBe(true);

    const result2 = await handleEventAppend(
      { stream: 'wf-cache-test', event: { type: 'task.assigned', data: { taskId: 'task-1', title: 'Test' } } },
      tempDir,
      eventStore,
    );
    expect(result2.success).toBe(true);

    // Both events should be visible via query (same store instance)
    const queryResult = await handleEventQuery({ stream: 'wf-cache-test' }, tempDir, eventStore);
    expect(queryResult.success).toBe(true);
    expect(queryResult.data).toHaveLength(2);
  });
});
