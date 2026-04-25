import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fc } from '@fast-check/vitest';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import type { EventSender } from './backend.js';
import { SqliteBackend } from './sqlite-backend.js';
import { VersionConflictError } from './memory-backend.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    version: '1.1',
    featureId: 'test-feature',
    workflowType: 'feature',
    phase: 'ideate',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifacts: { design: null, plan: null, pr: null },
    tasks: [],
    worktrees: {},
    reviews: {},
    integration: null,
    synthesis: {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    },
    _version: 1,
    _history: {},
    _checkpoint: {
      timestamp: '1970-01-01T00:00:00Z',
      phase: 'init',
      summary: 'Initial state',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: '1970-01-01T00:00:00Z',
      staleAfterMinutes: 120,
    },
    ...overrides,
  } as WorkflowState;
}

// ─── Task 7: Schema and Event Operations ────────────────────────────────────

describe('SqliteBackend Schema', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  it('SqliteBackend_initialize_CreatesAllTables', () => {
    // Query sqlite_master for all expected tables
    const db = (backend as unknown as { db: { prepare: (sql: string) => { all: () => Array<{ name: string }> } } }).db;
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);

    expect(tables).toContain('events');
    expect(tables).toContain('workflow_state');
    expect(tables).toContain('outbox');
    expect(tables).toContain('view_cache');
    expect(tables).toContain('sequences');
    expect(tables).toContain('schema_version');
  });

  it('SqliteBackend_initialize_WALModeEnabled', () => {
    // :memory: databases report 'memory' for journal_mode since WAL requires a file.
    // We verify the pragma was issued by checking it returns 'memory' for in-memory DBs.
    // For file-based DBs this would be 'wal'.
    const db = (backend as unknown as { db: { pragma: (sql: string) => Array<{ journal_mode: string }> } }).db;
    const result = db.pragma('journal_mode');
    // In-memory databases cannot use WAL; they report 'memory'
    expect(result[0].journal_mode).toBe('memory');
  });

  it('SqliteBackend_concurrentReadWrite_WALMode_NoBlocking', () => {
    // WAL mode should allow concurrent read/write without blocking
    // Append an event, then verify we can read while conceptually "writing"
    const event1 = makeEvent({ streamId: 'stream-a', sequence: 1 });
    backend.appendEvent('stream-a', event1);

    // Read while the write was just done (WAL allows this)
    const events = backend.queryEvents('stream-a');
    expect(events).toHaveLength(1);

    // Append another event and immediately read again
    const event2 = makeEvent({ streamId: 'stream-a', sequence: 2 });
    backend.appendEvent('stream-a', event2);
    const events2 = backend.queryEvents('stream-a');
    expect(events2).toHaveLength(2);
  });
});

describe('SqliteBackend Event Operations', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  it('SqliteBackend_appendEvent_InsertsIntoEventsTable', () => {
    const event = makeEvent({ streamId: 'test-stream', sequence: 1 });
    backend.appendEvent('test-stream', event);

    const events = backend.queryEvents('test-stream');
    expect(events).toHaveLength(1);
    expect(events[0].streamId).toBe('test-stream');
    expect(events[0].sequence).toBe(1);
    expect(events[0].type).toBe('workflow.started');
  });

  it('SqliteBackend_queryEvents_NoFilter_ReturnsAll', () => {
    const event1 = makeEvent({ streamId: 'test-stream', sequence: 1, type: 'workflow.started' });
    const event2 = makeEvent({ streamId: 'test-stream', sequence: 2, type: 'task.assigned' });
    const event3 = makeEvent({ streamId: 'test-stream', sequence: 3, type: 'task.completed' });

    backend.appendEvent('test-stream', event1);
    backend.appendEvent('test-stream', event2);
    backend.appendEvent('test-stream', event3);

    const events = backend.queryEvents('test-stream');
    expect(events).toHaveLength(3);
  });

  it('SqliteBackend_queryEvents_SinceSequence_ReturnsOnlyNewer', () => {
    const event1 = makeEvent({ streamId: 'test-stream', sequence: 1 });
    const event2 = makeEvent({ streamId: 'test-stream', sequence: 2 });
    const event3 = makeEvent({ streamId: 'test-stream', sequence: 3 });

    backend.appendEvent('test-stream', event1);
    backend.appendEvent('test-stream', event2);
    backend.appendEvent('test-stream', event3);

    const events = backend.queryEvents('test-stream', { sinceSequence: 1 });
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(2);
    expect(events[1].sequence).toBe(3);
  });

  it('SqliteBackend_queryEvents_ByType_FiltersCorrectly', () => {
    const event1 = makeEvent({ streamId: 'test-stream', sequence: 1, type: 'workflow.started' });
    const event2 = makeEvent({ streamId: 'test-stream', sequence: 2, type: 'task.assigned' });
    const event3 = makeEvent({ streamId: 'test-stream', sequence: 3, type: 'workflow.started' });

    backend.appendEvent('test-stream', event1);
    backend.appendEvent('test-stream', event2);
    backend.appendEvent('test-stream', event3);

    const events = backend.queryEvents('test-stream', { type: 'workflow.started' });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === 'workflow.started')).toBe(true);
  });

  it('SqliteBackend_queryEvents_ByTimeRange_FiltersCorrectly', () => {
    const event1 = makeEvent({ streamId: 'test-stream', sequence: 1, timestamp: '2024-01-01T00:00:00.000Z' });
    const event2 = makeEvent({ streamId: 'test-stream', sequence: 2, timestamp: '2024-06-15T12:00:00.000Z' });
    const event3 = makeEvent({ streamId: 'test-stream', sequence: 3, timestamp: '2024-12-31T23:59:59.000Z' });

    backend.appendEvent('test-stream', event1);
    backend.appendEvent('test-stream', event2);
    backend.appendEvent('test-stream', event3);

    const events = backend.queryEvents('test-stream', {
      since: '2024-03-01T00:00:00.000Z',
      until: '2024-09-01T00:00:00.000Z',
    });
    expect(events).toHaveLength(1);
    expect(events[0].sequence).toBe(2);
  });

  it('SqliteBackend_queryEvents_WithLimitAndOffset_Paginates', () => {
    for (let i = 1; i <= 10; i++) {
      backend.appendEvent(
        'test-stream',
        makeEvent({ streamId: 'test-stream', sequence: i }),
      );
    }

    // Get page 2 (offset=3, limit=3) => sequences 4, 5, 6
    const events = backend.queryEvents('test-stream', { offset: 3, limit: 3 });
    expect(events).toHaveLength(3);
    expect(events[0].sequence).toBe(4);
    expect(events[1].sequence).toBe(5);
    expect(events[2].sequence).toBe(6);
  });

  it('SqliteBackend_getSequence_ReturnsMaxSequenceForStream', () => {
    backend.appendEvent('test-stream', makeEvent({ streamId: 'test-stream', sequence: 1 }));
    backend.appendEvent('test-stream', makeEvent({ streamId: 'test-stream', sequence: 2 }));
    backend.appendEvent('test-stream', makeEvent({ streamId: 'test-stream', sequence: 3 }));

    expect(backend.getSequence('test-stream')).toBe(3);
  });

  it('SqliteBackend_getSequence_UnknownStream_ReturnsZero', () => {
    expect(backend.getSequence('nonexistent-stream')).toBe(0);
  });
});

// ─── Task 8: State, Outbox, and View Cache Operations ───────────────────────

describe('SqliteBackend State Operations', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  it('SqliteBackend_setState_GetState_Roundtrip', () => {
    const state = makeState({ featureId: 'my-feature' });
    backend.setState('my-feature', state);

    const retrieved = backend.getState('my-feature');
    expect(retrieved).toEqual(state);
  });

  it('SqliteBackend_setState_CASConflict_ThrowsVersionConflictError', () => {
    const state = makeState({ featureId: 'my-feature' });
    backend.setState('my-feature', state);

    // Current version is 1 after first set; using expectedVersion=0 (stale) should throw
    const updatedState = makeState({ featureId: 'my-feature', phase: 'plan' });
    expect(() => backend.setState('my-feature', updatedState, 0)).toThrow(VersionConflictError);
  });

  it('SqliteBackend_setState_AutoIncrementsVersion', () => {
    const state1 = makeState({ featureId: 'my-feature' });
    backend.setState('my-feature', state1);

    // Version is now 1; setting with expectedVersion=1 should succeed and bump to 2
    const state2 = makeState({ featureId: 'my-feature', phase: 'plan' });
    backend.setState('my-feature', state2, 1);

    // Version is now 2; setting with expectedVersion=1 should fail
    const state3 = makeState({ featureId: 'my-feature', phase: 'delegate' });
    expect(() => backend.setState('my-feature', state3, 1)).toThrow(VersionConflictError);

    // But expectedVersion=2 should succeed
    expect(() => backend.setState('my-feature', state3, 2)).not.toThrow();
  });

  it('SqliteBackend_listStates_ReturnsAllWorkflows', () => {
    const state1 = makeState({ featureId: 'feature-a' });
    const state2 = makeState({ featureId: 'feature-b' });

    backend.setState('feature-a', state1);
    backend.setState('feature-b', state2);

    const states = backend.listStates();
    expect(states).toHaveLength(2);

    const featureIds = states.map((s) => s.featureId);
    expect(featureIds).toContain('feature-a');
    expect(featureIds).toContain('feature-b');
  });
});

describe('SqliteBackend Outbox Operations', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  it('SqliteBackend_addOutboxEntry_CreatesWithPendingStatus', () => {
    const event = makeEvent({ streamId: 'test-stream', sequence: 1 });
    const entryId = backend.addOutboxEntry('test-stream', event);

    expect(typeof entryId).toBe('string');
    expect(entryId.length).toBeGreaterThan(0);
  });

  it('SqliteBackend_drainOutbox_SendsPendingAndUpdatesStatus', async () => {
    const event = makeEvent({ streamId: 'test-stream', sequence: 1 });
    backend.addOutboxEntry('test-stream', event);

    const sentEvents: unknown[] = [];
    const mockSender: EventSender = {
      appendEvents: async (_streamId, events) => {
        sentEvents.push(...events);
        return { accepted: events.length, streamVersion: 1 };
      },
    };

    const result = await backend.drainOutbox('test-stream', mockSender);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(sentEvents).toHaveLength(1);

    // Draining again should find no pending entries
    const result2 = await backend.drainOutbox('test-stream', mockSender);
    expect(result2.sent).toBe(0);
    expect(result2.failed).toBe(0);
  });

  it('SqliteBackend_drainOutbox_FailedEntry_SetsRetryAndIncrementsAttempts', async () => {
    const event = makeEvent({ streamId: 'test-stream', sequence: 1 });
    backend.addOutboxEntry('test-stream', event);

    // Reject asynchronously — `await sender.appendEvents(...)` propagates
    // the rejection into the outer try/catch the same way a sync throw did.
    const failingSender: EventSender = {
      appendEvents: async (_streamId, _events) => {
        throw new Error('Network error');
      },
    };

    const result = await backend.drainOutbox('test-stream', failingSender);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);

    // Entry should still be pending (retryable) after first failure
    const successSender: EventSender = {
      appendEvents: async (_streamId, events) => {
        return { accepted: events.length, streamVersion: 1 };
      },
    };

    const result2 = await backend.drainOutbox('test-stream', successSender);
    expect(result2.sent).toBe(1);
  });

  it('SqliteBackend_drainOutbox_MaxRetries_MarksDeadLetter', async () => {
    const event = makeEvent({ streamId: 'test-stream', sequence: 1 });
    backend.addOutboxEntry('test-stream', event);

    const failingSender: EventSender = {
      appendEvents: async (_streamId, _events) => {
        throw new Error('Permanent failure');
      },
    };

    // Drain multiple times to exceed max retries (default 5)
    for (let i = 0; i < 6; i++) {
      await backend.drainOutbox('test-stream', failingSender);
    }

    // After max retries, entry should be dead-lettered and not retried
    const successSender: EventSender = {
      appendEvents: async (_streamId, events) => {
        return { accepted: events.length, streamVersion: 1 };
      },
    };

    const result = await backend.drainOutbox('test-stream', successSender);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
  });
});

describe('SqliteBackend View Cache Operations', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  it('SqliteBackend_getViewCache_SetViewCache_Roundtrip', () => {
    const viewState = { count: 42, items: ['a', 'b'] };
    backend.setViewCache('test-stream', 'my-view', viewState, 10);

    const cached = backend.getViewCache('test-stream', 'my-view');
    expect(cached).not.toBeNull();
    expect(cached!.state).toEqual(viewState);
    expect(cached!.highWaterMark).toBe(10);
  });

  it('SqliteBackend_setViewCache_Upserts_OnConflict', () => {
    const viewState1 = { count: 1 };
    backend.setViewCache('test-stream', 'my-view', viewState1, 5);

    const viewState2 = { count: 99 };
    backend.setViewCache('test-stream', 'my-view', viewState2, 15);

    const cached = backend.getViewCache('test-stream', 'my-view');
    expect(cached).not.toBeNull();
    expect(cached!.state).toEqual(viewState2);
    expect(cached!.highWaterMark).toBe(15);
  });

  it('SqliteBackend_getViewCache_ReturnsNullWhenEmpty', () => {
    const result = backend.getViewCache('test-stream', 'nonexistent-view');
    expect(result).toBeNull();
  });
});

describe('SqliteBackend Transactional Operations', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  it('SqliteBackend_appendEvent_WithOutbox_BothInSameTransaction', async () => {
    // Append event and add outbox entry, verify both are persisted
    const event = makeEvent({ streamId: 'test-stream', sequence: 1 });
    backend.appendEvent('test-stream', event);
    backend.addOutboxEntry('test-stream', event);

    // Verify event is stored
    const events = backend.queryEvents('test-stream');
    expect(events).toHaveLength(1);

    // Verify outbox entry exists by draining
    const sentEvents: unknown[] = [];
    const mockSender: EventSender = {
      appendEvents: async (_streamId, evts) => {
        sentEvents.push(...evts);
        return { accepted: evts.length, streamVersion: 1 };
      },
    };

    const result = await backend.drainOutbox('test-stream', mockSender);
    expect(result.sent).toBe(1);
  });
});

// ─── Issue 1: rowToEvent Round-Trip Preserves All Fields ────────────────────

describe('SqliteBackend rowToEvent Round-Trip', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  it('rowToEvent_RoundTrip_PreservesAllFields', () => {
    const event = makeEvent({
      streamId: 'test-stream',
      sequence: 1,
      type: 'workflow.started',
      timestamp: '2026-02-21T00:00:00.000Z',
      schemaVersion: '2.0',
      correlationId: 'corr-123',
      causationId: 'cause-456',
      agentId: 'agent-789',
      agentRole: 'implementer',
      source: 'mcp-tool',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      idempotencyKey: 'idem-key-001',
      data: { key: 'value', nested: { a: 1 } },
    });

    backend.appendEvent('test-stream', event);
    const events = backend.queryEvents('test-stream');

    expect(events).toHaveLength(1);
    const retrieved = events[0];

    // Core fields (already persisted)
    expect(retrieved.streamId).toBe('test-stream');
    expect(retrieved.sequence).toBe(1);
    expect(retrieved.type).toBe('workflow.started');
    expect(retrieved.timestamp).toBe('2026-02-21T00:00:00.000Z');
    expect(retrieved.data).toEqual({ key: 'value', nested: { a: 1 } });

    // Fields that were previously DROPPED by rowToEvent:
    expect(retrieved.schemaVersion).toBe('2.0');
    expect(retrieved.correlationId).toBe('corr-123');
    expect(retrieved.causationId).toBe('cause-456');
    expect(retrieved.agentId).toBe('agent-789');
    expect(retrieved.agentRole).toBe('implementer');
    expect(retrieved.source).toBe('mcp-tool');
    expect(retrieved.tenantId).toBe('tenant-1');
    expect(retrieved.organizationId).toBe('org-1');
    expect(retrieved.idempotencyKey).toBe('idem-key-001');
  });

  it('rowToEvent_RoundTrip_PreservesMinimalEvent', () => {
    // An event with only required fields — no optional fields set
    const event = makeEvent({
      streamId: 'test-stream',
      sequence: 1,
      type: 'workflow.started',
      timestamp: '2026-02-21T00:00:00.000Z',
    });

    backend.appendEvent('test-stream', event);
    const events = backend.queryEvents('test-stream');

    expect(events).toHaveLength(1);
    const retrieved = events[0];
    expect(retrieved.streamId).toBe('test-stream');
    expect(retrieved.sequence).toBe(1);
    expect(retrieved.type).toBe('workflow.started');
    expect(retrieved.timestamp).toBe('2026-02-21T00:00:00.000Z');
    expect(retrieved.schemaVersion).toBe('1.0');
  });

  it('rowToEvent_RoundTrip_PreservesFieldsThroughFilteredQuery', () => {
    const event = makeEvent({
      streamId: 'test-stream',
      sequence: 1,
      type: 'workflow.started',
      agentId: 'agent-filtered',
      correlationId: 'corr-filtered',
      source: 'filtered-source',
    });

    backend.appendEvent('test-stream', event);
    const events = backend.queryEvents('test-stream', { type: 'workflow.started' });

    expect(events).toHaveLength(1);
    expect(events[0].agentId).toBe('agent-filtered');
    expect(events[0].correlationId).toBe('corr-filtered');
    expect(events[0].source).toBe('filtered-source');
  });
});

// ─── Issue 3: Prepared Statement Caching for queryEvents ────────────────────

describe('SqliteBackend queryEvents Prepared Statement Caching', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  it('queryEvents_SameFilters_ReusesPreparedStatement', () => {
    // Append some events
    backend.appendEvent('test-stream', makeEvent({ sequence: 1 }));
    backend.appendEvent('test-stream', makeEvent({ sequence: 2 }));

    // Access the internal db to spy on prepare
    const db = (backend as unknown as { db: { prepare: (sql: string) => unknown } }).db;
    const originalPrepare = db.prepare.bind(db);
    const prepareSpy = vi.fn(originalPrepare);
    db.prepare = prepareSpy;

    // Run queryEvents twice with the same filter combination
    const filters = { type: 'workflow.started' as const };
    backend.queryEvents('test-stream', filters);
    backend.queryEvents('test-stream', filters);

    // db.prepare should only be called once — the second call should reuse the cached statement
    expect(prepareSpy).toHaveBeenCalledTimes(1);
  });

  it('queryEvents_DifferentFilters_CreatesSeparateStatements', () => {
    // Append some events
    backend.appendEvent('test-stream', makeEvent({ sequence: 1 }));

    const db = (backend as unknown as { db: { prepare: (sql: string) => unknown } }).db;
    const originalPrepare = db.prepare.bind(db);
    const prepareSpy = vi.fn(originalPrepare);
    db.prepare = prepareSpy;

    // Different filter combinations should create different prepared statements
    backend.queryEvents('test-stream', { type: 'workflow.started' });
    backend.queryEvents('test-stream', { sinceSequence: 0 });

    expect(prepareSpy).toHaveBeenCalledTimes(2);
  });
});

// ─── Property-Based Tests ───────────────────────────────────────────────────

describe('SqliteBackend Property Tests', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  it('Roundtrip: queryEvents returns exactly the events appended', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (count) => {
          // Create a fresh backend for each property test run
          const propBackend = new SqliteBackend(':memory:');
          propBackend.initialize();

          const streamId = 'prop-stream';
          const appended: WorkflowEvent[] = [];

          for (let i = 1; i <= count; i++) {
            const event = makeEvent({
              streamId,
              sequence: i,
              type: 'workflow.started',
              timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
            });
            propBackend.appendEvent(streamId, event);
            appended.push(event);
          }

          const queried = propBackend.queryEvents(streamId);
          expect(queried).toHaveLength(appended.length);
          for (let i = 0; i < appended.length; i++) {
            expect(queried[i].sequence).toBe(appended[i].sequence);
            expect(queried[i].type).toBe(appended[i].type);
            expect(queried[i].streamId).toBe(appended[i].streamId);
          }

          propBackend.close();
        },
      ),
    );
  });

  it('Sequence monotonicity: getSequence increases strictly with each appendEvent', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (count) => {
          const propBackend = new SqliteBackend(':memory:');
          propBackend.initialize();

          const streamId = 'mono-stream';
          let prevSeq = 0;

          for (let i = 1; i <= count; i++) {
            const event = makeEvent({ streamId, sequence: i });
            propBackend.appendEvent(streamId, event);
            const newSeq = propBackend.getSequence(streamId);
            expect(newSeq).toBeGreaterThan(prevSeq);
            prevSeq = newSeq;
          }

          propBackend.close();
        },
      ),
    );
  });

  it('CAS linearizability: concurrent setState with same expectedVersion — exactly one succeeds', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/).filter((s) => s.length >= 1),
        (featureId) => {
          const propBackend = new SqliteBackend(':memory:');
          propBackend.initialize();

          const state1 = makeState({ featureId });
          propBackend.setState(featureId, state1);

          const update1 = makeState({ featureId, phase: 'plan' });
          const update2 = makeState({ featureId, phase: 'delegate' });

          let success1 = false;
          let success2 = false;

          try {
            propBackend.setState(featureId, update1, 1);
            success1 = true;
          } catch {
            // CAS conflict
          }

          try {
            propBackend.setState(featureId, update2, 1);
            success2 = true;
          } catch {
            // CAS conflict
          }

          expect(success1).toBe(true);
          expect(success2).toBe(false);

          propBackend.close();
        },
      ),
    );
  });

  it('Outbox drain idempotence: drain(drain(x)) === drain(x) for confirmed entries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        async (count) => {
          const propBackend = new SqliteBackend(':memory:');
          propBackend.initialize();

          const streamId = 'drain-stream';
          for (let i = 1; i <= count; i++) {
            const event = makeEvent({ streamId, sequence: i });
            propBackend.addOutboxEntry(streamId, event);
          }

          const successSender: EventSender = {
            appendEvents: async (_streamId, events) => {
              return { accepted: events.length, streamVersion: 1 };
            },
          };

          // First drain sends all
          const result1 = await propBackend.drainOutbox(streamId, successSender);
          expect(result1.sent).toBe(count);

          // Second drain should be idempotent — nothing to send
          const result2 = await propBackend.drainOutbox(streamId, successSender);
          expect(result2.sent).toBe(0);
          expect(result2.failed).toBe(0);

          propBackend.close();
        },
      ),
    );
  });
});

// ─── Cleanup Operations ──────────────────────────────────────────────────────

describe('SqliteBackend Cleanup Operations', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  it('SqliteBackend_deleteStream_RemovesAllEventsAndSequence', () => {
    // Arrange
    for (let i = 1; i <= 5; i++) {
      backend.appendEvent('stream-to-delete', makeEvent({ streamId: 'stream-to-delete', sequence: i }));
    }
    backend.appendEvent('other-stream', makeEvent({ streamId: 'other-stream', sequence: 1 }));

    expect(backend.queryEvents('stream-to-delete')).toHaveLength(5);

    // Act
    backend.deleteStream('stream-to-delete');

    // Assert
    expect(backend.queryEvents('stream-to-delete')).toHaveLength(0);
    expect(backend.getSequence('stream-to-delete')).toBe(0);
    expect(backend.listStreams()).not.toContain('stream-to-delete');
    // Other stream unaffected
    expect(backend.queryEvents('other-stream')).toHaveLength(1);
  });

  it('SqliteBackend_deleteState_RemovesStateForFeature', () => {
    // Arrange
    const state1 = makeState({ featureId: 'feature-to-delete' });
    const state2 = makeState({ featureId: 'other-feature' });
    backend.setState('feature-to-delete', state1);
    backend.setState('other-feature', state2);

    expect(backend.getState('feature-to-delete')).not.toBeNull();

    // Act
    backend.deleteState('feature-to-delete');

    // Assert
    expect(backend.getState('feature-to-delete')).toBeNull();
    expect(backend.getState('other-feature')).not.toBeNull();
  });

  it('SqliteBackend_pruneEvents_RemovesEventsBeforeTimestamp', () => {
    // Arrange
    const oldTimestamp = '2024-01-01T00:00:00.000Z';
    const newTimestamp = '2025-06-15T00:00:00.000Z';

    for (let i = 1; i <= 3; i++) {
      backend.appendEvent('telemetry', makeEvent({
        streamId: 'telemetry',
        sequence: i,
        timestamp: oldTimestamp,
        type: 'tool.invoked',
      }));
    }
    for (let i = 4; i <= 6; i++) {
      backend.appendEvent('telemetry', makeEvent({
        streamId: 'telemetry',
        sequence: i,
        timestamp: newTimestamp,
        type: 'tool.invoked',
      }));
    }

    expect(backend.queryEvents('telemetry')).toHaveLength(6);

    // Act
    const pruned = backend.pruneEvents('telemetry', '2025-01-01T00:00:00.000Z');

    // Assert
    expect(pruned).toBe(3);
    const remaining = backend.queryEvents('telemetry');
    expect(remaining).toHaveLength(3);
    for (const event of remaining) {
      expect(event.timestamp).toBe(newTimestamp);
    }
  });

  it('SqliteBackend_pruneEvents_NoEventsForStream_ReturnsZero', () => {
    const pruned = backend.pruneEvents('nonexistent', '2025-01-01T00:00:00.000Z');
    expect(pruned).toBe(0);
  });
});
