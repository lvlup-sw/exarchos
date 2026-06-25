import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from './atomic-appender.js';
import { EventStore } from './store.js';
import { InvalidReducerScopeError } from '../projections/store.js';
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

  it('AggregateStream_RejectsGlobalScopedReducer', async () => {
    const globalReducer = makeFixtureReducer('fixture-global@v1', 'global');
    registry.register(
      globalReducer as unknown as Parameters<typeof registry.register>[0],
    );

    await expect(
      appender.aggregateStream<FixtureState>(
        streamId,
        'fixture-global@v1',
        { registry },
      ),
    ).rejects.toBeInstanceOf(InvalidReducerScopeError);

    try {
      await appender.aggregateStream<FixtureState>(
        streamId,
        'fixture-global@v1',
        { registry },
      );
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidReducerScopeError);
      const e = err as InvalidReducerScopeError;
      expect(e.expectedShape.scope).toBe('stream');
      expect(e.actualScope).toBe('global');
    }
  });
});
