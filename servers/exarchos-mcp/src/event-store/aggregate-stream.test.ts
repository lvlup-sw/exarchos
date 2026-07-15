import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from './atomic-appender.js';
import { EventStore } from './store.js';
import {
  createRegistry,
  type ProjectionRegistry,
} from '../projections/registry.js';
import { makeFixtureReducer, seedStream, type FixtureState } from './decide-fixtures.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

/**
 * Wave 3 Tasks 3.11 + 3.12 — `aggregateStream<T>(streamId, reducerId)`
 * read-only fold primitive (R-2). Marten's `AggregateStreamAsync` analog.
 *
 * No write path; no OCC enforcement on a future commit. Single SELECT
 * via the substrate's `queryEvents(streamId)` — one WAL snapshot, safe
 * per audit §F2.3 (single-read invariant). The inline forward-discipline
 * note in atomic-appender.ts mandates that any future addition of a
 * SECOND read inside aggregateStream MUST wrap both reads in
 * `db.transaction(fn)`.
 */
describe('aggregateStream<T> — read-only fold (Tasks 3.11 + 3.12)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let appender: AtomicAppender;
  let registry: ProjectionRegistry;
  const streamId = 'feature/aggregate-stream';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'aggregate-stream-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    appender = eventStore.getAppender() as AtomicAppender;
    registry = createRegistry();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('AggregateStream_ReturnsFoldedStateAndTailVersion', async () => {
    registry.register(
      makeFixtureReducer('fixture@v1', 'stream') as unknown as Parameters<
        typeof registry.register
      >[0],
    );

    await seedStream(eventStore, streamId, 3);

    const result = await appender.aggregateStream<FixtureState>(
      streamId,
      'fixture@v1',
      { registry },
    );

    expect(result.version).toBe(3);
    expect(result.aggregate.count).toBe(3);
    expect(result.aggregate.latest).toBe('T-3');
  });

  it('AggregateStream_ReturnsInitialStateAndZeroVersion_OnEmptyStream', async () => {
    registry.register(
      makeFixtureReducer('fixture@v1', 'stream') as unknown as Parameters<
        typeof registry.register
      >[0],
    );

    const result = await appender.aggregateStream<FixtureState>(
      streamId,
      'fixture@v1',
      { registry },
    );

    expect(result.version).toBe(0);
    expect(result.aggregate.count).toBe(0);
    expect(result.aggregate.latest).toBeUndefined();
  });

  // ─── Task 3.12 — scope validation ─────────────────────────────────────
  //
  // `AggregateStream_RejectsGlobalScopedReducer` was removed when
  // `ProjectionScope` collapsed to the single literal `'stream'`. It asserted
  // that `aggregateStream` throws `INVALID_REDUCER_SCOPE` on a global-scoped
  // reducer; that guard no longer exists, so there is nothing left to assert.
  //
  // It was NOT removed for want of a subject: this is a `.test.ts`, excluded
  // from the tsconfig program, so a `scope: 'global'` fixture is authorable
  // here with no cast at all. The test could have been kept verbatim. It is
  // gone because the behaviour it pinned is gone, and because that behaviour
  // was never what made a wrong scope harmless — `aggregateStream` reads one
  // `streamId`, so a wrongly-scoped reducer folds one stream regardless. The
  // cross-stream fold died with `readProjection`, not with the scope stamp.
  //
  // What survives: `projections/types.test.ts`
  // (`ProjectionScope_ReducerAuthoredGlobal_FailsTypecheck`) pins that the
  // scope is unauthorable in TYPECHECKED code — a narrower guarantee than
  // this test's, and deliberately so. See `atomic-appender.ts`'s
  // `resolveStreamReducer` for the full reasoning.
});
