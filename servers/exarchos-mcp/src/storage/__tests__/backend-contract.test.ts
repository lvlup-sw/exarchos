import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import type { WorkflowState } from '../../workflow/types.js';
import type { SnapshotRecord } from '../../projections/snapshot-schema.js';
import type { StorageBackend, EventSender } from '../backend.js';
import { InMemoryBackend, VersionConflictError } from '../memory-backend.js';
import { SqliteBackend } from '../sqlite-backend.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Parameterized Contract Tests ───────────────────────────────────────────

interface BackendFactoryResult {
  backend: StorageBackend;
  cleanup: () => void;
  /**
   * Advance the backend's clock by `ms` milliseconds. For InMemoryBackend
   * this is a no-op (it has no retry-backoff bookkeeping). For
   * SqliteBackend it shifts the injected clock so entries whose
   * `nextRetryAt` is now in the past become eligible again.
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
      advanceClock: () => { /* no clock to advance */ },
    };
  }],
  ['SqliteBackend', (): BackendFactoryResult => {
    const dir = mkdtempSync(join(tmpdir(), 'contract-'));
    let nowMs = Date.now();
    const backend = new SqliteBackend(join(dir, 'test.db'), { clock: () => new Date(nowMs) });
    backend.initialize();
    return {
      backend,
      cleanup: () => { backend.close(); rmSync(dir, { recursive: true }); },
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

  // ─── Event Operations ───────────────────────────────────────────────────

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

  // ─── Wave 4 (#1437) — Correlation-tuple filter contract parity ───────────

  it('BackendContract_QueryEventsCorrelationFilter_IdenticalAcrossBackends', () => {
    // Parity gate for Tasks 10 + 11. The parameterized describe.each above
    // runs this body once per backend; seeding the same events with the
    // same correlation tags and running the same queryEvents calls must
    // produce the same WorkflowEvent sequences on either backend.
    //
    // Drift between the two backends is the failure mode we're guarding
    // against — if SqliteBackend's indexed-WHERE and InMemoryBackend's
    // post-fetch filter ever diverge on shape, sequence ordering, or
    // payload content, this test fails before any view-layer test does.
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

    // correlationId filter: three cor-X events at sequences 1, 2, 4.
    const byCorr = b.queryEvents('stream-a', { correlationId: 'cor-X' });
    expect(byCorr.map((e) => e.sequence)).toEqual([1, 2, 4]);
    expect(byCorr.map((e) => e.type)).toEqual([
      'workflow.started',
      'workflow.started',
      'workflow.started',
    ]);
    expect(byCorr.every((e) => e.correlationId === 'cor-X')).toBe(true);

    // operationId filter: same shape as correlationId in this fixture.
    const byOp = b.queryEvents('stream-a', { operationId: 'op-Y' });
    expect(byOp.map((e) => e.sequence)).toEqual([3, 5, 6]);
    expect(byOp.every((e) => e.operationId === 'op-Y')).toBe(true);

    // causationId filter.
    const byCause = b.queryEvents('stream-a', { causationId: 'cause-X' });
    expect(byCause.map((e) => e.sequence)).toEqual([1, 2, 4]);
    expect(byCause.every((e) => e.causationId === 'cause-X')).toBe(true);

    // Composition with existing sinceSequence filter — exercises the
    // multi-clause WHERE / multi-filter chain path on both backends.
    const byCorrSince = b.queryEvents('stream-a', {
      correlationId: 'cor-X',
      sinceSequence: 1,
    });
    expect(byCorrSince.map((e) => e.sequence)).toEqual([2, 4]);

    // Negative case: a filter that matches nothing returns an empty
    // array on both backends (no surprise undefineds, no nulls).
    const byNone = b.queryEvents('stream-a', { correlationId: 'does-not-exist' });
    expect(byNone).toEqual([]);
  });

  it('BackendContract_QueryEventsByType_HonorsCorrelationFilter', () => {
    // Wave 4 follow-up: the cross-stream typed query surface must honor
    // the same correlation filters as queryEvents — otherwise a caller
    // who passes correlation filters down the type-scoped path gets
    // silently un-filtered results, which would surface as a real bug
    // the moment a telemetry view delegates to queryEventsByType for
    // a cross-stream rollup.
    const b = setup();

    // Spread two stream prefixes that both fall under the same parent
    // prefix so queryEventsByType matches both via the descendant rule.
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

    // Both production backends MUST implement `queryEventsByType` — the
    // EventStore.queryByType runtime feature-detect exists only for legacy
    // in-memory test mocks. The contract-parity suite is parameterised
    // over the two production backends, so any missing implementation is
    // a real regression.
    expect(typeof b.queryEventsByType).toBe('function');
    // Narrow for TypeScript — the assertion above guarantees presence.
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

  // ─── State Operations ──────────────────────────────────────────────────

  it('setState_NewState_CreatesEntry', () => {
    const b = setup();
    const state = makeState({ featureId: 'feat-1' });

    b.setState('feat-1', state);

    const retrieved = b.getState('feat-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.featureId).toBe('feat-1');
  });

  it('setState_CASMatch_Updates', () => {
    const b = setup();
    const state1 = makeState({ featureId: 'feat-1', phase: 'ideate' });
    const state2 = makeState({ featureId: 'feat-1', phase: 'plan' });

    // First set creates version 1
    b.setState('feat-1', state1);
    // CAS update with expectedVersion=1 should succeed (version becomes 2)
    b.setState('feat-1', state2, 1);

    const retrieved = b.getState('feat-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.phase).toBe('plan');
  });

  it('setState_CASMismatch_ThrowsVersionConflict', () => {
    const b = setup();
    const state1 = makeState({ featureId: 'feat-1' });
    const state2 = makeState({ featureId: 'feat-1', phase: 'plan' });

    // First set creates version 1
    b.setState('feat-1', state1);

    // CAS with wrong expected version should throw
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

  // ─── Outbox Operations ─────────────────────────────────────────────────

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

  it('drainOutbox_FailedMidBatch_StopsAndPreservesFifoOrder', async () => {
    const b = setup();
    // Three pending entries; the second one will trip the sender.
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

    // Only the first entry sent successfully; the second failed and the
    // third must remain queued so FIFO order is preserved on the next
    // drain — entry 3 must not be delivered before entry 2 is recovered.
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);

    // SqliteBackend now writes a `nextRetryAt` 2-32s in the future on
    // failure (exponential backoff) and `selectPendingOutbox` filters it
    // out until the clock catches up. Advance past the first-retry window
    // so the next drain sees entry 2 as eligible again. InMemoryBackend
    // has no backoff bookkeeping; `advanceClock` is a no-op there.
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

  // ─── Stream Operations ─────────────────────────────────────────────────

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

  // ─── State Cleanup ─────────────────────────────────────────────────────

  it('deleteState_ExistingState_RemovesEntry', () => {
    const b = setup();

    b.setState('feat-1', makeState({ featureId: 'feat-1' }));
    expect(b.getState('feat-1')).not.toBeNull();

    b.deleteState('feat-1');

    expect(b.getState('feat-1')).toBeNull();
  });

  // ─── Prune Operations ──────────────────────────────────────────────────

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

  // ─── View Cache Operations ─────────────────────────────────────────────

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

// ─── Backend-Specific Divergence Tests ──────────────────────────────────────

describe('SqliteBackend outbox retry behavior', () => {
  let backend: SqliteBackend;
  let dir: string;

  afterEach(() => {
    backend.close();
    rmSync(dir, { recursive: true });
  });

  /**
   * Both backends keep failed outbox entries pending and retry on later
   * drains — the keep-on-failure invariant is verified for both via the
   * `drainOutbox_FailedSend_*` parameterized contract tests above.
   *
   * The SqliteBackend additionally tracks attempt counts and schedules
   * exponential backoff; after exceeding MAX_OUTBOX_RETRIES (5) the row
   * moves to 'dead-letter'. InMemoryBackend skips this bookkeeping (its
   * only consumer is unit tests) but holds the same delivery contract.
   * This focused test pins the sqlite-specific retry-with-backoff path.
   */
  it('drainOutbox_FailedSend_SqliteBackendRetriesWithBackoff', async () => {
    dir = mkdtempSync(join(tmpdir(), 'contract-sqlite-retry-'));
    let nowMs = Date.now();
    backend = new SqliteBackend(join(dir, 'test.db'), { clock: () => new Date(nowMs) });
    backend.initialize();

    const event = makeEvent();
    backend.addOutboxEntry('stream-a', event);

    const failingSender = makeFailingSender();

    // First drain: send fails. The entry's `nextRetryAt` is now ~2s
    // (2^1 * 1000) in the future relative to the injected clock.
    const result1 = await backend.drainOutbox('stream-a', failingSender);
    expect(result1.sent).toBe(0);
    expect(result1.failed).toBe(1);

    // Without advancing time, the entry is still queued but ineligible —
    // the backoff filter excludes it. This verifies the Sentry/Seer fix
    // (selectPendingOutbox honours nextRetryAt).
    const resultDuringBackoff = await backend.drainOutbox('stream-a', failingSender);
    expect(resultDuringBackoff.sent).toBe(0);
    expect(resultDuringBackoff.failed).toBe(0);

    // Advance past the first backoff window — now the entry is eligible
    // and a fresh failure should re-schedule it (attempts=2, ~4s out).
    nowMs += 5_000;
    const result2 = await backend.drainOutbox('stream-a', failingSender);
    expect(result2.sent).toBe(0);
    expect(result2.failed).toBe(1);

    // Advance past the second backoff window. A successful sender now
    // picks up the entry.
    nowMs += 10_000;
    const successSender = makeSender();
    const result3 = await backend.drainOutbox('stream-a', successSender);
    expect(result3.sent).toBe(1);
    expect(result3.failed).toBe(0);

    // After successful send, outbox should be drained.
    const result4 = await backend.drainOutbox('stream-a', successSender);
    expect(result4.sent).toBe(0);
    expect(result4.failed).toBe(0);
  });
});

// ─── DR-2 AC3 Substitutability Witness (T13) ────────────────────────────────
//
// DR-2 AC3 (durable-event-store-substrate plan): "Test-doubles use
// `MemoryBackend` injected through the same context shape." Phase 2
// introduces `DispatchContext.storage: StorageBackend`; this witness pins
// the contract that both production (`SqliteBackend`) and test-double
// (`InMemoryBackend`) implementations are substitutable through the
// `StorageBackend` interface alone, with no implementation-specific
// downcasts. The parametric `describe.each` block above already exercises
// the full method surface against both backends; this targeted test
// names the substitutability invariant explicitly so a future refactor
// cannot silently drop one branch of the abstraction.
describe('StorageBackend DR-2 AC3 substitutability witness (T13)', () => {
  it('StorageBackend_AcceptsBothImpls_AsParametricFixture', async () => {
    // Both implementations must be assignable to the `StorageBackend`
    // type without any cast. The TypeScript compiler enforces this at
    // build time; the runtime assertions below additionally verify that
    // a small multi-method sequence — the surface Phase 2's
    // DispatchContext.storage will exercise — works uniformly through
    // the interface.
    const memBackend: StorageBackend = new InMemoryBackend();
    memBackend.initialize();

    const dir = mkdtempSync(join(tmpdir(), 'witness-t13-'));
    const sqliteBackend: StorageBackend = new SqliteBackend(join(dir, 'test.db'));
    sqliteBackend.initialize();

    try {
      for (const b of [memBackend, sqliteBackend]) {
        // Event append + sequence read.
        b.appendEvent('witness-stream', makeEvent({ sequence: 1, streamId: 'witness-stream' }));
        expect(b.getSequence('witness-stream')).toBe(1);

        // State CAS round-trip.
        b.setState('witness-feat', makeState({ featureId: 'witness-feat' }));
        expect(b.getState('witness-feat')).not.toBeNull();

        // Outbox add + drain (returns DrainResult shape).
        b.addOutboxEntry('witness-stream', makeEvent({ sequence: 1, streamId: 'witness-stream' }));
        const drain = await b.drainOutbox('witness-stream', makeSender());
        expect(drain).toMatchObject({ sent: expect.any(Number), failed: expect.any(Number) });

        // View cache round-trip.
        b.setViewCache('witness-stream', 'witness-view', { ok: true }, 1);
        expect(b.getViewCache('witness-stream', 'witness-view')).not.toBeNull();
      }
    } finally {
      memBackend.close();
      sqliteBackend.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('StorageBackend_RuntimeIntegrityPragma_IsOptionalAndDivergent', () => {
    // The interface marks `runIntegrityPragma` as optional; only
    // SqliteBackend implements it. Phase 2 callers must guard with a
    // presence check rather than assuming uniform availability. This
    // test pins the divergence so Phase 2 cannot silently start
    // depending on it for InMemoryBackend.
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

// ─── Projection Snapshot Accessors (Wave A, #1343) ──────────────────────────
//
// Compile-time + runtime contract test that the StorageBackend interface
// declares snapshot accessors. The compile-time half lives in the value of
// `interfaceSurface` below — the object literal must structurally match the
// interface, so any drop or rename on the interface side breaks the test
// at typecheck time. The runtime half asserts that both implementations
// expose the methods as callable functions.
describe('StorageBackend projection-snapshot accessor contract', () => {
  it('BackendContract_DeclaresProjectionSnapshotAccessors', () => {
    // Compile-time check: this object literal must be assignable to a
    // Pick of the interface's snapshot members. If the interface drops
    // either method (or renames it), tsc will reject the assignment
    // and the next typecheck run fails loudly.
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
        /* contract probe */
      },
    };

    // Runtime presence checks on both implementations.
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

    // Reference the object so it can't be eliminated as dead code.
    expect(typeof interfaceSurface.readLatestProjectionSnapshot).toBe('function');
    expect(typeof interfaceSurface.appendProjectionSnapshot).toBe('function');
  });

  it('MemoryBackend_ProjectionSnapshot_RoundTrip', () => {
    const b: StorageBackend = new InMemoryBackend();
    b.initialize();

    const streamId = 'feat-rt';
    const projectionId = 'task-store';
    const projectionVersion = 'v1';

    // Empty: returns undefined.
    expect(
      b.readLatestProjectionSnapshot(streamId, projectionId, projectionVersion),
    ).toBeUndefined();

    // Insert three records for the same (streamId, projectionId, projectionVersion)
    // with sequences 1, 5, 3. Order of inserts is intentionally not monotonic.
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

    // readLatest returns the highest-sequence record.
    const latest = b.readLatestProjectionSnapshot(
      streamId,
      projectionId,
      projectionVersion,
    );
    expect(latest).toBeDefined();
    expect(latest!.sequence).toBe(5);
    expect(latest!.state).toEqual({ count: 5 });

    // A different (projectionId, projectionVersion) coordinate is isolated.
    expect(
      b.readLatestProjectionSnapshot(streamId, 'other-projection', projectionVersion),
    ).toBeUndefined();
    expect(
      b.readLatestProjectionSnapshot(streamId, projectionId, 'v2'),
    ).toBeUndefined();
    expect(
      b.readLatestProjectionSnapshot('other-stream', projectionId, projectionVersion),
    ).toBeUndefined();

    // Size cap: with maxRecords=2 after appending two more records the
    // oldest two by sequence are evicted, leaving the two highest.
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
   * After the v2.9 outbox-drain fix, InMemoryBackend keeps failed entries
   * in the queue (slice + remove-on-success) so a subsequent drain with a
   * working sender can pick them up. This matches SqliteBackend's
   * keep-on-failure semantics — fewer surprises when production code is
   * exercised against the test double.
   *
   * SqliteBackend additionally tracks attempt counts and schedules
   * exponential backoff before dead-lettering. InMemoryBackend skips
   * those bookkeeping fields (its only consumer is unit tests), but the
   * core invariant — "failed sends do not vanish" — now holds for both.
   */
  it('drainOutbox_FailedSend_InMemoryBackendKeepsItemForRetry', async () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const event = makeEvent();
    backend.addOutboxEntry('stream-a', event);

    const failingSender = makeFailingSender();

    // First drain: send fails, item must remain in the queue.
    const result1 = await backend.drainOutbox('stream-a', failingSender);
    expect(result1.sent).toBe(0);
    expect(result1.failed).toBe(1);

    // A working sender on the next drain picks up the still-pending entry.
    const successSender = makeSender();
    const result2 = await backend.drainOutbox('stream-a', successSender);
    expect(result2.sent).toBe(1);
    expect(result2.failed).toBe(0);
  });
});
