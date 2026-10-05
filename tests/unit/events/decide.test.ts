/**
 * Tests for `decide`: load, fold, decide, and append as one operation, with an optimistic
 * concurrency check on the stream tail. The consistency boundary is one stream.
 * The design follows the `FetchForWriting<T>(streamId)` semantics of Marten.
 */

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
} from '../../helpers/decide-fixtures.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

describe('decide<TState> — happy-path round-trip (Task 3.3)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let appender: AtomicAppender;
  let registry: ProjectionRegistry;
  const streamId = 'feature/decide-happy';

  /** The suite uses the appender of the `EventStore`, so reads and writes share one `SqliteBackend` handle. */
  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'decide-test-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
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

    await seedStream(eventStore, streamId, 2);

    const result = await appender.decide<FixtureState>(
      streamId,
      'fixture@v1',
      (state, ctx) => {
        expect(state.count).toBe(2);
        expect(state.latest).toBe('T-2');
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

    expect(observedNow).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

/**
 * `ProjectionScope` is the single literal `'stream'`, so a reducer with another scope does not
 * compile. `ProjectionScope_ReducerAuthoredGlobal_FailsTypecheck` in `projections/types.test.ts`
 * pins that rule, so this suite holds no runtime scope case.
 */
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

  /**
   * The case replaces `appendComputed` with a fake that returns `storage_busy`, so only the
   * translation branch runs. `attempts` is the retry budget that the appender reports, which is 5.
   */
  it('Decide_ThrowsStorageBusyError_WhenSubstrateRetryBudgetExhausts', async () => {
    await seedStream(eventStore, streamId, 1);

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

  /**
   * The closure writes through a second appender on the same backend. That write lands between
   * the fold and the tail check of an empty decision. The closure returns no events, so `decide`
   * reads the tail again and throws. The second call repeats the race to read the error fields.
   */
  it('Decide_TriggersOccCheck_WhenDecideReturnsEmptyEventsByDefault', async () => {
    await seedStream(eventStore, streamId, 3);

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
          return [];
        },
        { registry },
      ),
    ).rejects.toBeInstanceOf(ConcurrencyError);

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

  /** The closure moves the tail and returns no events. With `alwaysEnforceConsistency: false`, the call still succeeds. */
  it('Decide_SkipsOccCheck_WhenAlwaysEnforceConsistencyFalse', async () => {
    await seedStream(eventStore, streamId, 1);

    const backend = appender.ensureSqliteBackendSync();
    const sideAppender = new AtomicAppender({
      stateDir,
      sqliteBackend: backend,
    });

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

  /** The default tail check runs, and the tail did not move. */
  it('Decide_NoOpSuccess_WhenEmptyEventsAndNoExternalAdvance', async () => {
    await seedStream(eventStore, streamId, 1);

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

  /**
   * A retry with the same `operationId` returns the stored sequences and commits no new event.
   * The claim row holds all three events under the one derived key.
   * Each `decide` call invokes `appendComputed` once, so the spy counts two calls.
   * The idempotency hit occurs inside `appendComputed`, not in `decide`.
   */
  it('Decide_DeducesEventsAcrossRetries_WhenOperationIdSupplied', async () => {
    await seedStream(eventStore, streamId, 1);
    const tailAtFetch = 1;

    const threeEvents = [
      { type: 'task.assigned', data: { taskId: 'T-a' } },
      { type: 'task.assigned', data: { taskId: 'T-b' } },
      { type: 'task.completed', data: { taskId: 'T-b' } },
    ];

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

      const events = await eventStore.query(streamId);
      expect(events).toHaveLength(4);

      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      appender.appendComputed = original;
    }
  });

  /**
   * With no `operationId`, each call derives a key with a UUID suffix.
   * So two calls in sequence do not share a claim, and each commits its event.
   */
  it('Decide_DerivesUniqueKey_WhenOperationIdOmitted', async () => {
    await seedStream(eventStore, streamId, 0);

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
