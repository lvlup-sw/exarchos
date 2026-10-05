import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import type { WorkflowState } from '../../../src/workflow/types.js';
import type { SnapshotRecord } from '../../../src/projections/snapshot-schema.js';
import type { StorageBackend, EventSender } from '../../../src/storage/backend.js';
import { InMemoryBackend, VersionConflictError } from '../../../src/storage/memory-backend.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

function makeEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    streamId: 'test-stream',
    sequence: 1,
    timestamp: '2025-01-15T10:00:00.000Z',
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

function makeSender(result: { accepted: number; streamVersion: number } = { accepted: 1, streamVersion: 1 }): EventSender {
  return {
    appendEvents: () => Promise.resolve(result),
  };
}

function makeFailingSender(): EventSender {
  return {
    appendEvents: () => { throw new Error('Send failed'); },
  };
}

interface BackendFactoryResult {
  backend: StorageBackend;
  cleanup: () => void;
  /**
   * Moves the injected clock of SqliteBackend forward by `ms`, so a row past its
   * `nextRetryAt` is due again. It does nothing for InMemoryBackend, which has no backoff.
   */
  advanceClock: (ms: number) => void;
}

describe.each([
  ['InMemoryBackend', (): BackendFactoryResult => {
    const backend = new InMemoryBackend();
    backend.initialize();
    return {
      backend,
      cleanup: () => { backend.close(); },
      advanceClock: () => {},
    };
  }],
  ['SqliteBackend', (): BackendFactoryResult => {
    const dir = mkdtempSync(join(tmpdir(), 'contract-'));
    let nowMs = Date.now();
    const backend = new SqliteBackend(join(dir, 'test.db'), { clock: () => new Date(nowMs) });
    backend.initialize();
    return {
      backend,
      cleanup: () => { backend.close(); rmrf(dir); },
      advanceClock: (ms: number) => { nowMs += ms; },
    };
  }],
])('%s contract', (_name, factory) => {
  let backend: StorageBackend;
  let cleanup: () => void;
  let advanceClock: (ms: number) => void;

  afterEach(() => {
    cleanup();
  });

  function setup(): StorageBackend {
    const result = factory();
    backend = result.backend;
    cleanup = result.cleanup;
    advanceClock = result.advanceClock;
    return backend;
  }

  it('appendEvent_SingleEvent_IncreasesSequence', () => {
    const b = setup();
    const event = makeEvent({ sequence: 1 });

    b.appendEvent('stream-a', event);

    expect(b.getSequence('stream-a')).toBe(1);
  });

  it('appendEvent_MultipleStreams_IsolatesSequences', () => {
    const b = setup();

    b.appendEvent('stream-a', makeEvent({ sequence: 1, streamId: 'stream-a' }));
    b.appendEvent('stream-a', makeEvent({ sequence: 2, streamId: 'stream-a' }));
    b.appendEvent('stream-b', makeEvent({ sequence: 1, streamId: 'stream-b' }));

    expect(b.getSequence('stream-a')).toBe(2);
    expect(b.getSequence('stream-b')).toBe(1);
  });

  it('queryEvents_TypeFilter_ReturnsMatchingOnly', () => {
    const b = setup();

    b.appendEvent('stream-a', makeEvent({ sequence: 1, type: 'workflow.started' }));
    b.appendEvent('stream-a', makeEvent({ sequence: 2, type: 'task.assigned' }));
    b.appendEvent('stream-a', makeEvent({ sequence: 3, type: 'workflow.started' }));

    const results = b.queryEvents('stream-a', { type: 'workflow.started' });

    expect(results).toHaveLength(2);
    expect(results.every(e => e.type === 'workflow.started')).toBe(true);
  });

  it('queryEvents_SinceSequenceFilter_ReturnsSubset', () => {
    const b = setup();

    b.appendEvent('stream-a', makeEvent({ sequence: 1 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 2 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 3 }));

    const results = b.queryEvents('stream-a', { sinceSequence: 1 });

    expect(results).toHaveLength(2);
    expect(results[0].sequence).toBe(2);
    expect(results[1].sequence).toBe(3);
  });

  it('queryEvents_LimitAndOffset_PaginatesCorrectly', () => {
    const b = setup();

    b.appendEvent('stream-a', makeEvent({ sequence: 1 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 2 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 3 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 4 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 5 }));

    const results = b.queryEvents('stream-a', { limit: 2, offset: 1 });

    expect(results).toHaveLength(2);
    expect(results[0].sequence).toBe(2);
    expect(results[1].sequence).toBe(3);
  });

  /**
   * Both backends must return the same events for the same correlation filters.
   * SqliteBackend filters in SQL and InMemoryBackend filters in memory, so this
   * test catches a drift between them in shape, order or content.
   */
  it('BackendContract_QueryEventsCorrelationFilter_IdenticalAcrossBackends', () => {
    const b = setup();

    const seedEvents = [
      { sequence: 1, correlationId: 'cor-X', operationId: 'op-X', causationId: 'cause-X' },
      { sequence: 2, correlationId: 'cor-X', operationId: 'op-X', causationId: 'cause-X' },
      { sequence: 3, correlationId: 'cor-Y', operationId: 'op-Y', causationId: 'cause-Y' },
      { sequence: 4, correlationId: 'cor-X', operationId: 'op-X', causationId: 'cause-X' },
      { sequence: 5, correlationId: 'cor-Y', operationId: 'op-Y', causationId: 'cause-Y' },
      { sequence: 6, correlationId: 'cor-Y', operationId: 'op-Y', causationId: 'cause-Y' },
    ];

    for (const seed of seedEvents) {
      b.appendEvent('stream-a', makeEvent({
        streamId: 'stream-a',
        sequence: seed.sequence,
        type: 'workflow.started',
        correlationId: seed.correlationId,
        operationId: seed.operationId,
        causationId: seed.causationId,
      }));
    }

    const byCorr = b.queryEvents('stream-a', { correlationId: 'cor-X' });
    expect(byCorr.map((e) => e.sequence)).toEqual([1, 2, 4]);
    expect(byCorr.map((e) => e.type)).toEqual([
      'workflow.started',
      'workflow.started',
      'workflow.started',
    ]);
    expect(byCorr.every((e) => e.correlationId === 'cor-X')).toBe(true);

    const byOp = b.queryEvents('stream-a', { operationId: 'op-Y' });
    expect(byOp.map((e) => e.sequence)).toEqual([3, 5, 6]);
    expect(byOp.every((e) => e.operationId === 'op-Y')).toBe(true);

    const byCause = b.queryEvents('stream-a', { causationId: 'cause-X' });
    expect(byCause.map((e) => e.sequence)).toEqual([1, 2, 4]);
    expect(byCause.every((e) => e.causationId === 'cause-X')).toBe(true);

    const byCorrSince = b.queryEvents('stream-a', {
      correlationId: 'cor-X',
      sinceSequence: 1,
    });
    expect(byCorrSince.map((e) => e.sequence)).toEqual([2, 4]);

    const byNone = b.queryEvents('stream-a', { correlationId: 'does-not-exist' });
    expect(byNone).toEqual([]);
  });

  /**
   * `queryEventsByType` must apply the same correlation filters as `queryEvents`,
   * and both backends must implement it. The streams `parent/a` and `parent/b`
   * are descendants of the prefix `parent`, so the query reads both.
   */
  it('BackendContract_QueryEventsByType_HonorsCorrelationFilter', () => {
    const b = setup();

    b.appendEvent('parent/a', makeEvent({
      streamId: 'parent/a',
      sequence: 1,
      type: 'workflow.started',
      correlationId: 'cor-X',
      operationId: 'op-X',
      causationId: 'cause-X',
    }));
    b.appendEvent('parent/b', makeEvent({
      streamId: 'parent/b',
      sequence: 1,
      type: 'workflow.started',
      correlationId: 'cor-Y',
      operationId: 'op-Y',
      causationId: 'cause-Y',
    }));
    b.appendEvent('parent/a', makeEvent({
      streamId: 'parent/a',
      sequence: 2,
      type: 'workflow.started',
      correlationId: 'cor-X',
      operationId: 'op-X',
      causationId: 'cause-X',
    }));

    expect(typeof b.queryEventsByType).toBe('function');
    if (typeof b.queryEventsByType !== 'function') {
      throw new Error('queryEventsByType missing on backend under test');
    }

    const byCorr = b.queryEventsByType('workflow.started', 'parent', { correlationId: 'cor-X' });
    expect(byCorr.map((e) => e.streamId)).toEqual(['parent/a', 'parent/a']);
    expect(byCorr.every((e) => e.correlationId === 'cor-X')).toBe(true);

    const byOp = b.queryEventsByType('workflow.started', 'parent', { operationId: 'op-Y' });
    expect(byOp.map((e) => e.streamId)).toEqual(['parent/b']);
    expect(byOp.every((e) => e.operationId === 'op-Y')).toBe(true);

    const byCause = b.queryEventsByType('workflow.started', 'parent', { causationId: 'cause-Y' });
    expect(byCause).toHaveLength(1);
    expect(byCause[0].causationId).toBe('cause-Y');

    const byNone = b.queryEventsByType('workflow.started', 'parent', { correlationId: 'nope' });
    expect(byNone).toEqual([]);
  });

  it('getSequence_EmptyStream_ReturnsZero', () => {
    const b = setup();

    expect(b.getSequence('nonexistent-stream')).toBe(0);
  });

  it('getSequence_AfterAppends_ReturnsLastSequence', () => {
    const b = setup();

    b.appendEvent('stream-a', makeEvent({ sequence: 1 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 2 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 3 }));

    expect(b.getSequence('stream-a')).toBe(3);
  });

  it('setState_NewState_CreatesEntry', () => {
    const b = setup();
    const state = makeState({ featureId: 'feat-1' });

    b.setState('feat-1', state);

    const retrieved = b.getState('feat-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.featureId).toBe('feat-1');
  });

  /** The first `setState` creates version 1, so an expected version of 1 matches. */
  it('setState_CASMatch_Updates', () => {
    const b = setup();
    const state1 = makeState({ featureId: 'feat-1', phase: 'ideate' });
    const state2 = makeState({ featureId: 'feat-1', phase: 'plan' });

    b.setState('feat-1', state1);
    b.setState('feat-1', state2, 1);

    const retrieved = b.getState('feat-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.phase).toBe('plan');
  });

  it('setState_CASMismatch_ThrowsVersionConflict', () => {
    const b = setup();
    const state1 = makeState({ featureId: 'feat-1' });
    const state2 = makeState({ featureId: 'feat-1', phase: 'plan' });

    b.setState('feat-1', state1);

    expect(() => b.setState('feat-1', state2, 99)).toThrow(VersionConflictError);
  });

  it('getState_NonExistent_ReturnsNull', () => {
    const b = setup();

    expect(b.getState('nonexistent')).toBeNull();
  });

  it('listStates_MultipleStates_ReturnsAll', () => {
    const b = setup();

    b.setState('feat-1', makeState({ featureId: 'feat-1' }));
    b.setState('feat-2', makeState({ featureId: 'feat-2' }));
    b.setState('feat-3', makeState({ featureId: 'feat-3' }));

    const states = b.listStates();

    expect(states).toHaveLength(3);
    const ids = states.map(s => s.featureId).sort();
    expect(ids).toEqual(['feat-1', 'feat-2', 'feat-3']);
  });

  it('addOutboxEntry_ReturnsEntryId', () => {
    const b = setup();
    const event = makeEvent();

    const id = b.addOutboxEntry('stream-a', event);

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('drainOutbox_SuccessfulSend_DrainsBatch', async () => {
    const b = setup();
    const event = makeEvent();
    b.addOutboxEntry('stream-a', event);

    const sender = makeSender();
    const result = await b.drainOutbox('stream-a', sender);

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('drainOutbox_EmptyOutbox_ReturnsZeroCounts', async () => {
    const b = setup();
    const sender = makeSender();

    const result = await b.drainOutbox('stream-a', sender);

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
  });

  /**
   * The send of entry 2 fails, so the drain stops and entry 3 stays queued behind
   * entry 2. SqliteBackend sets a `nextRetryAt` backoff on the failed row, so the
   * test moves the clock forward 60 s before the second drain.
   */
  it('drainOutbox_FailedMidBatch_StopsAndPreservesFifoOrder', async () => {
    const b = setup();
    for (const seq of [1, 2, 3]) {
      b.addOutboxEntry('stream-a', makeEvent({ sequence: seq, streamId: 'stream-a' }));
    }

    let call = 0;
    const failOnSecond: EventSender = {
      appendEvents: async (_streamId, events) => {
        call++;
        if (call === 2) throw new Error('boom');
        return { accepted: events.length, streamVersion: call };
      },
    };

    const result = await b.drainOutbox('stream-a', failOnSecond);

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);

    advanceClock(60_000);

    const accepted: Array<{ sequence: number }> = [];
    const recordingSender: EventSender = {
      appendEvents: async (_streamId, events) => {
        accepted.push(...(events as Array<{ sequence: number }>));
        return { accepted: events.length, streamVersion: 99 };
      },
    };

    const result2 = await b.drainOutbox('stream-a', recordingSender);
    expect(result2.sent).toBeGreaterThanOrEqual(1);
    if (accepted.length > 0) expect(accepted[0]?.sequence).toBe(2);
  });

  it('listStreams_MultipleStreams_ReturnsAllStreamIds', () => {
    const b = setup();

    b.appendEvent('stream-a', makeEvent({ sequence: 1, streamId: 'stream-a' }));
    b.appendEvent('stream-b', makeEvent({ sequence: 1, streamId: 'stream-b' }));
    b.appendEvent('stream-c', makeEvent({ sequence: 1, streamId: 'stream-c' }));

    const streams = b.listStreams();

    expect(streams).toHaveLength(3);
    expect(streams.sort()).toEqual(['stream-a', 'stream-b', 'stream-c']);
  });

  it('deleteStream_ExistingStream_RemovesAllData', () => {
    const b = setup();

    b.appendEvent('stream-a', makeEvent({ sequence: 1 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 2 }));

    b.deleteStream('stream-a');

    const events = b.queryEvents('stream-a');
    expect(events).toHaveLength(0);
  });

  it('deleteState_ExistingState_RemovesEntry', () => {
    const b = setup();

    b.setState('feat-1', makeState({ featureId: 'feat-1' }));
    expect(b.getState('feat-1')).not.toBeNull();

    b.deleteState('feat-1');

    expect(b.getState('feat-1')).toBeNull();
  });

  it('pruneEvents_BeforeTimestamp_DeletesOlderEvents', () => {
    const b = setup();

    b.appendEvent('stream-a', makeEvent({ sequence: 1, timestamp: '2025-01-01T00:00:00.000Z' }));
    b.appendEvent('stream-a', makeEvent({ sequence: 2, timestamp: '2025-01-10T00:00:00.000Z' }));
    b.appendEvent('stream-a', makeEvent({ sequence: 3, timestamp: '2025-01-20T00:00:00.000Z' }));

    const pruned = b.pruneEvents('stream-a', '2025-01-15T00:00:00.000Z');

    expect(pruned).toBe(2);

    const remaining = b.queryEvents('stream-a');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sequence).toBe(3);
  });

  it('setViewCache_NewEntry_StoresCorrectly', () => {
    const b = setup();
    const viewState = { count: 42, items: ['a', 'b'] };

    b.setViewCache('stream-a', 'summary-view', viewState, 10);

    const entry = b.getViewCache('stream-a', 'summary-view');
    expect(entry).not.toBeNull();
    expect(entry!.state).toEqual(viewState);
    expect(entry!.highWaterMark).toBe(10);
  });

  it('getViewCache_NonExistent_ReturnsNull', () => {
    const b = setup();

    const entry = b.getViewCache('stream-a', 'nonexistent-view');

    expect(entry).toBeNull();
  });

  it('getViewCache_AfterSet_ReturnsStoredEntry', () => {
    const b = setup();
    const viewState1 = { version: 1 };
    const viewState2 = { version: 2, extra: 'data' };

    b.setViewCache('stream-a', 'my-view', viewState1, 5);
    b.setViewCache('stream-a', 'my-view', viewState2, 15);

    const entry = b.getViewCache('stream-a', 'my-view');
    expect(entry).not.toBeNull();
    expect(entry!.state).toEqual(viewState2);
    expect(entry!.highWaterMark).toBe(15);
  });
});

describe('SqliteBackend outbox retry behavior', () => {
  let backend: SqliteBackend;
  let dir: string;

  afterEach(() => {
    backend.close();
    rmrf(dir);
  });

  /**
   * SqliteBackend sets an exponential backoff on a failed outbox row: 2 s after
   * the first failure and 4 s after the second. A drain inside the backoff window
   * skips the row. InMemoryBackend has no backoff.
   */
  it('drainOutbox_FailedSend_SqliteBackendRetriesWithBackoff', async () => {
    dir = mkdtempSync(join(tmpdir(), 'contract-sqlite-retry-'));
    let nowMs = Date.now();
    backend = new SqliteBackend(join(dir, 'test.db'), { clock: () => new Date(nowMs) });
    backend.initialize();

    const event = makeEvent();
    backend.addOutboxEntry('stream-a', event);

    const failingSender = makeFailingSender();

    const result1 = await backend.drainOutbox('stream-a', failingSender);
    expect(result1.sent).toBe(0);
    expect(result1.failed).toBe(1);

    const resultDuringBackoff = await backend.drainOutbox('stream-a', failingSender);
    expect(resultDuringBackoff.sent).toBe(0);
    expect(resultDuringBackoff.failed).toBe(0);

    nowMs += 5_000;
    const result2 = await backend.drainOutbox('stream-a', failingSender);
    expect(result2.sent).toBe(0);
    expect(result2.failed).toBe(1);

    nowMs += 10_000;
    const successSender = makeSender();
    const result3 = await backend.drainOutbox('stream-a', successSender);
    expect(result3.sent).toBe(1);
    expect(result3.failed).toBe(0);

    const result4 = await backend.drainOutbox('stream-a', successSender);
    expect(result4.sent).toBe(0);
    expect(result4.failed).toBe(0);
  });
});

/**
 * `SqliteBackend` and `InMemoryBackend` must both work through the
 * `StorageBackend` interface alone, with no cast to an implementation.
 */
describe('StorageBackend DR-2 AC3 substitutability witness (T13)', () => {
  /** Runs one sequence of event, state, outbox and view-cache calls on each backend through the interface. */
  it('StorageBackend_AcceptsBothImpls_AsParametricFixture', async () => {
    const memBackend: StorageBackend = new InMemoryBackend();
    memBackend.initialize();

    const dir = mkdtempSync(join(tmpdir(), 'witness-t13-'));
    const sqliteBackend: StorageBackend = new SqliteBackend(join(dir, 'test.db'));
    sqliteBackend.initialize();

    try {
      for (const b of [memBackend, sqliteBackend]) {
        b.appendEvent('witness-stream', makeEvent({ sequence: 1, streamId: 'witness-stream' }));
        expect(b.getSequence('witness-stream')).toBe(1);

        b.setState('witness-feat', makeState({ featureId: 'witness-feat' }));
        expect(b.getState('witness-feat')).not.toBeNull();

        b.addOutboxEntry('witness-stream', makeEvent({ sequence: 1, streamId: 'witness-stream' }));
        const drain = await b.drainOutbox('witness-stream', makeSender());
        expect(drain).toMatchObject({ sent: expect.any(Number), failed: expect.any(Number) });

        b.setViewCache('witness-stream', 'witness-view', { ok: true }, 1);
        expect(b.getViewCache('witness-stream', 'witness-view')).not.toBeNull();
      }
    } finally {
      memBackend.close();
      sqliteBackend.close();
      rmrf(dir);
    }
  });

  /**
   * `runIntegrityPragma` is optional on the interface, and only SqliteBackend
   * implements it. A caller must check that it is present.
   */
  it('StorageBackend_RuntimeIntegrityPragma_IsOptionalAndDivergent', () => {
    const memBackend: StorageBackend = new InMemoryBackend();
    const sqliteBackend: StorageBackend = new SqliteBackend(':memory:');
    try {
      memBackend.initialize();
      sqliteBackend.initialize();
      expect(memBackend.runIntegrityPragma).toBeUndefined();
      expect(typeof sqliteBackend.runIntegrityPragma).toBe('function');
    } finally {
      memBackend.close();
      sqliteBackend.close();
    }
  });
});

/**
 * `StorageBackend` must declare the projection-snapshot accessors, and both
 * backends must implement them.
 */
describe('StorageBackend projection-snapshot accessor contract', () => {
  /**
   * `interfaceSurface` has the type of a `Pick` of the two snapshot members. A
   * type check of this file fails if the interface drops or renames one of them.
   * The runtime half makes sure that both backends expose the two methods.
   */
  it('BackendContract_DeclaresProjectionSnapshotAccessors', () => {
    const interfaceSurface: Pick<
      StorageBackend,
      'readLatestProjectionSnapshot' | 'appendProjectionSnapshot'
    > = {
      readLatestProjectionSnapshot: (
        _streamId: string,
        _projectionId: string,
        _projectionVersion: string,
      ): SnapshotRecord | undefined => undefined,
      appendProjectionSnapshot: (
        _streamId: string,
        _record: SnapshotRecord,
        _opts?: {
          maxRecords?: number;
          onPrune?: (prunedCount: number) => void;
        },
      ): void => {
      },
    };

    const memBackend: StorageBackend = new InMemoryBackend();
    const sqliteBackend: StorageBackend = new SqliteBackend(':memory:');
    try {
      memBackend.initialize();
      sqliteBackend.initialize();

      expect(typeof memBackend.readLatestProjectionSnapshot).toBe('function');
      expect(typeof memBackend.appendProjectionSnapshot).toBe('function');
      expect(typeof sqliteBackend.readLatestProjectionSnapshot).toBe('function');
      expect(typeof sqliteBackend.appendProjectionSnapshot).toBe('function');
    } finally {
      memBackend.close();
      sqliteBackend.close();
    }

    expect(typeof interfaceSurface.readLatestProjectionSnapshot).toBe('function');
    expect(typeof interfaceSurface.appendProjectionSnapshot).toBe('function');
  });

  /**
   * The appends are out of sequence order (1, 5, 3), and the read must return the
   * highest sequence. A different stream, projection id or version reads nothing.
   * The last append passes `maxRecords: 2`, and the read must then return 9.
   */
  it('MemoryBackend_ProjectionSnapshot_RoundTrip', () => {
    const b: StorageBackend = new InMemoryBackend();
    b.initialize();

    const streamId = 'feat-rt';
    const projectionId = 'task-store';
    const projectionVersion = 'v1';

    expect(
      b.readLatestProjectionSnapshot(streamId, projectionId, projectionVersion),
    ).toBeUndefined();

    const recordAt = (sequence: number): SnapshotRecord => ({
      projectionId,
      projectionVersion,
      sequence,
      state: { count: sequence },
      timestamp: new Date(2025, 0, 1, 0, 0, sequence).toISOString(),
    });

    b.appendProjectionSnapshot(streamId, recordAt(1));
    b.appendProjectionSnapshot(streamId, recordAt(5));
    b.appendProjectionSnapshot(streamId, recordAt(3));

    const latest = b.readLatestProjectionSnapshot(
      streamId,
      projectionId,
      projectionVersion,
    );
    expect(latest).toBeDefined();
    expect(latest!.sequence).toBe(5);
    expect(latest!.state).toEqual({ count: 5 });

    expect(
      b.readLatestProjectionSnapshot(streamId, 'other-projection', projectionVersion),
    ).toBeUndefined();
    expect(
      b.readLatestProjectionSnapshot(streamId, projectionId, 'v2'),
    ).toBeUndefined();
    expect(
      b.readLatestProjectionSnapshot('other-stream', projectionId, projectionVersion),
    ).toBeUndefined();

    b.appendProjectionSnapshot(streamId, recordAt(7));
    b.appendProjectionSnapshot(streamId, recordAt(9), { maxRecords: 2 });

    const afterCap = b.readLatestProjectionSnapshot(
      streamId,
      projectionId,
      projectionVersion,
    );
    expect(afterCap).toBeDefined();
    expect(afterCap!.sequence).toBe(9);
    b.close();
  });
});

describe('InMemoryBackend outbox retry behavior', () => {
  /**
   * InMemoryBackend keeps a failed outbox entry in the queue, as SqliteBackend
   * does, so a later drain with a good sender delivers it. It has no attempt
   * count and no backoff.
   */
  it('drainOutbox_FailedSend_InMemoryBackendKeepsItemForRetry', async () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const event = makeEvent();
    backend.addOutboxEntry('stream-a', event);

    const failingSender = makeFailingSender();

    const result1 = await backend.drainOutbox('stream-a', failingSender);
    expect(result1.sent).toBe(0);
    expect(result1.failed).toBe(1);

    const successSender = makeSender();
    const result2 = await backend.drainOutbox('stream-a', successSender);
    expect(result2.sent).toBe(1);
    expect(result2.failed).toBe(0);
  });
});
