import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

import { EventStore } from '../../../src/events/store.js';
import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import {
  SubscriptionRegistry,
  DEFAULT_FLOOR_MS,
  type SubscriptionClock,
  type SubscriptionEventReader,
} from '../../../src/events/subscriptions.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { InMemoryBackend } from '../../../src/storage/memory-backend.js';
import { makeTempDir, rmrf } from '../../../tools/test-helpers/temp-dir.js';
import { runInspectFollow, type FollowSubscribe } from '../../../src/cli/follow-loop.js';
import { tasksFollow } from '../../../src/mcp/tasks-methods.js';
import { handleViewWait, type WaitDeps } from '../../../src/projections/views/lifecycle/wait.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import type { Frame } from '../../../src/ndjson/frames.js';

/** A fixed clock. It never reads the wall time. */
const fixedClock: SubscriptionClock = { now: () => 0 };

/**
 * An in-memory event log that implements the read seam of the registry.
 * A test can drive exact interleavings with it, such as a foreign append with no wake, and needs no SQLite.
 */
class FakeLog implements SubscriptionEventReader {
  private readonly streams = new Map<string, WorkflowEvent[]>();
  private tick = 0;
  /**
   * The Tier-2 change token, a model of `PRAGMA data_version`. Only a foreign commit changes it.
   * {@link commit} models an own commit and changes only the log.
   * {@link commitForeign} models a commit on another connection. It changes the token and fires no wake.
   */
  private version = 0;

  /** An own commit. It appends and does not change `dataVersion`. */
  commit(streamId: string, type: string): WorkflowEvent {
    const arr = this.streams.get(streamId) ?? [];
    const event = {
      streamId,
      sequence: arr.length + 1,
      type,
      timestamp: new Date(this.tick++).toISOString(),
    } as WorkflowEvent;
    arr.push(event);
    this.streams.set(streamId, arr);
    return event;
  }

  /** A foreign commit. It appends and changes `dataVersion`. */
  commitForeign(streamId: string, type: string): WorkflowEvent {
    const event = this.commit(streamId, type);
    this.version++;
    return event;
  }

  headSequence(streamId: string): number {
    return this.streams.get(streamId)?.length ?? 0;
  }

  readStreamAfter(streamId: string, afterSequence: number): readonly WorkflowEvent[] {
    return (this.streams.get(streamId) ?? []).filter((e) => e.sequence > afterSequence);
  }

  listStreams(): readonly string[] {
    return [...this.streams.keys()];
  }

  dataVersion(): number {
    return this.version;
  }
}

/** Counts the calls to a reader. It pins the zero-subscriber guard. */
class SpyReader implements SubscriptionEventReader {
  headCalls = 0;
  readCalls = 0;
  listCalls = 0;
  /** Counts the Tier-2 token reads apart from the event-log reads. */
  versionCalls = 0;
  constructor(private readonly inner: SubscriptionEventReader) {}
  headSequence(streamId: string): number {
    this.headCalls++;
    return this.inner.headSequence(streamId);
  }
  readStreamAfter(streamId: string, afterSequence: number): readonly WorkflowEvent[] {
    this.readCalls++;
    return this.inner.readStreamAfter(streamId, afterSequence);
  }
  listStreams(): readonly string[] {
    this.listCalls++;
    return this.inner.listStreams();
  }
  dataVersion(): number {
    this.versionCalls++;
    return this.inner.dataVersion();
  }
  /** The event-log reads only. `versionCalls` holds the token reads. */
  get totalCalls(): number {
    return this.headCalls + this.readCalls + this.listCalls;
  }
}

/**
 * Wraps a reader so that `readStreamAfter` throws for the stream in `throwOn`.
 * It models a read failure in the middle of a cross-stream drain. A test sets and clears `throwOn` for each phase.
 */
class ThrowOnStreamReader implements SubscriptionEventReader {
  throwOn: string | null = null;
  constructor(private readonly inner: SubscriptionEventReader) {}
  headSequence(streamId: string): number {
    return this.inner.headSequence(streamId);
  }
  readStreamAfter(streamId: string, afterSequence: number): readonly WorkflowEvent[] {
    if (this.throwOn === streamId) throw new Error(`read boom on ${streamId}`);
    return this.inner.readStreamAfter(streamId, afterSequence);
  }
  listStreams(): readonly string[] {
    return this.inner.listStreams();
  }
  dataVersion(): number {
    return this.inner.dataVersion();
  }
}

/**
 * Wraps a reader so that `dataVersion()` throws while `throwNext` is set.
 * It models the transient storage failure that a Tier-2 floor tick must contain.
 */
class ThrowOnDataVersionReader implements SubscriptionEventReader {
  throwNext = false;
  constructor(private readonly inner: SubscriptionEventReader) {}
  headSequence(streamId: string): number {
    return this.inner.headSequence(streamId);
  }
  readStreamAfter(streamId: string, afterSequence: number): readonly WorkflowEvent[] {
    return this.inner.readStreamAfter(streamId, afterSequence);
  }
  listStreams(): readonly string[] {
    return this.inner.listStreams();
  }
  dataVersion(): number {
    if (this.throwNext) throw new Error('dataVersion boom');
    return this.inner.dataVersion();
  }
}

/**
 * A clock that the test drives, for deterministic Tier-2 floor tests.
 * It records each scheduled floor loop and its interval. {@link fireAll} fires one tick on each live loop with no sleep.
 * A cancelled loop leaves {@link scheduledIntervals} and stops.
 */
class ManualClock implements SubscriptionClock {
  time = 0;
  private readonly loops: Array<{ tick: () => void; intervalMs: number }> = [];
  now(): number {
    return this.time;
  }
  scheduleInterval(tick: () => void, intervalMs: number): () => void {
    const entry = { tick, intervalMs };
    this.loops.push(entry);
    return () => {
      const i = this.loops.indexOf(entry);
      if (i >= 0) this.loops.splice(i, 1);
    };
  }
  /** Fires one tick on each scheduled floor loop. */
  fireAll(): void {
    for (const { tick } of [...this.loops]) tick();
  }
  /** The intervals of the live floor loops, in schedule order. */
  get scheduledIntervals(): number[] {
    return this.loops.map((l) => l.intervalMs);
  }
  get loopCount(): number {
    return this.loops.length;
  }
}

const STREAM = 'feat-1';
const T1 = 'task.progressed';
const T2 = 'task.completed';
const T3 = 'workflow.transition';

/** Tier-1 delivery through a real store and its appender. */
describe('EventStore.subscribe (DR-1 cursor-pump, Tier-1)', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(async () => {
    dir = makeTempDir('subscriptions-');
    store = new EventStore(dir);
    await store.initialize();
  });

  /** Closes the SQLite handles before the removal of the temp directory. Windows cannot delete an open file. */
  afterEach(() => {
    store.close();
    rmrf(dir);
  });

  /** Delivery is synchronous after each commit, in ascending sequence order. */
  it('Subscribe_InProcessAppend_CursorDrainDeliversPostCommitInOrder', async () => {
    const received: WorkflowEvent[] = [];
    const handle = store.subscribe({ streamId: STREAM }, (e) => received.push(e));

    await store.append(STREAM, { type: T1, data: {} });
    await store.append(STREAM, { type: T2, data: {} });
    await store.append(STREAM, { type: T3, data: {} });

    expect(received.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(received.map((e) => e.type)).toEqual([T1, T2, T3]);
    handle.dispose();
  });

  /**
   * A second `EventStore` on the same directory models a foreign connection. Its commit does not wake the registry of `store`.
   * The wake of the own commit must drain the foreign event first: sequence 1, then sequence 2.
   */
  it('Subscribe_ForeignThenOwnCommit_DeliversInGlobalSequenceOrder', async () => {
    const foreign = new EventStore(dir);
    await foreign.initialize();
    try {
      const received: WorkflowEvent[] = [];
      const handle = store.subscribe({ streamId: STREAM }, (e) => received.push(e));

      await foreign.append(STREAM, { type: T1, data: {} });
      await store.append(STREAM, { type: T2, data: {} });

      expect(received.map((e) => e.sequence)).toEqual([1, 2]);
      handle.dispose();
    } finally {
      foreign.close();
    }
  });

  /**
   * One transaction with three events gives one wake and one drain.
   * The throw on sequence 1 must not drop sequences 2 and 3 for the listener that threw.
   * It must not change the sibling listener, the append result, or a later append.
   */
  it('Subscribe_ListenerThrows_AppendUnaffectedSiblingsAndLaterEventsDelivered', async () => {
    const good: number[] = [];
    const bad: number[] = [];
    const hGood = store.subscribe({ streamId: STREAM }, (e) => good.push(e.sequence));
    const hBad = store.subscribe({ streamId: STREAM }, (e) => {
      bad.push(e.sequence);
      if (e.sequence === 1) throw new Error('listener boom on N+1');
    });

    const result = await store.batchAppend(STREAM, [
      { type: T1, data: {} },
      { type: T2, data: {} },
      { type: T3, data: {} },
    ]);

    expect(result.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(good).toEqual([1, 2, 3]);
    expect(bad).toEqual([1, 2, 3]);

    const after = await store.append(STREAM, { type: T1, data: {} });
    expect(after.sequence).toBe(4);
    expect(good).toEqual([1, 2, 3, 4]);
    hGood.dispose();
    hBad.dispose();
  });

  /**
   * The listener appends to the same stream during delivery.
   * The Tier-1 hook fires after the per-stream mutex releases, so the append must not deadlock.
   * The wake of the nested append delivers `T2`.
   */
  it('Subscribe_ListenerAppendsSameStream_NoDeadlockDeliveredNextDrain', async () => {
    const received: string[] = [];
    const nested: Array<Promise<unknown>> = [];
    let reentered = false;
    const handle = store.subscribe({ streamId: STREAM }, (e) => {
      received.push(e.type);
      if (e.type === T1 && !reentered) {
        reentered = true;
        nested.push(store.append(STREAM, { type: T2, data: {} }));
      }
    });

    await store.append(STREAM, { type: T1, data: {} });
    await Promise.all(nested);

    expect(received).toEqual([T1, T2]);
    handle.dispose();
  });

  /**
   * Store level: a repeated append with the same idempotency key delivers no new event.
   * Appender level: the commit hook fires for the first commit and not for the cache hit.
   * Only the hook count proves that no wake occurs. At store level, the cursor also prevents a second delivery.
   */
  it('Subscribe_IdempotencyCacheHit_NoWakeNoRedelivery', async () => {
    const received: WorkflowEvent[] = [];
    const handle = store.subscribe({ streamId: STREAM }, (e) => received.push(e));
    const key = 'idem-key-1';
    await store.append(STREAM, { type: T1, data: {} }, { idempotencyKey: key });
    expect(received).toHaveLength(1);
    await store.append(STREAM, { type: T1, data: {} }, { idempotencyKey: key });
    expect(received).toHaveLength(1);
    handle.dispose();

    const wakes: string[] = [];
    const appenderDir = makeTempDir('appender-');
    const appender = new AtomicAppender({ stateDir: appenderDir });
    appender.setCommitHook((s) => wakes.push(s));
    try {
      const first = await appender.append('s', [{ type: T1 }], 'k1');
      const second = await appender.append('s', [{ type: T1 }], 'k1');
      expect(first.ok && first.kind).toBe('committed');
      expect(second.ok && second.kind).toBe('cache-hit');
      expect(wakes).toEqual(['s']);
    } finally {
      appender.close();
      rmrf(appenderDir);
    }
  });

  it('Subscribe_EventTypesFilter_DeliversOnlyMatchingTypes', async () => {
    const received: string[] = [];
    const handle = store.subscribe(
      { streamId: STREAM, eventTypes: [T2] },
      (e) => received.push(e.type),
    );
    await store.append(STREAM, { type: T1, data: {} });
    await store.append(STREAM, { type: T2, data: {} });
    await store.append(STREAM, { type: T1, data: {} });
    await store.append(STREAM, { type: T2, data: {} });
    expect(received).toEqual([T2, T2]);
    handle.dispose();
  });

  /** `fromSequence: 2` sets the cursor at 2, so the subscriber receives only the sequences after 2. */
  it('Subscribe_FromSequence_SkipsBaselineDeliversAfterCursor', async () => {
    await store.append(STREAM, { type: T1, data: {} });
    await store.append(STREAM, { type: T1, data: {} });
    const received: number[] = [];
    const handle = store.subscribe({ streamId: STREAM }, (e) => received.push(e.sequence), {
      fromSequence: 2,
    });
    expect(received).toEqual([]);
    await store.append(STREAM, { type: T1, data: {} });
    expect(received).toEqual([3]);
    handle.dispose();
  });

  it('Subscribe_DispatchReturns_HandleDisposedStopsDelivery', async () => {
    const received: number[] = [];
    const handle = store.subscribe({ streamId: STREAM }, (e) => received.push(e.sequence));
    await store.append(STREAM, { type: T1, data: {} });
    expect(received).toEqual([1]);
    handle.dispose();
    expect(handle.disposed).toBe(true);
    await store.append(STREAM, { type: T1, data: {} });
    expect(received).toEqual([1]);
  });

  /**
   * Pins the append behavior with no subscriber, so the store installs no commit hook.
   * A new commit returns its sequence, a retry with the same key returns the same sequence, and the stream holds one event.
   */
  it('Append_CharacterizationBaseline_UnchangedWithHook', async () => {
    const key = 'char-key';
    const first = await store.append(STREAM, { type: T1, data: {} }, { idempotencyKey: key });
    const retry = await store.append(STREAM, { type: T1, data: {} }, { idempotencyKey: key });
    expect(first.sequence).toBe(1);
    expect(retry.sequence).toBe(first.sequence);
    const all = await store.query(STREAM);
    expect(all).toHaveLength(1);
  });
});

/** Registry tests on the `FakeLog` fixture and its wrappers. No test in this suite opens SQLite. */
describe('SubscriptionRegistry (DR-1 invariants)', () => {
  /**
   * The registry returns to size 0 after each handle is disposed.
   * A second `dispose()` and a `disposeAll()` on an empty registry are safe.
   */
  it('Subscribe_DispatchReturns_HandleDisposedRegistryZero', () => {
    const log = new FakeLog();
    const registry = new SubscriptionRegistry(log, { clock: fixedClock });
    const handles = [
      registry.subscribe({ streamId: STREAM }, () => {}),
      registry.subscribe({ streamId: STREAM }, () => {}),
      registry.subscribe({ eventTypes: [T1] }, () => {}),
    ];
    expect(registry.size).toBe(3);

    for (const h of handles) h.dispose();
    expect(handles.every((h) => h.disposed)).toBe(true);
    expect(registry.size).toBe(0);

    handles[0].dispose();
    registry.disposeAll();
    expect(registry.size).toBe(0);
  });

  /**
   * With zero subscribers, a wake reads nothing from the reader.
   * With one subscriber, a wake does read, which proves that the guard is live code.
   */
  it('Append_ZeroSubscribers_GuardCheckOnly', () => {
    const spy = new SpyReader(new FakeLog());
    const registry = new SubscriptionRegistry(spy, { clock: fixedClock });
    expect(registry.size).toBe(0);

    registry.wake(STREAM);
    expect(spy.totalCalls).toBe(0);

    const handle = registry.subscribe({ streamId: STREAM }, () => {});
    const before = spy.totalCalls;
    registry.wake(STREAM);
    expect(spy.totalCalls).toBeGreaterThan(before);
    handle.dispose();
  });

  it('exposes the injectable-clock + floor seam for task-002 (Tier-2)', () => {
    const log = new FakeLog();
    const registry = new SubscriptionRegistry(log, { clock: fixedClock });
    expect(registry.clock).toBe(fixedClock);
    expect(registry.defaultFloorMs).toBe(DEFAULT_FLOOR_MS);
    const custom = new SubscriptionRegistry(log, { clock: fixedClock, defaultFloorMs: 40 });
    expect(custom.defaultFloorMs).toBe(40);
  });

  /**
   * Property over any append sequence, registration point `k`, and type filter.
   * The subscriber receives exactly its matching events after the registration cursor, one time each, in ascending order.
   * The appends before `k` get no wake. Each later append gets a Tier-1 wake. A sequence is the 1-based append index.
   */
  it('Subscribe_RegistrationConcurrentWithAppends_InitialDrainNoLoss', () => {
    fc.assert(
      fc.property(
        fc.record({
          types: fc.array(fc.constantFrom(T1, T2, T3), { minLength: 0, maxLength: 14 }),
          regNat: fc.nat(),
          filterTypes: fc.subarray([T1, T2, T3]),
        }),
        ({ types, regNat, filterTypes }) => {
          const log = new FakeLog();
          const registry = new SubscriptionRegistry(log, { clock: fixedClock });
          const k = regNat % (types.length + 1);

          for (let i = 0; i < k; i++) log.commit(STREAM, types[i]);

          const received: WorkflowEvent[] = [];
          const filter =
            filterTypes.length > 0
              ? { streamId: STREAM, eventTypes: filterTypes }
              : { streamId: STREAM };
          const handle = registry.subscribe(filter, (e) => received.push(e));

          for (let i = k; i < types.length; i++) {
            log.commit(STREAM, types[i]);
            registry.wake(STREAM);
          }

          const matches = (t: string) => filterTypes.length === 0 || filterTypes.includes(t);
          const expectedSeqs: number[] = [];
          for (let i = k; i < types.length; i++) {
            if (matches(types[i])) expectedSeqs.push(i + 1);
          }

          const gotSeqs = received.map((e) => e.sequence);
          expect(gotSeqs).toEqual(expectedSeqs);
          expect(new Set(gotSeqs).size).toBe(gotSeqs.length);

          handle.dispose();
          expect(registry.size).toBe(0);
        },
      ),
      { numRuns: 250 },
    );
  });

  /**
   * The stream `other` has head 1 at registration, so its sequence 1 is baseline and only sequence 2 arrives.
   * The stream `fresh` does not exist at registration, so its cursor starts at 0 and each event arrives.
   */
  it('cross-stream subscription delivers new-stream events post-registration', () => {
    const log = new FakeLog();
    log.commit('other', T1);
    const registry = new SubscriptionRegistry(log, { clock: fixedClock });
    const received: string[] = [];
    const handle = registry.subscribe({}, (e) => received.push(`${e.streamId}#${e.sequence}`));

    log.commit('other', T2);
    registry.wake('other');
    log.commit('fresh', T1);
    registry.wake('fresh');

    expect(received).toEqual(['other#2', 'fresh#1']);
    handle.dispose();
  });

  /**
   * The Tier-2 floor tick runs in a native `setInterval` callback, so it must contain a `dataVersion()` failure.
   * An uncontained throw is an unhandled exception at process level.
   * The failed tick must not fold the foreign commit into the baseline. The next tick still delivers it.
   */
  it('FloorTick_DataVersionThrows_ContainedAndLaterTickStillDeliversForeignCommit', () => {
    const log = new FakeLog();
    const reader = new ThrowOnDataVersionReader(log);
    const clock = new ManualClock();
    const registry = new SubscriptionRegistry(reader, { clock });
    const received: number[] = [];
    const handle = registry.subscribe({ streamId: STREAM }, (e) => received.push(e.sequence));

    log.commitForeign(STREAM, T1);

    reader.throwNext = true;
    expect(() => clock.fireAll()).not.toThrow();
    expect(received).toEqual([]);

    reader.throwNext = false;
    clock.fireAll();
    expect(received).toEqual([1]);

    handle.dispose();
  });

  /**
   * A cross-stream drain must advance the per-stream cursors only after it assembles the full batch.
   * The scan uses insertion order, so it reads `stream-a` (one new event) before `stream-z` (throws).
   * The registry discards the batch and delivers nothing. The cursor of `stream-a` must stay at 1.
   * After `stream-z` heals, the next drain delivers `stream-a#2` one time.
   */
  it('Drain_CrossStreamLaterReadThrows_EarlierCursorNotAdvanced_Redelivered', () => {
    const log = new FakeLog();
    log.commit('stream-a', T1);
    log.commit('stream-z', T1);
    const reader = new ThrowOnStreamReader(log);
    const registry = new SubscriptionRegistry(reader, { clock: fixedClock });

    const received: string[] = [];
    const handle = registry.subscribe({}, (e) => received.push(`${e.streamId}#${e.sequence}`));
    expect(received).toEqual([]);

    log.commit('stream-a', T2);
    reader.throwOn = 'stream-z';
    registry.wake('stream-a');
    expect(received).toEqual([]);

    reader.throwOn = null;
    registry.wake('stream-a');
    expect(received).toEqual(['stream-a#2']);

    handle.dispose();
    expect(registry.size).toBe(0);
  });
});

/** Minimal valid event for direct backend appends. */
function makeEvent(streamId: string, sequence: number, type: string): WorkflowEvent {
  return {
    streamId,
    sequence,
    type,
    timestamp: new Date(sequence).toISOString(),
    schemaVersion: '1.0',
  } as WorkflowEvent;
}

describe('StorageBackend.dataVersion (DR-1 Tier-2 change token)', () => {
  /**
   * The test opens two real SQLite connections on one database file in WAL mode.
   * `SqliteBackend` sets `busy_timeout` to 5000 on each connection, so short contention between the two gives no `SQLITE_BUSY`.
   * A mock cannot reproduce the difference between own and foreign commits in `PRAGMA data_version`.
   * An own commit must not change the token of the observer, because Tier 1 delivers own commits.
   * Each foreign commit must change it.
   */
  it('DataVersion_Sqlite_ForeignCommitOnlyVisibility', () => {
    const dir = makeTempDir('dataversion-sqlite-');
    const dbPath = join(dir, 'exarchos.db');
    const observer = new SqliteBackend(dbPath);
    const foreign = new SqliteBackend(dbPath);
    observer.initialize();
    foreign.initialize();
    try {
      const baseline = observer.dataVersion();

      observer.appendEvent('feat-1', makeEvent('feat-1', 1, T1));
      expect(observer.dataVersion()).toBe(baseline);

      foreign.appendEvent('feat-1', makeEvent('feat-1', 2, T2));
      const afterForeign = observer.dataVersion();
      expect(afterForeign).not.toBe(baseline);

      observer.appendEvent('feat-1', makeEvent('feat-1', 3, T3));
      expect(observer.dataVersion()).toBe(afterForeign);

      foreign.appendEvent('feat-1', makeEvent('feat-1', 4, T1));
      expect(observer.dataVersion()).not.toBe(afterForeign);
    } finally {
      observer.close();
      foreign.close();
      rmrf(dir);
    }
  });

  /**
   * The in-memory backend has no foreign connection, so each append increases the counter.
   * A read with no append between is stable.
   */
  it('DataVersion_InMemory_MonotonicOnAppend', () => {
    const backend = new InMemoryBackend();
    backend.initialize();
    try {
      const v0 = backend.dataVersion();
      backend.appendEvent('s', makeEvent('s', 1, T1));
      const v1 = backend.dataVersion();
      backend.appendEvent('s', makeEvent('s', 2, T2));
      const v2 = backend.dataVersion();

      expect(v1).toBeGreaterThan(v0);
      expect(v2).toBeGreaterThan(v1);
      expect(backend.dataVersion()).toBe(v2);
    } finally {
      backend.close();
    }
  });
});

describe('EventStore.subscribe Tier-2 poll floor (DR-1, real backends)', () => {
  let dir: string;
  let store: EventStore;
  let foreign: EventStore;

  beforeEach(async () => {
    dir = makeTempDir('floor-');
    store = new EventStore(dir);
    foreign = new EventStore(dir);
    await store.initialize();
    await foreign.initialize();
  });

  afterEach(() => {
    store.close();
    foreign.close();
    rmrf(dir);
  });

  /**
   * The first `subscribe` call injects the manual clock, because the store creates its registry on that call and keeps the clock.
   * Foreign commits after registration give no Tier-1 wake to `store`.
   * One floor tick sees the changed `dataVersion` and delivers both events in order.
   */
  it('Floor_ForeignCommit_DrainedInGlobalOrderNextTick', async () => {
    const clock = new ManualClock();
    const received: number[] = [];
    const handle = store.subscribe(
      { streamId: STREAM },
      (e) => received.push(e.sequence),
      undefined,
      { clock },
    );

    await foreign.append(STREAM, { type: T1, data: {} });
    await foreign.append(STREAM, { type: T2, data: {} });

    expect(received).toEqual([]);

    clock.fireAll();
    expect(received).toEqual([1, 2]);

    handle.dispose();
  });

  /**
   * A floor tick delivers the foreign sequence 1. The Tier-1 wake of the own append then delivers sequence 2.
   * A further tick finds the token unchanged, so it delivers nothing.
   */
  it('Floor_ForeignThenOwnAppend_NoGapNoDoubleDelivery', async () => {
    const clock = new ManualClock();
    const received: number[] = [];
    const handle = store.subscribe(
      { streamId: STREAM },
      (e) => received.push(e.sequence),
      undefined,
      { clock },
    );

    await foreign.append(STREAM, { type: T1, data: {} });
    clock.fireAll();
    expect(received).toEqual([1]);

    await store.append(STREAM, { type: T2, data: {} });
    expect(received).toEqual([1, 2]);

    clock.fireAll();
    expect(received).toEqual([1, 2]);

    handle.dispose();
  });
});

describe('SubscriptionRegistry Tier-2 poll floor (DR-1 invariants)', () => {
  /**
   * The instrumented reader makes a foreign commit after the head read of the registration and before the `dataVersion` baseline.
   * The initial drain must deliver it, because its sequence is after the cursor.
   * A later tick must not deliver it again, because the baseline already holds its token change.
   */
  it('Floor_CommitBetweenHeadReadAndBaseline_DeliveredByInitialDrain', () => {
    const log = new FakeLog();
    const clock = new ManualClock();
    let injected = false;
    const seam: SubscriptionEventReader = {
      headSequence: (s) => {
        const head = log.headSequence(s);
        if (!injected) {
          injected = true;
          log.commitForeign(STREAM, T1);
        }
        return head;
      },
      readStreamAfter: (s, after) => log.readStreamAfter(s, after),
      listStreams: () => log.listStreams(),
      dataVersion: () => log.dataVersion(),
    };
    const registry = new SubscriptionRegistry(seam, { clock });
    const received: number[] = [];
    const handle = registry.subscribe({ streamId: STREAM }, (e) => received.push(e.sequence));

    expect(received).toEqual([1]);
    clock.fireAll();
    clock.fireAll();
    expect(received).toEqual([1]);

    handle.dispose();
  });

  /** A tick with no `dataVersion` change reads the token and stops. It does not scan the event log again. */
  it('Floor_NoForeignCommit_NoReRead', () => {
    const spy = new SpyReader(new FakeLog());
    const clock = new ManualClock();
    const registry = new SubscriptionRegistry(spy, { clock });
    const handle = registry.subscribe({ streamId: STREAM }, () => {});

    const readsAfterInit = spy.readCalls;
    const versionAfterInit = spy.versionCalls;

    clock.fireAll();
    clock.fireAll();
    clock.fireAll();

    expect(spy.readCalls).toBe(readsAfterInit);
    expect(spy.versionCalls).toBeGreaterThan(versionAfterInit);
    expect(handle.perf().floorTicks).toBe(3);
    expect(handle.perf().floorDrains).toBe(0);

    handle.dispose();
  });

  /**
   * A `floorMs` option on the call overrides the registry default and sets the interval of the floor loop.
   * Disposal cancels the loop.
   */
  it('Floor_PerCallIntervalOverride_Honored', () => {
    const log = new FakeLog();
    const clock = new ManualClock();
    const registry = new SubscriptionRegistry(log, { clock, defaultFloorMs: 250 });

    const handle = registry.subscribe({ streamId: STREAM }, () => {}, { floorMs: 40 });
    expect(clock.scheduledIntervals).toEqual([40]);
    expect(handle.perf().floorMs).toBe(40);

    handle.dispose();
    expect(clock.scheduledIntervals).toEqual([]);
    expect(clock.loopCount).toBe(0);
  });

  /** With no override, `perf()` reports `DEFAULT_FLOOR_MS`, and the floor loop uses it as its interval. */
  it('Floor_DefaultInterval_SurfacedInPerf', () => {
    const log = new FakeLog();
    const clock = new ManualClock();
    const registry = new SubscriptionRegistry(log, { clock });

    const handle = registry.subscribe({ streamId: STREAM }, () => {});
    expect(handle.perf().floorMs).toBe(DEFAULT_FLOOR_MS);
    expect(clock.scheduledIntervals).toEqual([DEFAULT_FLOOR_MS]);

    handle.dispose();
  });

  /**
   * Property over any split of appends across two connections, any tick schedule, and any registration point.
   * An own append fires a Tier-1 wake. A foreign append changes `dataVersion` and fires no wake.
   * The subscriber receives each matching event after registration one time, in sequence order.
   * One last tick models the continuous poll of the floor. Without the floor loop, a last foreign commit never arrives.
   */
  it('Floor_ArbitrarySplitAndSchedule_ExactlyOnceInOrder', () => {
    fc.assert(
      fc.property(
        fc.record({
          ops: fc.array(
            fc.record({
              type: fc.constantFrom(T1, T2, T3),
              foreign: fc.boolean(),
              tickAfter: fc.boolean(),
            }),
            { minLength: 0, maxLength: 16 },
          ),
          regNat: fc.nat(),
          filterTypes: fc.subarray([T1, T2, T3]),
        }),
        ({ ops, regNat, filterTypes }) => {
          const log = new FakeLog();
          const clock = new ManualClock();
          const registry = new SubscriptionRegistry(log, { clock });
          const k = regNat % (ops.length + 1);

          for (let i = 0; i < k; i++) {
            const op = ops[i];
            if (op.foreign) log.commitForeign(STREAM, op.type);
            else log.commit(STREAM, op.type);
          }

          const received: WorkflowEvent[] = [];
          const filter =
            filterTypes.length > 0
              ? { streamId: STREAM, eventTypes: filterTypes }
              : { streamId: STREAM };
          const handle = registry.subscribe(filter, (e) => received.push(e));

          for (let i = k; i < ops.length; i++) {
            const op = ops[i];
            if (op.foreign) {
              log.commitForeign(STREAM, op.type);
            } else {
              log.commit(STREAM, op.type);
              registry.wake(STREAM);
            }
            if (op.tickAfter) clock.fireAll();
          }
          clock.fireAll();

          const matches = (t: string) =>
            filterTypes.length === 0 || filterTypes.includes(t);
          const expectedSeqs: number[] = [];
          for (let i = k; i < ops.length; i++) {
            if (matches(ops[i].type)) expectedSeqs.push(i + 1);
          }

          const gotSeqs = received.map((e) => e.sequence);
          expect(gotSeqs).toEqual(expectedSeqs);
          expect(new Set(gotSeqs).size).toBe(gotSeqs.length);

          handle.dispose();
          expect(registry.size).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});

/** Binds a `SubscriptionRegistry` as the subscribe function that the follow carriers call. */
function registryFollowSubscribe(registry: SubscriptionRegistry): FollowSubscribe {
  return (filter, onEvent, options) => registry.subscribe(filter, onEvent, options);
}

/**
 * An `AbortSignal` that counts its live `abort` listeners. The count shows a teardown that does not remove its listener.
 * A fired abort removes a `{ once: true }` listener without a call to `removeEventListener`.
 * As a result, the probe is valid only on the paths where the abort never fires.
 */
function countingAbortSignal(): {
  signal: AbortSignal;
  liveAbortListeners: () => number;
} {
  const controller = new AbortController();
  let live = 0;
  const wrapper = {
    get aborted(): boolean {
      return controller.signal.aborted;
    },
    addEventListener(type: string, cb: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions | boolean): void {
      if (type === 'abort') live++;
      controller.signal.addEventListener(type, cb, opts);
    },
    removeEventListener(type: string, cb: EventListenerOrEventListenerObject, opts?: EventListenerOptions | boolean): void {
      if (type === 'abort') live--;
      controller.signal.removeEventListener(type, cb, opts);
    },
  };
  return { signal: wrapper as unknown as AbortSignal, liveAbortListeners: () => live };
}

/**
 * The CLI `AbortSignal` and the MCP task cancel must both reach the one `SubscriptionHandle.dispose()`.
 * The registry then returns to size 0. The dispatch that registers a subscription disposes it, and no daemon exists.
 * The tests drive the real follow carriers (`runInspectFollow`, `tasksFollow`) on a real `SubscriptionRegistry`.
 * Thus the leak assertion is `registry.size`. The injected `ManualClock` makes each run deterministic on every platform.
 */
describe('Subscription disposal lifecycle — AbortSignal + task-cancel (DR-1/DR-8)', () => {
  /**
   * CLI `inspect --follow` on a real registry. The CLI connects SIGINT to the `AbortController`.
   * The abort must reach `handle.dispose()` and empty the registry. A second `dispose()` after the abort is safe.
   */
  it('Follow_ConsumerDisconnect_HandleDisposedRegistryZero', () => {
    const log = new FakeLog();
    const clock = new ManualClock();
    const registry = new SubscriptionRegistry(log, { clock });
    const frames: Frame[] = [];
    const controller = new AbortController();

    const handle = runInspectFollow({
      subscribe: registryFollowSubscribe(registry),
      featureId: STREAM,
      fromSequence: 0,
      onFrame: (f) => frames.push(f),
      signal: controller.signal,
      clock,
    });
    expect(registry.size).toBe(1);
    expect(handle.disposed()).toBe(false);

    controller.abort();

    expect(handle.disposed()).toBe(true);
    expect(registry.size).toBe(0);
    expect(frames.at(-1)).toEqual({ type: 'end', reason: 'aborted' });

    handle.dispose();
    expect(registry.size).toBe(0);
  });

  /** A follow that ends through `dispose()`, with no abort, must leave no `abort` listener on a long-lived external signal. */
  it('Follow_DisposeBeforeAbort_AbortListenerRemovedNoSignalLeak', async () => {
    const log = new FakeLog();
    const clock = new ManualClock();
    const registry = new SubscriptionRegistry(log, { clock });
    const probe = countingAbortSignal();

    const handle = runInspectFollow({
      subscribe: registryFollowSubscribe(registry),
      featureId: STREAM,
      fromSequence: 0,
      onFrame: () => {},
      signal: probe.signal,
      clock,
    });
    expect(registry.size).toBe(1);
    expect(probe.liveAbortListeners()).toBe(1);

    handle.dispose();
    await handle.done;

    expect(handle.disposed()).toBe(true);
    expect(registry.size).toBe(0);
    expect(probe.liveAbortListeners()).toBe(0);
  });

  /**
   * The MCP Tasks path. The disposal entry point is `cancel()` on the carrier, with no POSIX signal.
   * An in-process commit arrives as an event frame before the cancel, so the cancel comes in the middle of a live tail.
   * A second `cancel()` is safe.
   */
  it('TasksCancel_MidFollow_HandleDisposed', () => {
    const log = new FakeLog();
    const clock = new ManualClock();
    const registry = new SubscriptionRegistry(log, { clock });
    const frames: Frame[] = [];

    const handle = tasksFollow({
      subscribe: registryFollowSubscribe(registry),
      featureId: STREAM,
      fromSequence: 0,
      onFrame: (f) => frames.push(f),
      clock,
    });
    expect(registry.size).toBe(1);

    log.commit(STREAM, T1);
    registry.wake(STREAM);
    const eventSeqs = frames
      .filter((f) => f.type === 'event')
      .map((f) => (f as { sequence: number }).sequence);
    expect(eventSeqs).toEqual([1]);

    handle.cancel();
    expect(handle.disposed()).toBe(true);
    expect(registry.size).toBe(0);
    expect(frames.at(-1)).toEqual({ type: 'end', reason: 'aborted' });

    handle.cancel();
    expect(registry.size).toBe(0);
  });

  /**
   * The carrier joins an external signal to its internal controller. The external signal never aborts in this test,
   * so `{ once: true }` does not remove the listener. The carrier must remove it when the follow ends, here through `cancel()`.
   */
  it('TasksFollow_EndsBeforeExternalAbort_ExternalListenerRemovedNoSignalLeak', async () => {
    const log = new FakeLog();
    const clock = new ManualClock();
    const registry = new SubscriptionRegistry(log, { clock });
    const probe = countingAbortSignal();

    const handle = tasksFollow({
      subscribe: registryFollowSubscribe(registry),
      featureId: STREAM,
      fromSequence: 0,
      onFrame: () => {},
      clock,
      signal: probe.signal,
    });
    expect(registry.size).toBe(1);
    expect(probe.liveAbortListeners()).toBe(1);

    handle.cancel();
    await handle.done;

    expect(handle.disposed()).toBe(true);
    expect(registry.size).toBe(0);
    expect(probe.liveAbortListeners()).toBe(0);
  });
});

/** Returns the registry that the store creates on the first subscribe, so a test can assert the leak state. */
function registryOf(store: EventStore): SubscriptionRegistry | undefined {
  return (store as unknown as { subscriptions?: SubscriptionRegistry }).subscriptions;
}

/** Yields to the macrotask queue until the registry of the store holds `n` live subscriptions. */
async function waitForRegistrySize(store: EventStore, n: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((registryOf(store)?.size ?? 0) === n) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`registry size never reached ${n} (was ${registryOf(store)?.size ?? 0})`);
}

/**
 * Each concurrent consumer on one stream owns an independent subscription.
 * A consumer that resolves or disposes does not settle or starve another, and each sees only its own matches.
 * The named case drives the real `handleViewWait`. The property covers N concurrent subscribe, dispose and append interleavings.
 */
describe('Concurrent waits on one stream resolve independently (DR-1/DR-8)', () => {
  /**
   * Two waits on one stream have different phase targets, and each registers its own subscription.
   * The injected deps use a manual floor clock and a deadline that never fires, so both waits resolve on Tier-1 wakes.
   * The first transition wakes both subscriptions and resolves only `w1`. `w2` stays pending until the second transition.
   * The registry returns to size 0 after both waits dispose their handles.
   */
  it('Wait_ConcurrentSameStream_BothResolveIndependently', async () => {
    const dir = makeTempDir('wait-concurrent-');
    const store = new EventStore(dir);
    await store.initialize();
    const ctx = { stateDir: dir, eventStore: store, enableTelemetry: false } as unknown as DispatchContext;
    const clock = new ManualClock();
    const deps: WaitDeps = {
      now: () => 1000,
      scheduleTimeout: () => () => {},
      subscriptionOptions: { clock },
    };
    const featureId = 'feat-concurrent';
    try {
      await store.append(featureId, {
        type: 'workflow.started',
        data: { featureId, workflowType: 'feature' },
      });

      const w1 = handleViewWait({ featureId, phase: 'plan-review', timeoutMs: 60_000 }, ctx, deps);
      const w2 = handleViewWait({ featureId, phase: 'delegate', timeoutMs: 60_000 }, ctx, deps);
      await waitForRegistrySize(store, 2);

      await store.append(featureId, {
        type: 'workflow.transition',
        data: { from: 'plan', to: 'plan-review', featureId },
      });
      const r1 = await w1;
      expect(r1.success).toBe(true);
      expect((r1.data as { phase?: string }).phase).toBe('plan-review');
      expect((r1.data as { perf?: { floorTicks: number } }).perf?.floorTicks).toBe(0);

      await waitForRegistrySize(store, 1);
      const PENDING = Symbol('pending');
      expect(await Promise.race([w2, Promise.resolve(PENDING)])).toBe(PENDING);

      await store.append(featureId, {
        type: 'workflow.transition',
        data: { from: 'plan-review', to: 'delegate', featureId },
      });
      const r2 = await w2;
      expect(r2.success).toBe(true);
      expect((r2.data as { phase?: string }).phase).toBe('delegate');

      await waitForRegistrySize(store, 0);
    } finally {
      store.close();
      rmrf(dir);
    }
  });

  /**
   * Property over any set of concurrent subscribers on one stream and any interleaving of own and foreign appends.
   * Each subscriber has its own filter and disposes before the op at index `disposeBefore`.
   * A tick follows each op, so each foreign commit flushes deterministically.
   * Each subscriber receives exactly its own matching events from its live period, one time each, in sequence order.
   * The registry returns to size 0 after all handles are disposed.
   */
  it('Registry_ConcurrentSubscribeDisposeAppendInterleavings_ConsistentAndScoped', () => {
    fc.assert(
      fc.property(
        fc.record({
          ops: fc.array(
            fc.record({ type: fc.constantFrom(T1, T2, T3), foreign: fc.boolean() }),
            { minLength: 0, maxLength: 16 },
          ),
          subs: fc.array(
            fc.record({ filterTypes: fc.subarray([T1, T2, T3]), disposeAt: fc.nat() }),
            { minLength: 1, maxLength: 5 },
          ),
        }),
        ({ ops, subs }) => {
          const log = new FakeLog();
          const clock = new ManualClock();
          const registry = new SubscriptionRegistry(log, { clock });
          const n = ops.length;

          const state = subs.map((s) => {
            const received: WorkflowEvent[] = [];
            const filter =
              s.filterTypes.length > 0
                ? { streamId: STREAM, eventTypes: s.filterTypes }
                : { streamId: STREAM };
            const handle = registry.subscribe(filter, (e) => received.push(e));
            return {
              s,
              received,
              handle,
              disposeBefore: s.disposeAt % (n + 1),
              disposed: false,
            };
          });
          expect(registry.size).toBe(subs.length);

          for (let i = 0; i < n; i++) {
            for (const st of state) {
              if (!st.disposed && st.disposeBefore === i) {
                st.handle.dispose();
                st.disposed = true;
              }
            }
            const op = ops[i];
            if (op.foreign) {
              log.commitForeign(STREAM, op.type);
            } else {
              log.commit(STREAM, op.type);
              registry.wake(STREAM);
            }
            clock.fireAll();
          }
          for (const st of state) {
            if (!st.disposed) {
              st.handle.dispose();
              st.disposed = true;
            }
          }
          expect(registry.size).toBe(0);

          for (const st of state) {
            const matches = (t: string) =>
              st.s.filterTypes.length === 0 || st.s.filterTypes.includes(t);
            const expected: number[] = [];
            for (let i = 0; i < st.disposeBefore; i++) {
              if (matches(ops[i].type)) expected.push(i + 1);
            }
            const got = st.received.map((e) => e.sequence);
            expect(got).toEqual(expected);
            expect(new Set(got).size).toBe(got.length);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

/** Reads the `busy_timeout` pragma of the connection that a `SqliteBackend` holds. */
function readBusyTimeout(backend: SqliteBackend): number {
  const db = (backend as unknown as { db: Database }).db;
  const rows = db.query('PRAGMA busy_timeout').all() as Array<Record<string, number>>;
  const row = rows[0];
  const value = row.timeout ?? row.busy_timeout ?? row[''];
  return typeof value === 'number' ? value : Number(value);
}

/**
 * The Tier-2 poll floor uses a real SQLite connection. On Windows, an open statement pins the handle.
 * The database then cannot close, and the file cannot be deleted.
 * The test asserts that the floor holds no open statement across ticks.
 * Both connections have `busy_timeout` 5000, which absorbs the contention between the two connections.
 */
describe('Tier-2 poll floor over real SQLite — Windows handle-close (DR-8/INV-16)', () => {
  /**
   * The reader has the shape that `EventStore.subscribe` wires in production, on the real SQLite connection of the observer.
   * Eight ticks each follow a foreign commit. A floor that keeps a statement open pins a read snapshot and hides new foreign rows.
   * Thus full delivery shows that no statement stays open across ticks.
   *
   * The test then closes both connections and removes the directory. `SqliteBackend.close()` does not throw on a failed close.
   * `rmrf` throws when a handle under the directory stays open, so it is the portable check for the Windows handle pin.
   */
  it('Floor_RealSqlite_NoOpenStatementAcrossTicks_ClosesCleanBusyTimeout', () => {
    const dir = makeTempDir('floor-win32-');
    const dbPath = join(dir, 'exarchos.db');
    const observer = new SqliteBackend(dbPath);
    const foreign = new SqliteBackend(dbPath);
    observer.initialize();
    foreign.initialize();
    const clock = new ManualClock();
    try {
      expect(readBusyTimeout(observer)).toBe(5000);
      expect(readBusyTimeout(foreign)).toBe(5000);

      const reader: SubscriptionEventReader = {
        headSequence: (s) => observer.getSequence(s),
        readStreamAfter: (s, after) => observer.queryEvents(s, { sinceSequence: after }),
        listStreams: () => observer.listStreams(),
        dataVersion: () => observer.dataVersion(),
      };
      const registry = new SubscriptionRegistry(reader, { clock });
      const received: number[] = [];
      const handle = registry.subscribe({ streamId: STREAM }, (e) => received.push(e.sequence));

      const TICKS = 8;
      for (let seq = 1; seq <= TICKS; seq++) {
        foreign.appendEvent(STREAM, makeEvent(STREAM, seq, T1));
        clock.fireAll();
      }
      expect(received).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

      handle.dispose();
      expect(registry.size).toBe(0);

      expect(() => observer.close()).not.toThrow();
      expect(() => foreign.close()).not.toThrow();
      expect(() => rmrf(dir)).not.toThrow();
    } catch (err) {
      observer.close();
      foreign.close();
      rmrf(dir);
      throw err;
    }
  });
});
