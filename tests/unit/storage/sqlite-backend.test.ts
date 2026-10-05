import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fc } from '@fast-check/vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import type { WorkflowState } from '../../../src/workflow/types.js';
import type { EventSender } from '../../../src/storage/backend.js';
import { SqliteBackend, SqliteImmediateUnsupportedError } from '../../../src/storage/sqlite-backend.js';
import { VersionConflictError } from '../../../src/storage/memory-backend.js';
import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

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

    /**
     * `atomicDecideOnce` stores the result as JSON and returns that form to the
     * first caller and to a retry. JSON has no negative zero, so the expected
     * value is the round-tripped form, not the raw closure value.
     */
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
            expect(retry).toEqual(JSON.parse(JSON.stringify(canonicalResult)));
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
    const backend = new SqliteBackend(':memory:', { synchronous: 'full' });
    expect(() => backend.initialize()).not.toThrow();
    backend.close();
  });

  /**
   * `initialize()` asserts that the driver has `transaction(fn).immediate()`, so
   * a successful init proves it. The test also checks the method directly.
   */
  it('Initialize_DriverExposesImmediate_AssertionPasses', () => {
    const backend = new SqliteBackend(':memory:');
    backend.initialize();
    const db = (backend as unknown as { db: { transaction: (fn: () => void) => unknown } }).db;
    const txn = db.transaction(() => {}) as { immediate?: unknown };
    expect(typeof txn.immediate).toBe('function');
    backend.close();
  });

  /**
   * A driver whose `transaction(fn)` wrapper has no `.immediate` must cause the
   * typed error, not a fallback to a deferred BEGIN. The test puts such a
   * wrapper on the private `db` handle and calls the assertion directly.
   */
  it('Initialize_DriverLacksImmediate_ThrowsTyped', () => {
    const backend = new SqliteBackend(':memory:');
    (backend as unknown as { db: { transaction: (fn: () => void) => unknown } }).db = {
      transaction: (_fn: () => void) => ({
      }),
    };
    expect(() =>
      (backend as unknown as { assertImmediateSupported: () => void }).assertImmediateSupported(),
    ).toThrowError(SqliteImmediateUnsupportedError);
  });
});

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

  /**
   * A `:memory:` database cannot use WAL and reports `memory` as its journal
   * mode. A database file reports `wal`.
   */
  it('SqliteBackend_initialize_WALModeEnabled', () => {
    const db = (backend as unknown as { db: { pragma: (sql: string) => Array<{ journal_mode: string }> } }).db;
    const result = db.pragma('journal_mode');
    expect(result[0].journal_mode).toBe('memory');
  });

  /** One `:memory:` connection appends and reads in sequence. No two operations overlap. */
  it('SqliteBackend_concurrentReadWrite_WALMode_NoBlocking', () => {
    const event1 = makeEvent({ streamId: 'stream-a', sequence: 1 });
    backend.appendEvent('stream-a', event1);

    const events = backend.queryEvents('stream-a');
    expect(events).toHaveLength(1);

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

  /** The first `setState` leaves version 1, so an expected version of 0 is stale. */
  it('SqliteBackend_setState_CASConflict_ThrowsVersionConflictError', () => {
    const state = makeState({ featureId: 'my-feature' });
    backend.setState('my-feature', state);

    const updatedState = makeState({ featureId: 'my-feature', phase: 'plan' });
    expect(() => backend.setState('my-feature', updatedState, 0)).toThrow(VersionConflictError);
  });

  /** The version is 1 after the first `setState` and 2 after the second. */
  it('SqliteBackend_setState_AutoIncrementsVersion', () => {
    const state1 = makeState({ featureId: 'my-feature' });
    backend.setState('my-feature', state1);

    const state2 = makeState({ featureId: 'my-feature', phase: 'plan' });
    backend.setState('my-feature', state2, 1);

    const state3 = makeState({ featureId: 'my-feature', phase: 'delegate' });
    expect(() => backend.setState('my-feature', state3, 1)).toThrow(VersionConflictError);

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

/**
 * `nowMs` is a mutable clock. A retry test moves it past the `nextRetryAt` of
 * the exponential backoff without a sleep. `beforeEach` resets it to the wall
 * clock.
 */
describe('SqliteBackend Outbox Operations', () => {
  let backend: SqliteBackend;
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

    const result2 = await backend.drainOutbox('test-stream', mockSender);
    expect(result2.sent).toBe(0);
    expect(result2.failed).toBe(0);
  });

  /**
   * After the first failure the row stays pending, but its backoff is 2 seconds.
   * The test moves the clock 5 seconds, so the second drain finds the row due.
   */
  it('SqliteBackend_drainOutbox_FailedEntry_SetsRetryAndIncrementsAttempts', async () => {
    const event = makeEvent({ streamId: 'test-stream', sequence: 1 });
    backend.addOutboxEntry('test-stream', event);

    const failingSender: EventSender = {
      appendEvents: async (_streamId, _events) => {
        throw new Error('Network error');
      },
    };

    const result = await backend.drainOutbox('test-stream', failingSender);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);

    nowMs += 5_000;
    const successSender: EventSender = {
      appendEvents: async (_streamId, events) => {
        return { accepted: events.length, streamVersion: 1 };
      },
    };

    const result2 = await backend.drainOutbox('test-stream', successSender);
    expect(result2.sent).toBe(1);
  });

  /**
   * `selectPendingOutbox` must skip a pending row whose `nextRetryAt` is in the
   * future. A filter on `status` alone retries the row at once and defeats the
   * backoff. After the clock passes `nextRetryAt`, the drain sends the row.
   */
  it('SqliteBackend_drainOutbox_NextRetryAtFuture_ExcludesEntryFromBatch', async () => {
    const event = makeEvent({ streamId: 'test-stream', sequence: 1 });
    backend.addOutboxEntry('test-stream', event);

    const failingSender: EventSender = {
      appendEvents: async () => { throw new Error('temporary failure'); },
    };

    const r1 = await backend.drainOutbox('test-stream', failingSender);
    expect(r1.failed).toBe(1);
    expect(r1.sent).toBe(0);

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

    nowMs += 10_000;
    const r3 = await backend.drainOutbox('test-stream', recordingSender);
    expect(r3.sent).toBe(1);
    expect(recordedCalls).toBe(1);
  });

  /**
   * The row becomes a dead letter at the fifth failed attempt. Each failure
   * doubles the backoff, so the clock moves 60 seconds between drains, which is
   * longer than each backoff. Without that, the row stays in backoff and
   * `attempts` stays at 1.
   */
  it('SqliteBackend_drainOutbox_MaxRetries_MarksDeadLetter', async () => {
    const event = makeEvent({ streamId: 'test-stream', sequence: 1 });
    backend.addOutboxEntry('test-stream', event);

    const failingSender: EventSender = {
      appendEvents: async (_streamId, _events) => {
        throw new Error('Permanent failure');
      },
    };

    for (let i = 0; i < 6; i++) {
      await backend.drainOutbox('test-stream', failingSender);
      nowMs += 60_000;
    }

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
    const event = makeEvent({ streamId: 'test-stream', sequence: 1 });
    backend.appendEvent('test-stream', event);
    backend.addOutboxEntry('test-stream', event);

    const events = backend.queryEvents('test-stream');
    expect(events).toHaveLength(1);

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

describe('SqliteBackend.atomicAppend empty-events guard (T70)', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  /**
   * `atomicAppend` needs at least one event (`n >= 1`). A call with `n: 0` must
   * reject with a clear validation error, not with a `TypeError` from an
   * undefined property.
   */
  it('throws a structured validation error (not TypeError) when n is zero', async () => {
    await expect(
      backend.atomicAppend({
        streamId: 'test-stream',
        idempotencyKey: null,
        n: 0,
        finalize: () => ({ events: [] }),
      }),
    ).rejects.toThrowError('atomicAppend requires n >= 1');

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

describe('SqliteBackend rowToEvent Round-Trip', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  /**
   * `rowToEvent` reads the payload JSON, so the fields without a column of their
   * own survive the round trip.
   */
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

    expect(retrieved.streamId).toBe('test-stream');
    expect(retrieved.sequence).toBe(1);
    expect(retrieved.type).toBe('workflow.started');
    expect(retrieved.timestamp).toBe('2026-02-21T00:00:00.000Z');
    expect(retrieved.data).toEqual({ key: 'value', nested: { a: 1 } });

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
    backend.appendEvent('test-stream', makeEvent({ sequence: 1 }));
    backend.appendEvent('test-stream', makeEvent({ sequence: 2 }));

    const db = (backend as unknown as { db: { prepare: (sql: string) => unknown } }).db;
    const originalPrepare = db.prepare.bind(db);
    const prepareSpy = vi.fn(originalPrepare);
    db.prepare = prepareSpy;

    const filters = { type: 'workflow.started' as const };
    backend.queryEvents('test-stream', filters);
    backend.queryEvents('test-stream', filters);

    expect(prepareSpy).toHaveBeenCalledTimes(1);
  });

  it('queryEvents_DifferentFilters_CreatesSeparateStatements', () => {
    backend.appendEvent('test-stream', makeEvent({ sequence: 1 }));

    const db = (backend as unknown as { db: { prepare: (sql: string) => unknown } }).db;
    const originalPrepare = db.prepare.bind(db);
    const prepareSpy = vi.fn(originalPrepare);
    db.prepare = prepareSpy;

    backend.queryEvents('test-stream', { type: 'workflow.started' });
    backend.queryEvents('test-stream', { sinceSequence: 0 });

    expect(prepareSpy).toHaveBeenCalledTimes(2);
  });
});

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

  /**
   * The two calls run in sequence with expected version 1. The first must
   * succeed and the second must throw.
   */
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
          }

          try {
            propBackend.setState(featureId, update2, 1);
            success2 = true;
          } catch {
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

          const result1 = await propBackend.drainOutbox(streamId, successSender);
          expect(result1.sent).toBe(count);

          const result2 = await propBackend.drainOutbox(streamId, successSender);
          expect(result2.sent).toBe(0);
          expect(result2.failed).toBe(0);

          propBackend.close();
        },
      ),
    );
  });
});

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
    for (let i = 1; i <= 5; i++) {
      backend.appendEvent('stream-to-delete', makeEvent({ streamId: 'stream-to-delete', sequence: i }));
    }
    backend.appendEvent('other-stream', makeEvent({ streamId: 'other-stream', sequence: 1 }));

    expect(backend.queryEvents('stream-to-delete')).toHaveLength(5);

    backend.deleteStream('stream-to-delete');

    expect(backend.queryEvents('stream-to-delete')).toHaveLength(0);
    expect(backend.getSequence('stream-to-delete')).toBe(0);
    expect(backend.listStreams()).not.toContain('stream-to-delete');
    expect(backend.queryEvents('other-stream')).toHaveLength(1);
  });

  it('SqliteBackend_deleteState_RemovesStateForFeature', () => {
    const state1 = makeState({ featureId: 'feature-to-delete' });
    const state2 = makeState({ featureId: 'other-feature' });
    backend.setState('feature-to-delete', state1);
    backend.setState('other-feature', state2);

    expect(backend.getState('feature-to-delete')).not.toBeNull();

    backend.deleteState('feature-to-delete');

    expect(backend.getState('feature-to-delete')).toBeNull();
    expect(backend.getState('other-feature')).not.toBeNull();
  });

  it('SqliteBackend_pruneEvents_RemovesEventsBeforeTimestamp', () => {
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

    const pruned = backend.pruneEvents('telemetry', '2025-01-01T00:00:00.000Z');

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

/**
 * `initialize()` must throw on a corrupt file or a file that is not a
 * database, and must not rebuild it. A silent rebuild destroys the bytes that
 * an operator needs to find the cause, and can hide a data loss.
 * `initializeBackend` relies on this throw and does not probe for corruption
 * itself.
 */
describe('SqliteBackend Startup Corruption (T10)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'sqlite-backend-corrupt-t10-'));
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  /**
   * The planted bytes open as a file but fail the SQLite header check
   * (`SQLITE_NOTADB`). The error must have a typed name and code, so a caller
   * does not parse the message. The message must name the file and tell the
   * operator what to do. The planted bytes must stay unchanged.
   */
  it('SqliteBackend_StartupCorruptDb_StructuredErrorNoAutoRebuild', async () => {
    const dbPath = path.join(tmpDir, 'corrupt.db');
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
      }
    }

    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error & { code?: string; cause?: unknown };

    expect(err.name).toBe('SqliteCorruptError');
    expect(err.code).toBe('SQLITE_CORRUPT');

    expect(err.message).toMatch(/operator|remediation|inspect|manual/i);
    expect(err.message).toContain(dbPath);

    const surviving = await readFile(dbPath);
    expect(surviving.equals(garbage)).toBe(true);
  });
});

/**
 * `readLatestProjectionSnapshot` returns the row with the highest sequence for
 * one `(streamId, projectionId, projectionVersion)` coordinate, or `undefined`
 * when no row matches.
 */
describe('SqliteBackend Projection Snapshot — Read (A2.2)', () => {
  let backend: SqliteBackend;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
  });

  /**
   * The appends use sequences 1, 5 and 3, out of order, so insertion order
   * cannot give the right row.
   */
  it('SqliteBackend_ReadLatestProjectionSnapshot_ReturnsHighestSequenceMatchingRecord', () => {
    const streamId = 'feat-snap-read';
    const projectionId = 'task-store';
    const projectionVersion = 'v1';

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

    expect(
      backend.readLatestProjectionSnapshot('other-stream', projectionId, projectionVersion),
    ).toBeUndefined();

    expect(
      backend.readLatestProjectionSnapshot(streamId, 'other-proj', projectionVersion),
    ).toBeUndefined();

    expect(
      backend.readLatestProjectionSnapshot(streamId, projectionId, 'v2'),
    ).toBeUndefined();

    const found = backend.readLatestProjectionSnapshot(streamId, projectionId, projectionVersion);
    expect(found).toBeDefined();
    expect(found!.sequence).toBe(10);
  });
});

/**
 * `appendProjectionSnapshot` stores a record. When a coordinate holds more
 * than `maxRecords` rows, it deletes the rows with the lowest sequences.
 */
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

    const db = (backend as unknown as { db: { prepare: (sql: string) => { all: (...args: unknown[]) => Array<{ sequence: number }> } } }).db;
    const rows = db
      .prepare(
        `SELECT sequence FROM projection_snapshots
         WHERE stream_id = ? AND projection_id = ? AND projection_version = ?
         ORDER BY sequence ASC`,
      )
      .all(streamId, projectionId, projectionVersion);

    expect(rows).toHaveLength(maxRecords);

    const sequences = rows.map((r) => r.sequence);
    expect(sequences).toEqual([2, 3, 4]);

    const latest = backend.readLatestProjectionSnapshot(streamId, projectionId, projectionVersion);
    expect(latest).toBeDefined();
    expect(latest!.sequence).toBe(4);
  });

  it('SqliteBackend_AppendProjectionSnapshot_SizeCapDoesNotAffectOtherCoordinates', () => {
    const streamId = 'feat-coord-isolation';
    const maxRecords = 2;

    for (let seq = 1; seq <= 3; seq++) {
      backend.appendProjectionSnapshot(
        streamId,
        { projectionId: 'proj-a', projectionVersion: 'v1', sequence: seq, state: { seq }, timestamp: new Date().toISOString() },
        { maxRecords },
      );
    }

    backend.appendProjectionSnapshot(
      streamId,
      { projectionId: 'proj-b', projectionVersion: 'v1', sequence: 100, state: { b: true }, timestamp: new Date().toISOString() },
    );

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

    const latestB = backend.readLatestProjectionSnapshot(streamId, 'proj-b', 'v1');
    expect(latestB).toBeDefined();
    expect(latestB!.sequence).toBe(100);
  });
});

/**
 * `seedSplitByCorrelation` appends three events with the `X` ids and three
 * with the `Y` ids. `operationId`, `correlationId` and `causationId` split the
 * same way, so one fixture serves the three filters.
 */
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

  /**
   * The assertions read the value from the rehydrated event, not from the
   * indexed column. The column is the filter handle, and the payload is the
   * source of truth.
   */
  it('SqliteBackend_QueryEvents_FiltersByCorrelationId', () => {
    seedSplitByCorrelation();

    const results = backend.queryEvents('test-stream', { correlationId: 'cor-X' });

    expect(results).toHaveLength(3);
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

  /**
   * A correlation filter must combine with an existing predicate, here
   * `sinceSequence`. The single-field tests still pass if the correlation
   * clause cancels the other predicates.
   */
  it('SqliteBackend_QueryEvents_CombinesCorrelationWithExistingFilters', () => {
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

/**
 * `correlationFilteredQueries` counts the queries that filter on
 * `operationId`, `correlationId` or `causationId`. It makes the use of the
 * indexed WHERE path visible. A lost index still gives correct rows through a
 * full scan, and shows only as latency. Each query counts once, with one
 * filter or with all three.
 */
describe('SqliteBackend correlationFilteredQueries counter (#1448 Task 2)', () => {
  let backend: SqliteBackend;

  /**
   * Seeds three stamped events. The counter does not depend on the result size:
   * it advances when the filter block runs.
   */
  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();

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

  /** The fourth query has no correlation filter and must not count. */
  it('Sqlite_queryEvents_WithCorrelationFilter_IncrementsIndexedPathCounter', () => {
    backend.queryEvents('test-stream', { correlationId: 'cor-x' });
    backend.queryEvents('test-stream', { operationId: 'op-x' });
    backend.queryEvents('test-stream', { causationId: 'cau-x' });
    backend.queryEvents('test-stream', {});

    expect(backend.getStats().correlationFilteredQueries).toBe(3);
  });

  /** The second query has no filter and must not count. */
  it('Sqlite_queryEventsByType_WithCorrelationFilter_IncrementsIndexedPathCounter', () => {
    backend.queryEventsByType('workflow.started', 'test-stream', { correlationId: 'cor-x' });
    backend.queryEventsByType('workflow.started', 'test-stream', {});

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

/**
 * A stale startup repair must not lower the gate, the `sequences` row of a
 * stream. If the SELECT and the upserts of a repair run apart, a sibling
 * process can repair and append between them. A blind overwrite then sets the
 * advanced gate back to the stale tail. The next append reuses a stored
 * sequence and violates the primary key. The repair has two guards: one
 * `BEGIN IMMEDIATE` transaction for both steps, and a monotonic upsert
 * (`MAX(sequence, excluded.sequence)`). This test pins the monotonic upsert.
 */
describe('SqliteBackend EFF-001 repair TOCTOU (gate-lowering)', () => {
  /**
   * The seed has events 1 to 5 and a gate forced back to 3. `staleTail` stands
   * for the value 5 that the repair of a first process computes. Then backend B
   * starts, repairs the gate to 5, and appends to 8. The test applies the stale
   * value through `upsertSequenceMonotonic`, and the gate must stay at 8. A
   * gate of 5 gives out sequence 6 again.
   */
  it('Sqlite_StaleRepairAfterConcurrentAdvance_NeverLowersTheGate', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'repair-toctou-'));
    const dbPath = path.join(stateDir, 'repair-toctou.db');
    const streamId = 'repair-toctou-stream';

    const seeder = new SqliteBackend(dbPath);
    seeder.initialize();
    for (let seq = 1; seq <= 5; seq++) {
      seeder.appendEvent(streamId, makeEvent({ streamId, sequence: seq }));
    }
    const seederDb = (
      seeder as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };
      }
    ).db;
    seederDb.prepare('UPDATE sequences SET sequence = ? WHERE streamId = ?').run(3, streamId);
    seeder.close();

    const staleTail = 5;

    const backendB = new SqliteBackend(dbPath);
    backendB.initialize();
    expect(
      backendB.readSequenceHighWaterMark(streamId),
      'startup repair must raise the diverged gate to the durable tail',
    ).toBe(5);
    for (let seq = 6; seq <= 8; seq++) {
      backendB.appendEvent(streamId, makeEvent({ streamId, sequence: seq }));
    }
    expect(backendB.readSequenceHighWaterMark(streamId)).toBe(8);

    const stmts = (
      backendB as unknown as {
        stmts: { upsertSequenceMonotonic: { run: (...args: unknown[]) => unknown } };
      }
    ).stmts;
    stmts.upsertSequenceMonotonic.run(streamId, staleTail);

    expect(
      backendB.readSequenceHighWaterMark(streamId),
      'a stale repair must never lower the gate below the durable tail',
    ).toBe(8);

    backendB.close();
    await rmrfAsync(stateDir);
  });
});
