import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import { EventStore } from '../../../src/events/store.js';
import { ConcurrencyError } from '../../../src/events/concurrency-error.js';
import { StorageBusyError } from '../../../src/events/storage-busy-error.js';
import {
  createRegistry,
  type ProjectionRegistry,
} from '../../../src/projections/registry.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import {
  makeFixtureReducer,
  seedStream,
  type FixtureState,
} from '../../../src/events/decide-fixtures.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * Wave 3 Tasks 3.3 – 3.7 — `decide<TState>` primitive (R-2).
 *
 * The primitive's purpose: make load → fold → decide → append one
 * transactional operation with OCC baked in. Mirrors Marten's
 * `FetchForWriting<T>(streamId)` semantics on a per-stream consistency
 * boundary.
 */

describe('decide<TState> — happy-path round-trip (Task 3.3)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let appender: AtomicAppender;
  let registry: ProjectionRegistry;
  const streamId = 'feature/decide-happy';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'decide-test-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    // Reuse the EventStore's underlying appender so reads + writes share
    // one SqliteBackend handle (matches how the production wiring threads
    // the singleton appender).
    appender = eventStore.getAppender() as AtomicAppender;
    registry = createRegistry();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('Decide_CommitsEventsReturnedByDecideFunction', async () => {
    const reducer = makeFixtureReducer('fixture@v1', 'stream');
    registry.register(
      reducer as unknown as Parameters<typeof registry.register>[0],
    );

    // Seed stream with 2 events (sequences 1, 2).
    await seedStream(eventStore, streamId, 2);

    // Decide returns ONE event.
    const result = await appender.decide<FixtureState>(
      streamId,
      'fixture@v1',
      (state, ctx) => {
        // The reducer fold consumed both seed events.
        expect(state.count).toBe(2);
        expect(state.latest).toBe('T-2');
        // ctx reflects the tail at fetch-time.
        expect(ctx.streamId).toBe(streamId);
        expect(ctx.version).toBe(2);
        expect(typeof ctx.now()).toBe('string');
        return [{ type: 'task.completed', data: { taskId: 'T-2' } }];
      },
      { registry },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('committed');
    expect(result.sequences).toEqual([3]);

    // Tail is now at 3; the appended event is observable via query.
    const events = await eventStore.query(streamId);
    expect(events).toHaveLength(3);
    expect(events[2].type).toBe('task.completed');
    expect(events[2].sequence).toBe(3);
  });

  it('Decide_PassesNowFunctionForDeterministicTimestamps', async () => {
    const reducer = makeFixtureReducer('fixture@v1', 'stream');
    registry.register(
      reducer as unknown as Parameters<typeof registry.register>[0],
    );

    let observedNow: string | undefined;
    await appender.decide<FixtureState>(
      streamId,
      'fixture@v1',
      (_state, ctx) => {
        observedNow = ctx.now();
        return [];
      },
      { registry, alwaysEnforceConsistency: false },
    );

    // The now() function returns an ISO-8601 string at fetch time.
    expect(observedNow).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('decide<TState> — scope discipline (Task 3.4)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let appender: AtomicAppender;
  let registry: ProjectionRegistry;
  const streamId = 'feature/decide-scope';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'decide-scope-test-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    appender = eventStore.getAppender() as AtomicAppender;
    registry = createRegistry();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  // `Decide_RejectsGlobalScopedReducer_WithInvalidReducerScope` was removed
  // when `ProjectionScope` collapsed to the single literal `'stream'`. Its
  // subject — a registered reducer whose scope is not `'stream'` — is no
  // longer representable, so the test could only have been kept by casting a
  // fabricated value past the type system, which would assert on the cast
  // rather than on any reachable state. The invariant it guarded is now
  // enforced by the compiler; see `projections/types.test.ts`
  // (`ProjectionScope_ReducerAuthoredGlobal_FailsTypecheck`).

  it('Decide_ThrowsUnknownProjection_WhenReducerNotRegistered', async () => {
    await expect(
      appender.decide<FixtureState>(
        streamId,
        'no-such-reducer@v1',
        () => [],
        { registry },
      ),
    ).rejects.toThrow(/no-such-reducer@v1/);
  });
});

describe('decide<TState> — storage_busy translation (Task 3.5a)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let appender: AtomicAppender;
  let registry: ProjectionRegistry;
  const streamId = 'feature/decide-storage-busy';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'decide-busy-test-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    appender = eventStore.getAppender() as AtomicAppender;
    registry = createRegistry();
    registry.register(
      makeFixtureReducer('fixture@v1', 'stream') as unknown as Parameters<
        typeof registry.register
      >[0],
    );
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('Decide_ThrowsStorageBusyError_WhenSubstrateRetryBudgetExhausts', async () => {
    // Seed one event so the fold has something to work with.
    await seedStream(eventStore, streamId, 1);

    // Inject a substrate fault by patching appendComputed on the
    // appender to force a storage_busy AppendResult. This is the
    // smallest fault-injection surface that exercises the translation
    // branch in isolation, mirroring the pattern documented in
    // atomic-appender.ts near the public test-fault-injection seam.
    const cause = new Error('SQLITE_BUSY');
    const original = appender.appendComputed.bind(appender);
    appender.appendComputed = vi.fn(async () => ({
      ok: false,
      reason: 'storage_busy' as const,
      cause,
    }));

    try {
      await appender.decide<FixtureState>(
        streamId,
        'fixture@v1',
        () => [{ type: 'task.completed', data: { taskId: 'T-1' } }],
        { registry },
      );
      expect.fail('decide should have thrown StorageBusyError');
    } catch (err) {
      expect(err).toBeInstanceOf(StorageBusyError);
      const sbe = err as StorageBusyError;
      expect(sbe.streamId).toBe(streamId);
      // Attempts default to SQLITE_BUSY_RETRY_POLICY.maxAttempts (5).
      expect(sbe.attempts).toBe(5);
      expect(sbe.cause).toBe(cause);
    } finally {
      appender.appendComputed = original;
    }
  });
});

describe('decide<TState> — empty events + alwaysEnforceConsistency (Task 3.6)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let appender: AtomicAppender;
  let registry: ProjectionRegistry;
  const streamId = 'feature/decide-empty-occ';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'decide-empty-test-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    appender = eventStore.getAppender() as AtomicAppender;
    registry = createRegistry();
    registry.register(
      makeFixtureReducer('fixture@v1', 'stream') as unknown as Parameters<
        typeof registry.register
      >[0],
    );
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('Decide_TriggersOccCheck_WhenDecideReturnsEmptyEventsByDefault', async () => {
    // Stream at version 3 before decide runs.
    await seedStream(eventStore, streamId, 3);

    // External-write injection between fold and the empty-events
    // re-check: run inside the closure, routed via a SEPARATE appender
    // sharing the backend so we don't deadlock on the per-stream mutex.
    const backend = appender.ensureSqliteBackendSync();
    const sideAppender = new AtomicAppender({
      stateDir,
      sqliteBackend: backend,
    });

    let advanced = false;
    await expect(
      appender.decide<FixtureState>(
        streamId,
        'fixture@v1',
        async () => {
          if (!advanced) {
            advanced = true;
            const r = await sideAppender.appendUnkeyed(streamId, [
              { type: 'task.assigned', data: { taskId: 'T-ext' } },
            ]);
            expect(r.ok).toBe(true);
          }
          // Return empty so the OCC re-check fires.
          return [];
        },
        { registry },
      ),
    ).rejects.toBeInstanceOf(ConcurrencyError);

    // Re-issue for field inspection.
    try {
      let injected = false;
      await appender.decide<FixtureState>(
        streamId,
        'fixture@v1',
        async () => {
          if (!injected) {
            injected = true;
            await sideAppender.appendUnkeyed(streamId, [
              { type: 'task.assigned', data: { taskId: 'T-ext-2' } },
            ]);
          }
          return [];
        },
        { registry },
      );
      expect.fail('decide should have re-thrown ConcurrencyError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConcurrencyError);
      const ce = err as ConcurrencyError;
      expect(ce.expectedVersion).toBeLessThan(ce.actualVersion);
    }
  });

  it('Decide_SkipsOccCheck_WhenAlwaysEnforceConsistencyFalse', async () => {
    await seedStream(eventStore, streamId, 1);

    const backend = appender.ensureSqliteBackendSync();
    const sideAppender = new AtomicAppender({
      stateDir,
      sqliteBackend: backend,
    });

    // Empty events + alwaysEnforceConsistency:false — success even
    // though the tail moved.
    const result = await appender.decide<FixtureState>(
      streamId,
      'fixture@v1',
      async () => {
        await sideAppender.appendUnkeyed(streamId, [
          { type: 'task.assigned', data: { taskId: 'T-ext' } },
        ]);
        return [];
      },
      { registry, alwaysEnforceConsistency: false },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('no-op');
  });

  it('Decide_NoOpSuccess_WhenEmptyEventsAndNoExternalAdvance', async () => {
    await seedStream(eventStore, streamId, 1);

    // Default alwaysEnforceConsistency=true — but no advance during fold.
    const result = await appender.decide<FixtureState>(
      streamId,
      'fixture@v1',
      () => [],
      { registry },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('no-op');
    expect(result.sequences).toEqual([]);
  });
});

describe('decide<TState> — single-key-per-call idempotency (Task 3.7)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let appender: AtomicAppender;
  let registry: ProjectionRegistry;
  const streamId = 'feature/decide-idem';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'decide-idem-test-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    appender = eventStore.getAppender() as AtomicAppender;
    registry = createRegistry();
    registry.register(
      makeFixtureReducer('fixture@v1', 'stream') as unknown as Parameters<
        typeof registry.register
      >[0],
    );
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('Decide_DeducesEventsAcrossRetries_WhenOperationIdSupplied', async () => {
    await seedStream(eventStore, streamId, 1);
    const tailAtFetch = 1;

    const threeEvents = [
      { type: 'task.assigned', data: { taskId: 'T-a' } },
      { type: 'task.assigned', data: { taskId: 'T-b' } },
      { type: 'task.completed', data: { taskId: 'T-b' } },
    ];

    // Spy on appendComputed to count invocations. Audit §F1.3: exactly
    // ONE invocation per call (one transaction, N events). The cache
    // hit for the retry surfaces inside appendComputed itself, but the
    // call still happens (the cache short-circuit is downstream of
    // appendComputed's outer invocation in the current architecture).
    const original = appender.appendComputed.bind(appender);
    const spy = vi.fn(original);
    appender.appendComputed = spy;

    try {
      const first = await appender.decide<FixtureState>(
        streamId,
        'fixture@v1',
        () => threeEvents,
        { registry, operationId: 'op-1' },
      );
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.sequences).toEqual([
        tailAtFetch + 1,
        tailAtFetch + 2,
        tailAtFetch + 3,
      ]);

      // Second call with same operationId: short-circuits to a cache
      // hit; no additional events committed.
      const second = await appender.decide<FixtureState>(
        streamId,
        'fixture@v1',
        () => threeEvents,
        { registry, operationId: 'op-1' },
      );
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.sequences).toEqual([
        tailAtFetch + 1,
        tailAtFetch + 2,
        tailAtFetch + 3,
      ]);

      // The substrate's idempotency_claims row carries the multi-event
      // payload under the single derived key.
      const backend = appender.getSqliteBackend();
      if (!backend) throw new Error('backend missing');
      const claim = backend.lookupIdempotencyClaim(
        streamId,
        `${streamId}:fixture@v1:op-1`,
      );
      expect(claim).toBeDefined();
      if (!claim) return;
      expect(claim.eventIds.length).toBe(3);
      expect(claim.sequences.length).toBe(3);
      expect(claim.timestamps.length).toBe(3);

      // Stream tail advanced by exactly the original 3-event commit.
      const events = await eventStore.query(streamId);
      // 1 seed + 3 decide events = 4.
      expect(events).toHaveLength(4);

      // Audit §F1.3: single-call-single-transaction. The spy records
      // ONE outer appendComputed invocation per decide call (the cache
      // short-circuit lives inside appendComputed's body, not at the
      // decide layer). The KEY invariant is the idempotency_claims row
      // shape above — N events under one key.
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      appender.appendComputed = original;
    }
  });

  it('Decide_DerivesUniqueKey_WhenOperationIdOmitted', async () => {
    await seedStream(eventStore, streamId, 0);

    // Without operationId, decide derives a UUID-suffixed key per call
    // (decide:${streamId}:${reducerId}:${uuid}). Two consecutive calls
    // produce two distinct claims and two distinct sequence commits.
    const r1 = await appender.decide<FixtureState>(
      streamId,
      'fixture@v1',
      () => [{ type: 'task.assigned', data: { taskId: 'T-1' } }],
      { registry },
    );
    const r2 = await appender.decide<FixtureState>(
      streamId,
      'fixture@v1',
      () => [{ type: 'task.assigned', data: { taskId: 'T-2' } }],
      { registry },
    );
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.sequences).toEqual([1]);
    expect(r2.sequences).toEqual([2]);
  });
});
