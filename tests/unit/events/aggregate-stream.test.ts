import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import { EventStore } from '../../../src/events/store.js';
import {
  createRegistry,
  type ProjectionRegistry,
} from '../../../src/projections/registry.js';
import { makeFixtureReducer, seedStream, type FixtureState } from '../../helpers/decide-fixtures.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * `aggregateStream<T>(streamId, reducerId)` folds a stream through a registered reducer and
 * writes nothing. It makes one `queryEvents` SELECT, so the fold reads one WAL snapshot.
 *
 * `aggregateStream` has no runtime check for a global-scoped reducer.
 * `ProjectionScope_ReducerAuthoredGlobal_FailsTypecheck` in `projections/types.test.ts` pins the
 * compile-time check, and the `scope` description in `projections/types.ts` gives the reason.
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
});
