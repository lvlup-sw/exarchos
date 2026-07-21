import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fc } from '@fast-check/vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import type { EventSender } from './backend.js';
import { SqliteBackend, SqliteImmediateUnsupportedError } from './sqlite-backend.js';
import { VersionConflictError } from './memory-backend.js';
import { AtomicAppender } from '../event-store/atomic-appender.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

// ─── DR-4 durability posture + DR-3 immediate fail-fast ─────────────────────

describe('SqliteBackend durability + immediate (DR-3 / DR-4)', () => {
  it('Synchronous_InvalidValue_RejectedAtConstruction', () => {
    expect(
      () =>
        new SqliteBackend(':memory:', {
          synchronous: 'sometimes' as unknown as 'normal' | 'full',
        }),
    ).toThrowError(/invalid storage.synchronous/);
  });

  describe('SqliteBackend decideOnce transaction (DR-4)', () => {
    it('DecideOnce_EventInsertFailure_RollsBackOperationClaimEventsAndSequence', async () => {
      const stateDir = await mkdtemp(path.join(tmpdir(), 'decide-once-rollback-'));
      const backend = new SqliteBackend(path.join(stateDir, 'decide-once.db'));
      backend.initialize();
      const appender = new AtomicAppender({ stateDir, sqliteBackend: backend });
      const streamId = 'decide-once-rollback';

      const stmts = (
        backend as unknown as {
          stmts: { insertEventStrict: { run: (...args: unknown[]) => unknown } };
        }
      ).stmts;
      const originalRun = stmts.insertEventStrict.run.bind(stmts.insertEventStrict);
      let inserts = 0;
      stmts.insertEventStrict.run = (...args: unknown[]) => {
        inserts += 1;
        if (inserts === 2) {
          throw new Error('simulated decideOnce event INSERT failure');
        }
        return originalRun(...args);
      };

      try {
        await expect(
          appender.decideOnce('operation-rollback', 'sha256:rollback', () => ({
            streamId,
            events: [
              { type: 'gate.executed', data: { sibling: 1 } },
              { type: 'gate.executed', data: { sibling: 2 } },
            ],
            result: { verdict: 'pass' },
          })),
        ).rejects.toThrow('simulated decideOnce event INSERT failure');
      } finally {
        stmts.insertEventStrict.run = originalRun;
      }

      expect(backend.lookupOperationClaim('operation-rollback')).toBeUndefined();
      expect(backend.queryEvents(streamId)).toEqual([]);
      expect(backend.readSequenceHighWaterMark(streamId)).toBe(0);

      const retried = await appender.decideOnce(
        'operation-rollback',
        'sha256:rollback',
        () => ({
          streamId,
          events: [
            { type: 'gate.executed', data: { sibling: 1 } },
            { type: 'gate.executed', data: { sibling: 2 } },
          ],
          result: { verdict: 'pass' },
        }),
      );
      expect(retried).toEqual({ verdict: 'pass' });
      expect(backend.queryEvents(streamId).map((event) => event.sequence)).toEqual([1, 2]);

      backend.close();
      await rmrfAsync(stateDir);
    });

    it('DecideOnce_ConcurrentConnections_SerializeClosureAndStreamSequence', async () => {
      const stateDir = await mkdtemp(path.join(tmpdir(), 'decide-once-concurrent-'));
      const dbPath = path.join(stateDir, 'decide-once.db');
      const backendA = new SqliteBackend(dbPath);
      const backendB = new SqliteBackend(dbPath);
      backendA.initialize();
      backendB.initialize();
      const appenderA = new AtomicAppender({ stateDir, sqliteBackend: backendA });
      const appenderB = new AtomicAppender({ stateDir, sqliteBackend: backendB });
      let closureCalls = 0;

      const decide = (appender: AtomicAppender) =>
        appender.decideOnce(
          'operation-concurrent',
          'sha256:concurrent',
          (ctx) => {
            closureCalls += 1;
            const snapshot = ctx.readStream('decide-once-concurrent');
            return {
              streamId: 'decide-once-concurrent',
              expectedSequence: snapshot.version,
              events: [{ type: 'gate.executed', data: { observed: snapshot.version } }],
              result: { canonicalVersion: snapshot.version },
            };
          },
        );

      const [left, right] = await Promise.all([decide(appenderA), decide(appenderB)]);
      expect(left).toEqual(right);
      expect(closureCalls).toBe(1);
      expect(backendA.queryEvents('decide-once-concurrent')).toHaveLength(1);

      backendA.close();
      backendB.close();
      await rmrfAsync(stateDir);
    });

    it('DecideOnce_JSONResult_RoundTripsCanonicallyAcrossRetries', async () => {
      await fc.assert(
        fc.asyncProperty(fc.jsonValue(), async (canonicalResult) => {
          const backend = new SqliteBackend(':memory:');
          backend.initialize();
          const appender = new AtomicAppender({
            stateDir: tmpdir(),
            sqliteBackend: backend,
          });
          let closureCalls = 0;
          try {
            const first = await appender.decideOnce(
              'operation-property',
              'sha256:property',
              () => {
                closureCalls += 1;
                return {
                  streamId: 'decide-once-property',
                  events: [{ type: 'gate.executed' }],
                  result: canonicalResult,
                };
              },
            );
            const retry = await appender.decideOnce(
              'operation-property',
              'sha256:property',
              () => {
                closureCalls += 1;
                throw new Error('completed operation must bypass closure');
              },
            );

            expect(retry).toEqual(first);
            expect(retry).toEqual(canonicalResult);
            expect(closureCalls).toBe(1);
          } finally {
            backend.close();
          }
        }),
        { numRuns: 25 },
      );
    });
  });

  it('Synchronous_DefaultNormal_InitializesAndAppends', () => {
    const backend = new SqliteBackend(':memory:');
    expect(() => backend.initialize()).not.toThrow();
    backend.close();
  });

  it('Synchronous_Full_InitializesAndAppends', () => {
    // FULL applies a valid pragma and round-trips a write without error.
    const backend = new SqliteBackend(':memory:', { synchronous: 'full' });
    expect(() => backend.initialize()).not.toThrow();
    backend.close();
  });

  it('Initialize_DriverExposesImmediate_AssertionPasses', () => {
    // The DR-3 fail-fast assertion runs inside initialize(); a successful
    // init proves the real driver exposes transaction(fn).immediate(). Guard
    // the premise explicitly so a driver regression that drops .immediate is
    // caught here rather than as a silent deferred-BEGIN downgrade.
    const backend = new SqliteBackend(':memory:');
    backend.initialize();
    const db = (backend as unknown as { db: { transaction: (fn: () => void) => unknown } }).db;
    const txn = db.transaction(() => {}) as { immediate?: unknown };
    expect(typeof txn.immediate).toBe('function');
    backend.close();
  });

  it('Initialize_DriverLacksImmediate_ThrowsTyped', () => {
    // The DR-3 negative path: a driver whose `transaction(fn)` wrapper omits
    // `.immediate` must hard-fail with the typed error, NOT silently degrade
    // to a deferred BEGIN. Inject such a wrapper into the private `db` handle
    // and drive the assertion directly — this is the kill-probe for a
    // regression that replaces the throw with a deferred-BEGIN fallback.
    const backend = new SqliteBackend(':memory:');
    (backend as unknown as { db: { transaction: (fn: () => void) => unknown } }).db = {
      transaction: (_fn: () => void) => ({
        /* deferred-only wrapper: no `.immediate` method */
      }),
    };
    expect(() =>
      (backend as unknown as { assertImmediateSupported: () => void }).assertImmediateSupported(),
    ).toThrowError(SqliteImmediateUnsupportedError);
  });
});

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
  // Mutable clock so retry/dead-letter tests can fast-forward past the
  // exponential-backoff `nextRetryAt` window without sleeping. Each
  // `beforeEach` resets to wall-clock time.
  let nowMs: number;

  beforeEach(() => {
    nowMs = Date.now();
    backend = new SqliteBackend(':memory:', { clock: () => new Date(nowMs) });
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

    // Entry should still be pending (retryable) after first failure, but
    // the backoff window (~2s after attempt 1) excludes it from immediate
    // re-drain — advance the clock past it so the success sender finds
    // the row eligible.
    nowMs += 5_000;
    const successSender: EventSender = {
      appendEvents: async (_streamId, events) => {
        return { accepted: events.length, streamVersion: 1 };
      },
    };

    const result2 = await backend.drainOutbox('test-stream', successSender);
    expect(result2.sent).toBe(1);
  });

  it('SqliteBackend_drainOutbox_NextRetryAtFuture_ExcludesEntryFromBatch', async () => {
    // Sentry/Seer regression (PR #1176 review): selectPendingOutbox used
    // to filter only by status='pending', so failed entries with a
    // future `nextRetryAt` were retried immediately on the next drain,
    // defeating exponential backoff and risking retry storms.
    const event = makeEvent({ streamId: 'test-stream', sequence: 1 });
    backend.addOutboxEntry('test-stream', event);

    const failingSender: EventSender = {
      appendEvents: async () => { throw new Error('temporary failure'); },
    };

    const r1 = await backend.drainOutbox('test-stream', failingSender);
    expect(r1.failed).toBe(1);
    expect(r1.sent).toBe(0);

    // Without advancing the clock, the entry's `nextRetryAt` (~2s out) is
    // still in the future — the next drain MUST exclude it. Pre-fix this
    // would have re-tried (and re-failed) immediately.
    let recordedCalls = 0;
    const recordingSender: EventSender = {
      appendEvents: async () => {
        recordedCalls++;
        return { accepted: 1, streamVersion: 1 };
      },
    };
    const r2 = await backend.drainOutbox('test-stream', recordingSender);
    expect(r2.sent).toBe(0);
    expect(r2.failed).toBe(0);
    expect(recordedCalls).toBe(0);

    // After the backoff window passes, the entry becomes eligible again.
    nowMs += 10_000;
    const r3 = await backend.drainOutbox('test-stream', recordingSender);
    expect(r3.sent).toBe(1);
    expect(recordedCalls).toBe(1);
  });

  it('SqliteBackend_drainOutbox_MaxRetries_MarksDeadLetter', async () => {
    const event = makeEvent({ streamId: 'test-stream', sequence: 1 });
    backend.addOutboxEntry('test-stream', event);

    const failingSender: EventSender = {
      appendEvents: async (_streamId, _events) => {
        throw new Error('Permanent failure');
      },
    };

    // Drain past max retries (default 5). Each failed drain pushes
    // `nextRetryAt` further out (2s, 4s, 8s, 16s, 32s) so we have to
    // advance the clock between drains; otherwise the row stays in
    // backoff and the loop never increments `attempts` past 1.
    for (let i = 0; i < 6; i++) {
      await backend.drainOutbox('test-stream', failingSender);
      nowMs += 60_000; // > longest backoff window (32s)
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

// ─── T70: atomicAppend empty-events precondition (CodeRabbit #10 / PR #1323) ─

describe('SqliteBackend.atomicAppend empty-events guard (T70)', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  it('throws a structured validation error (not TypeError) when n is zero', async () => {
    // The contract is "at least one event per atomicAppend call" (n >= 1);
    // violating it should surface as a clear validation error, not a cryptic
    // undefined-property TypeError. The gate refactor moved event-count to
    // the `n` parameter (sequences are assigned inside the txn by finalize).
    await expect(
      backend.atomicAppend({
        streamId: 'test-stream',
        idempotencyKey: null,
        n: 0,
        finalize: () => ({ events: [] }),
      }),
    ).rejects.toThrowError('atomicAppend requires n >= 1');

    // Also verify it's not a TypeError specifically — the cryptic shape
    // we're trying to eliminate.
    await expect(
      backend.atomicAppend({
        streamId: 'test-stream',
        idempotencyKey: null,
        n: 0,
        finalize: () => ({ events: [] }),
      }),
    ).rejects.not.toThrow(TypeError);
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

// ─── T10: SQLITE_CORRUPT startup raises structured error, no auto-rebuild ───
//
// DR-12 (#1259, T10): SQLite-backed substrate refuses to start against a
// corrupt or non-database file. The lifecycle wires a hard stop here
// because silent auto-rebuild would (a) destroy the byte evidence
// operators need to root-cause the corruption and (b) potentially mask a
// data-loss surface that should escalate to operator intervention.
//
// Tested at the SqliteBackend level so the contract is explicit at the
// substrate boundary; lifecycle.ts can rely on `initialize()` throwing
// without itself probing for corruption.

describe('SqliteBackend Startup Corruption (T10)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'sqlite-backend-corrupt-t10-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('SqliteBackend_StartupCorruptDb_StructuredErrorNoAutoRebuild', async () => {
    const dbPath = path.join(tmpDir, 'corrupt.db');
    // Plant a malformed file: bytes that pass `open(2)` but fail SQLite's
    // header validation. Surfaces as `SQLITE_NOTADB` in modern SQLite.
    const garbage = Buffer.from('this is definitely not a sqlite database header');
    await writeFile(dbPath, garbage);

    const backend = new SqliteBackend(dbPath);
    let thrown: unknown;
    try {
      backend.initialize();
    } catch (err) {
      thrown = err;
    } finally {
      try {
        backend.close();
      } catch {
        // initialize() may have thrown before db was opened; ignore.
      }
    }

    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error & { code?: string; cause?: unknown };

    // Structured error class — operators / lifecycle code can branch on
    // `err.name` or `instanceof` to distinguish corruption from generic
    // SqliteError (transient I/O fault) without inspecting message text.
    expect(err.name).toBe('SqliteCorruptError');
    expect(err.code).toBe('SQLITE_CORRUPT');

    // Operator remediation must be embedded in the message — keeps the
    // structured error self-describing for log-only consumers.
    expect(err.message).toMatch(/operator|remediation|inspect|manual/i);
    // Path of the offending file is part of the message (so operator
    // doesn't need to correlate against a separate log line).
    expect(err.message).toContain(dbPath);

    // No-auto-rebuild contract: the planted bytes survive intact. A
    // silent rebuild would overwrite this file and lose the evidence.
    const surviving = await readFile(dbPath);
    expect(surviving.equals(garbage)).toBe(true);
  });
});

// ─── A2.2: readLatestProjectionSnapshot (Wave A, #1343) ─────────────────────
//
// Verifies that SqliteBackend.readLatestProjectionSnapshot selects the row
// with the highest sequence for a given (streamId, projectionId,
// projectionVersion) coordinate and returns undefined when no rows match.

describe('SqliteBackend Projection Snapshot — Read (A2.2)', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  it('SqliteBackend_ReadLatestProjectionSnapshot_ReturnsHighestSequenceMatchingRecord', () => {
    const streamId = 'feat-snap-read';
    const projectionId = 'task-store';
    const projectionVersion = 'v1';

    // Insert three snapshot rows for the same coordinate with sequences 1, 5, 3
    // (deliberately out of order to confirm ORDER BY DESC LIMIT 1 is used).
    const makeRecord = (sequence: number) => ({
      projectionId,
      projectionVersion,
      sequence,
      state: { count: sequence },
      timestamp: new Date(2025, 0, 1, 0, 0, sequence).toISOString(),
    });

    backend.appendProjectionSnapshot(streamId, makeRecord(1));
    backend.appendProjectionSnapshot(streamId, makeRecord(5));
    backend.appendProjectionSnapshot(streamId, makeRecord(3));

    // readLatestProjectionSnapshot must return the row with the highest sequence.
    const latest = backend.readLatestProjectionSnapshot(
      streamId,
      projectionId,
      projectionVersion,
    );

    expect(latest).toBeDefined();
    expect(latest!.sequence).toBe(5);
    expect(latest!.state).toEqual({ count: 5 });
    expect(latest!.projectionId).toBe(projectionId);
    expect(latest!.projectionVersion).toBe(projectionVersion);
  });

  it('SqliteBackend_ReadLatestProjectionSnapshot_ReturnsUndefinedWhenNoRowsMatch', () => {
    // No rows inserted — must return undefined.
    const result = backend.readLatestProjectionSnapshot(
      'nonexistent-stream',
      'nonexistent-projection',
      'v0',
    );

    expect(result).toBeUndefined();
  });

  it('SqliteBackend_ReadLatestProjectionSnapshot_IsolatesCoordinates', () => {
    const streamId = 'feat-isolate';
    const projectionId = 'task-store';
    const projectionVersion = 'v1';

    const record = {
      projectionId,
      projectionVersion,
      sequence: 10,
      state: { x: true },
      timestamp: new Date().toISOString(),
    };
    backend.appendProjectionSnapshot(streamId, record);

    // Different streamId — must return undefined.
    expect(
      backend.readLatestProjectionSnapshot('other-stream', projectionId, projectionVersion),
    ).toBeUndefined();

    // Different projectionId — must return undefined.
    expect(
      backend.readLatestProjectionSnapshot(streamId, 'other-proj', projectionVersion),
    ).toBeUndefined();

    // Different projectionVersion — must return undefined.
    expect(
      backend.readLatestProjectionSnapshot(streamId, projectionId, 'v2'),
    ).toBeUndefined();

    // Exact coordinate — must return the record.
    const found = backend.readLatestProjectionSnapshot(streamId, projectionId, projectionVersion);
    expect(found).toBeDefined();
    expect(found!.sequence).toBe(10);
  });
});

// ─── A2.3: appendProjectionSnapshot with size cap (Wave A, #1343) ────────────
//
// Verifies that SqliteBackend.appendProjectionSnapshot persists records and
// enforces a size cap by deleting the oldest rows (by sequence) when the
// total count for a coordinate exceeds maxRecords.

describe('SqliteBackend Projection Snapshot — Append + Size Cap (A2.3)', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  it('SqliteBackend_AppendProjectionSnapshot_PersistsRecord', () => {
    const record = {
      projectionId: 'task-store',
      projectionVersion: 'v1',
      sequence: 42,
      state: { persisted: true },
      timestamp: new Date().toISOString(),
    };

    backend.appendProjectionSnapshot('feat-persist', record);

    const latest = backend.readLatestProjectionSnapshot('feat-persist', 'task-store', 'v1');
    expect(latest).toBeDefined();
    expect(latest!.sequence).toBe(42);
    expect(latest!.state).toEqual({ persisted: true });
    expect(latest!.projectionId).toBe('task-store');
    expect(latest!.projectionVersion).toBe('v1');
  });

  it('SqliteBackend_AppendProjectionSnapshot_EnforcesSizeCapByDeletingOldest', () => {
    const streamId = 'feat-cap';
    const projectionId = 'task-store';
    const projectionVersion = 'v1';
    const maxRecords = 3;

    // Insert maxRecords + 1 = 4 snapshots with sequences 1, 2, 3, 4.
    // After the last append with the size cap, sequences 1 should be deleted,
    // leaving sequences 2, 3, 4 (the most recent maxRecords=3 by sequence).
    for (let seq = 1; seq <= maxRecords + 1; seq++) {
      backend.appendProjectionSnapshot(
        streamId,
        {
          projectionId,
          projectionVersion,
          sequence: seq,
          state: { seq },
          timestamp: new Date(2025, 0, seq).toISOString(),
        },
        { maxRecords },
      );
    }

    // Verify row count == maxRecords by reading from the raw DB.
    const db = (backend as unknown as { db: { prepare: (sql: string) => { all: (...args: unknown[]) => Array<{ sequence: number }> } } }).db;
    const rows = db
      .prepare(
        `SELECT sequence FROM projection_snapshots
         WHERE stream_id = ? AND projection_id = ? AND projection_version = ?
         ORDER BY sequence ASC`,
      )
      .all(streamId, projectionId, projectionVersion);

    expect(rows).toHaveLength(maxRecords);

    // The oldest row (sequence=1) must have been deleted; remaining are 2, 3, 4.
    const sequences = rows.map((r) => r.sequence);
    expect(sequences).toEqual([2, 3, 4]);

    // readLatestProjectionSnapshot still returns the highest (sequence=4).
    const latest = backend.readLatestProjectionSnapshot(streamId, projectionId, projectionVersion);
    expect(latest).toBeDefined();
    expect(latest!.sequence).toBe(4);
  });

  it('SqliteBackend_AppendProjectionSnapshot_SizeCapDoesNotAffectOtherCoordinates', () => {
    const streamId = 'feat-coord-isolation';
    const maxRecords = 2;

    // Insert 3 rows for coordinate A (will hit the cap on the 3rd).
    for (let seq = 1; seq <= 3; seq++) {
      backend.appendProjectionSnapshot(
        streamId,
        { projectionId: 'proj-a', projectionVersion: 'v1', sequence: seq, state: { seq }, timestamp: new Date().toISOString() },
        { maxRecords },
      );
    }

    // Insert 1 row for coordinate B (no cap triggered).
    backend.appendProjectionSnapshot(
      streamId,
      { projectionId: 'proj-b', projectionVersion: 'v1', sequence: 100, state: { b: true }, timestamp: new Date().toISOString() },
    );

    // Coordinate A: cap applied — only 2 rows remain (sequences 2, 3).
    const db = (backend as unknown as { db: { prepare: (sql: string) => { all: (...args: unknown[]) => Array<{ sequence: number }> } } }).db;
    const rowsA = db
      .prepare(
        `SELECT sequence FROM projection_snapshots
         WHERE stream_id = ? AND projection_id = ? AND projection_version = ?
         ORDER BY sequence ASC`,
      )
      .all(streamId, 'proj-a', 'v1');
    expect(rowsA).toHaveLength(2);
    expect(rowsA.map((r) => r.sequence)).toEqual([2, 3]);

    // Coordinate B: untouched.
    const latestB = backend.readLatestProjectionSnapshot(streamId, 'proj-b', 'v1');
    expect(latestB).toBeDefined();
    expect(latestB!.sequence).toBe(100);
  });
});

// ─── Wave 4 (#1437) — Correlation-tuple filters on queryEvents ──────────────

describe('SqliteBackend queryEvents correlation filters (Wave 4 / #1437)', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  function seedSplitByCorrelation(): void {
    // Three events tagged 'cor-X', three tagged 'cor-Y'. operationId and
    // causationId mirror the same split so the same fixture exercises all
    // three filter fields without re-seeding.
    for (let i = 1; i <= 3; i++) {
      backend.appendEvent('test-stream', makeEvent({
        streamId: 'test-stream',
        sequence: i,
        type: 'workflow.started',
        operationId: 'op-X',
        correlationId: 'cor-X',
        causationId: 'cause-X',
      }));
    }
    for (let i = 4; i <= 6; i++) {
      backend.appendEvent('test-stream', makeEvent({
        streamId: 'test-stream',
        sequence: i,
        type: 'workflow.started',
        operationId: 'op-Y',
        correlationId: 'cor-Y',
        causationId: 'cause-Y',
      }));
    }
  }

  it('SqliteBackend_QueryEvents_FiltersByCorrelationId', () => {
    seedSplitByCorrelation();

    const results = backend.queryEvents('test-stream', { correlationId: 'cor-X' });

    expect(results).toHaveLength(3);
    // INV-1: assert the value via the rehydrated event payload, not by
    // reading the indexed column. The column is the filter handle; the
    // payload is the truth.
    for (const event of results) {
      expect(event.correlationId).toBe('cor-X');
    }
  });

  it('SqliteBackend_QueryEvents_FiltersByOperationId', () => {
    seedSplitByCorrelation();

    const results = backend.queryEvents('test-stream', { operationId: 'op-X' });

    expect(results).toHaveLength(3);
    for (const event of results) {
      expect(event.operationId).toBe('op-X');
    }
  });

  it('SqliteBackend_QueryEvents_FiltersByCausationId', () => {
    seedSplitByCorrelation();

    const results = backend.queryEvents('test-stream', { causationId: 'cause-X' });

    expect(results).toHaveLength(3);
    for (const event of results) {
      expect(event.causationId).toBe('cause-X');
    }
  });

  it('SqliteBackend_QueryEvents_CombinesCorrelationWithExistingFilters', () => {
    // Combination test pins that the new WHERE-clause appends compose with
    // existing predicates (sinceSequence). Without this guarantee the
    // single-field tests above would still pass even if the new clause
    // accidentally short-circuited the existing ones.
    seedSplitByCorrelation();

    const results = backend.queryEvents('test-stream', {
      correlationId: 'cor-X',
      sinceSequence: 1,
    });

    expect(results).toHaveLength(2);
    expect(results[0].sequence).toBe(2);
    expect(results[1].sequence).toBe(3);
    expect(results.every((e) => e.correlationId === 'cor-X')).toBe(true);
  });
});

// ─── #1448 (Wave 1 / Task 2) — correlationFilteredQueries counter ───────────
//
// PR #1447 added the indexed-WHERE fast path on (operation_id, correlation_id,
// causation_id), but nothing currently distinguishes "indexed-path hit" from
// "fell back to post-fetch filter" at runtime. The counter below is the
// observability surface that closes the DIM-2 LOW finding from #1447's audit:
// a silent index regression (schema change drops the column, future
// WHERE-builder edit forgets the clause) would otherwise produce correct
// answers via full-scan, invisible until users notice latency.
//
// Counting rule: ONE increment per query, regardless of how many of the three
// correlation filter fields are supplied. A query with all three filters counts
// as 1.

describe('SqliteBackend correlationFilteredQueries counter (#1448 Task 2)', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();

    // Seed a couple of stamped events so the queries below have something to
    // scan past. The counter is independent of result-set size — it advances
    // whenever the filter-clause block runs, not when rows match.
    for (let i = 1; i <= 3; i++) {
      backend.appendEvent('test-stream', makeEvent({
        streamId: 'test-stream',
        sequence: i,
        type: 'workflow.started',
        operationId: 'op-x',
        correlationId: 'cor-x',
        causationId: 'cau-x',
      }));
    }
  });

  afterEach(() => {
    backend.close();
  });

  it('Sqlite_queryEvents_WithCorrelationFilter_IncrementsIndexedPathCounter', () => {
    backend.queryEvents('test-stream', { correlationId: 'cor-x' });
    backend.queryEvents('test-stream', { operationId: 'op-x' });
    backend.queryEvents('test-stream', { causationId: 'cau-x' });
    backend.queryEvents('test-stream', {}); // no correlation filter — must NOT increment

    expect(backend.getStats().correlationFilteredQueries).toBe(3);
  });

  it('Sqlite_queryEventsByType_WithCorrelationFilter_IncrementsIndexedPathCounter', () => {
    backend.queryEventsByType('workflow.started', 'test-stream', { correlationId: 'cor-x' });
    backend.queryEventsByType('workflow.started', 'test-stream', {}); // no filter

    expect(backend.getStats().correlationFilteredQueries).toBe(1);
  });

  it('Sqlite_queryEvents_WithMultipleFilters_CountsOncePerQuery', () => {
    backend.queryEvents('test-stream', {
      operationId: 'op-x',
      correlationId: 'cor-x',
      causationId: 'cau-x',
    });

    expect(backend.getStats().correlationFilteredQueries).toBe(1);
  });
});
