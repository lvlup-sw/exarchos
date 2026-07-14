import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';

import { EventStore } from './store.js';
import { AtomicAppender } from './atomic-appender.js';
import {
  SubscriptionRegistry,
  DEFAULT_FLOOR_MS,
  type SubscriptionClock,
  type SubscriptionEventReader,
} from './subscriptions.js';
import type { WorkflowEvent } from './schemas.js';
import { makeTempDir, rmrf } from '../test-helpers/temp-dir.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Injectable clock (INV-16) — deterministic, never reads wall time. */
const fixedClock: SubscriptionClock = { now: () => 0 };

/**
 * Hermetic in-memory event log implementing the registry's read seam. Owned
 * by the test (a fixture I own, per boundary discipline) so registry-logic
 * tests can drive precise interleavings — foreign appends without a wake,
 * varying registration points — without spinning real SQLite.
 */
class FakeLog implements SubscriptionEventReader {
  private readonly streams = new Map<string, WorkflowEvent[]>();
  private tick = 0;

  /** Append (no wake) and return the committed event. */
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

  headSequence(streamId: string): number {
    return this.streams.get(streamId)?.length ?? 0;
  }

  readStreamAfter(streamId: string, afterSequence: number): readonly WorkflowEvent[] {
    return (this.streams.get(streamId) ?? []).filter((e) => e.sequence > afterSequence);
  }

  listStreams(): readonly string[] {
    return [...this.streams.keys()];
  }
}

/** Call-counting decorator over a reader — pins the zero-subscriber guard. */
class SpyReader implements SubscriptionEventReader {
  headCalls = 0;
  readCalls = 0;
  listCalls = 0;
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
  get totalCalls(): number {
    return this.headCalls + this.readCalls + this.listCalls;
  }
}

const STREAM = 'feat-1';
const T1 = 'task.progressed';
const T2 = 'task.completed';
const T3 = 'workflow.transition';

// ─── Real-store integration suite (across the store/appender seam) ───────────

describe('EventStore.subscribe (DR-1 cursor-pump, Tier-1)', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(async () => {
    dir = makeTempDir('subscriptions-');
    store = new EventStore(dir);
    await store.initialize();
  });

  afterEach(() => {
    // Close SQLite handles before temp-dir removal (INV-16 / Windows).
    store.close();
    rmrf(dir);
  });

  it('Subscribe_InProcessAppend_CursorDrainDeliversPostCommitInOrder', async () => {
    const received: WorkflowEvent[] = [];
    const handle = store.subscribe({ streamId: STREAM }, (e) => received.push(e));

    await store.append(STREAM, { type: T1, data: {} });
    await store.append(STREAM, { type: T2, data: {} });
    await store.append(STREAM, { type: T3, data: {} });

    // Delivered synchronously post-commit (each carries its committed
    // sequence), in ascending global sequence order.
    expect(received.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(received.map((e) => e.type)).toEqual([T1, T2, T3]);
    handle.dispose();
  });

  it('Subscribe_ForeignThenOwnCommit_DeliversInGlobalSequenceOrder', async () => {
    // A second EventStore on the same stateDir models a foreign connection:
    // its commit does NOT wake this store's registry (Tier-1 is in-process),
    // so the own commit's wake must drain the undrained foreign event first.
    const foreign = new EventStore(dir);
    await foreign.initialize();
    try {
      const received: WorkflowEvent[] = [];
      const handle = store.subscribe({ streamId: STREAM }, (e) => received.push(e));

      await foreign.append(STREAM, { type: T1, data: {} }); // seq 1 — no wake here
      await store.append(STREAM, { type: T2, data: {} }); // seq 2 — wake → drain [1,2]

      expect(received.map((e) => e.sequence)).toEqual([1, 2]);
      handle.dispose();
    } finally {
      foreign.close();
    }
  });

  it('Subscribe_ListenerThrows_AppendUnaffectedSiblingsAndLaterEventsDelivered', async () => {
    const good: number[] = [];
    const bad: number[] = [];
    const hGood = store.subscribe({ streamId: STREAM }, (e) => good.push(e.sequence));
    const hBad = store.subscribe({ streamId: STREAM }, (e) => {
      bad.push(e.sequence);
      if (e.sequence === 1) throw new Error('listener boom on N+1');
    });

    // One transaction, three events → one wake → one batch drain. The throw
    // on seq 1 must not drop seq 2/3 from the SAME (throwing) subscription,
    // must not affect the sibling, and must not reach the append result.
    const result = await store.batchAppend(STREAM, [
      { type: T1, data: {} },
      { type: T2, data: {} },
      { type: T3, data: {} },
    ]);

    expect(result.map((e) => e.sequence)).toEqual([1, 2, 3]); // append unaffected
    expect(good).toEqual([1, 2, 3]); // sibling unaffected
    expect(bad).toEqual([1, 2, 3]); // later events still delivered despite throw

    // A subsequent append still commits and delivers — the throw did not
    // poison the append path.
    const after = await store.append(STREAM, { type: T1, data: {} });
    expect(after.sequence).toBe(4);
    expect(good).toEqual([1, 2, 3, 4]);
    hGood.dispose();
    hBad.dispose();
  });

  it('Subscribe_ListenerAppendsSameStream_NoDeadlockDeliveredNextDrain', async () => {
    const received: string[] = [];
    const nested: Array<Promise<unknown>> = [];
    let reentered = false;
    const handle = store.subscribe({ streamId: STREAM }, (e) => {
      received.push(e.type);
      if (e.type === T1 && !reentered) {
        reentered = true;
        // Re-enter the append path from inside delivery. The Tier-1 hook
        // fires AFTER the per-stream mutex releases, so this must NOT
        // deadlock the non-reentrant per-stream lock.
        nested.push(store.append(STREAM, { type: T2, data: {} }));
      }
    });

    await store.append(STREAM, { type: T1, data: {} }); // delivers T1 → triggers nested append
    await Promise.all(nested); // nested append commits → its wake delivers T2

    expect(received).toEqual([T1, T2]);
    handle.dispose();
  });

  it('Subscribe_IdempotencyCacheHit_NoWakeNoRedelivery', async () => {
    // Store-level: a cache-hit re-append delivers nothing new.
    const received: WorkflowEvent[] = [];
    const handle = store.subscribe({ streamId: STREAM }, (e) => received.push(e));
    const key = 'idem-key-1';
    await store.append(STREAM, { type: T1, data: {} }, { idempotencyKey: key });
    expect(received).toHaveLength(1);
    await store.append(STREAM, { type: T1, data: {} }, { idempotencyKey: key }); // INV-8 cache-hit
    expect(received).toHaveLength(1);
    handle.dispose();

    // Appender-level: the hook fires for the fresh commit but NOT for the
    // cache-hit (proves "no wake", independent of the cursor no-redelivery).
    const wakes: string[] = [];
    const appenderDir = makeTempDir('appender-');
    const appender = new AtomicAppender({ stateDir: appenderDir });
    appender.setCommitHook((s) => wakes.push(s));
    try {
      const first = await appender.append('s', [{ type: T1 }], 'k1');
      const second = await appender.append('s', [{ type: T1 }], 'k1');
      expect(first.ok && first.kind).toBe('committed');
      expect(second.ok && second.kind).toBe('cache-hit');
      expect(wakes).toEqual(['s']); // exactly one wake — cache-hit did not fire
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

  it('Subscribe_FromSequence_SkipsBaselineDeliversAfterCursor', async () => {
    await store.append(STREAM, { type: T1, data: {} }); // seq 1 (baseline)
    await store.append(STREAM, { type: T1, data: {} }); // seq 2 (baseline)
    const received: number[] = [];
    // Cursor pinned at 2 → only seq > 2 delivered.
    const handle = store.subscribe({ streamId: STREAM }, (e) => received.push(e.sequence), {
      fromSequence: 2,
    });
    expect(received).toEqual([]); // initial drain: nothing after cursor 2
    await store.append(STREAM, { type: T1, data: {} }); // seq 3
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
    await store.append(STREAM, { type: T1, data: {} }); // after disposal — no delivery
    expect(received).toEqual([1]);
  });

  it('Append_CharacterizationBaseline_UnchangedWithHook', async () => {
    // Pins append semantics with NO subscriber (hook never wired): a fresh
    // commit returns the sequence; an idempotent retry returns the cached
    // shape (same sequence); the stream holds exactly one event. Adding the
    // Tier-1 hook must not perturb this.
    const key = 'char-key';
    const first = await store.append(STREAM, { type: T1, data: {} }, { idempotencyKey: key });
    const retry = await store.append(STREAM, { type: T1, data: {} }, { idempotencyKey: key });
    expect(first.sequence).toBe(1);
    expect(retry.sequence).toBe(first.sequence);
    const all = await store.query(STREAM);
    expect(all).toHaveLength(1);
  });
});

// ─── Registry-level suite (INV-15 leak, zero-subscriber guard, property) ─────

describe('SubscriptionRegistry (DR-1 invariants)', () => {
  it('Subscribe_DispatchReturns_HandleDisposedRegistryZero', () => {
    const log = new FakeLog();
    const registry = new SubscriptionRegistry(log, { clock: fixedClock });
    const handles = [
      registry.subscribe({ streamId: STREAM }, () => {}),
      registry.subscribe({ streamId: STREAM }, () => {}),
      registry.subscribe({ eventTypes: [T1] }, () => {}),
    ];
    expect(registry.size).toBe(3);

    // Dispatch returns → dispose all handles (INV-15).
    for (const h of handles) h.dispose();
    expect(handles.every((h) => h.disposed)).toBe(true);
    expect(registry.size).toBe(0);

    // Idempotent + disposeAll safe on an already-empty registry.
    handles[0].dispose();
    registry.disposeAll();
    expect(registry.size).toBe(0);
  });

  it('Append_ZeroSubscribers_GuardCheckOnly', () => {
    const spy = new SpyReader(new FakeLog());
    const registry = new SubscriptionRegistry(spy, { clock: fixedClock });
    expect(registry.size).toBe(0);

    // Zero subscribers: a wake does no listener-related work beyond the size
    // guard — the reader is never touched.
    registry.wake(STREAM);
    expect(spy.totalCalls).toBe(0);

    // Contrast: with one subscriber, a wake DOES drain (guard is live, not
    // dead code).
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

  it('Subscribe_RegistrationConcurrentWithAppends_InitialDrainNoLoss', () => {
    // Property: for arbitrary append sequences, an arbitrary registration
    // point among them, and an arbitrary type filter, the subscriber receives
    // EXACTLY its matching events committed after its registration cursor —
    // exactly once, in global (ascending-sequence) order. Pre-registration
    // events are never delivered; post-registration matches are never lost.
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
          const k = regNat % (types.length + 1); // registration point in [0, n]

          // Appends BEFORE registration: committed, but no wake reaches a
          // subscription that does not yet exist.
          for (let i = 0; i < k; i++) log.commit(STREAM, types[i]);

          const received: WorkflowEvent[] = [];
          const filter =
            filterTypes.length > 0
              ? { streamId: STREAM, eventTypes: filterTypes }
              : { streamId: STREAM };
          const handle = registry.subscribe(filter, (e) => received.push(e));

          // Appends AFTER registration: each commit is followed by its
          // Tier-1 wake.
          for (let i = k; i < types.length; i++) {
            log.commit(STREAM, types[i]);
            registry.wake(STREAM);
          }

          const matches = (t: string) => filterTypes.length === 0 || filterTypes.includes(t);
          const expectedSeqs: number[] = [];
          for (let i = k; i < types.length; i++) {
            if (matches(types[i])) expectedSeqs.push(i + 1); // seq is 1-based index
          }

          const gotSeqs = received.map((e) => e.sequence);
          expect(gotSeqs).toEqual(expectedSeqs); // exact set, in order, no loss
          expect(new Set(gotSeqs).size).toBe(gotSeqs.length); // exactly once

          handle.dispose();
          expect(registry.size).toBe(0);
        },
      ),
      { numRuns: 250 },
    );
  });

  it('cross-stream subscription delivers new-stream events post-registration', () => {
    // A stream that did not exist at registration starts at cursor 0, so all
    // its events are (correctly) post-registration and delivered exactly once.
    const log = new FakeLog();
    log.commit('other', T1); // pre-existing on a different stream — baseline
    const registry = new SubscriptionRegistry(log, { clock: fixedClock });
    const received: string[] = [];
    const handle = registry.subscribe({}, (e) => received.push(`${e.streamId}#${e.sequence}`));

    // 'other' was at head 1 at registration → its seq-1 is baseline, not
    // delivered; a new event on it IS.
    log.commit('other', T2);
    registry.wake('other');
    // A brand-new stream: every event delivered.
    log.commit('fresh', T1);
    registry.wake('fresh');

    expect(received).toEqual(['other#2', 'fresh#1']);
    handle.dispose();
  });
});
