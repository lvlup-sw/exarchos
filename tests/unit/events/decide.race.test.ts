import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import { EventStore } from '../../../src/events/store.js';
import { ConcurrencyError } from '../../../src/events/concurrency-error.js';
import {
  createRegistry,
  type ProjectionRegistry,
} from '../../../src/projections/registry.js';
import {
  makeFixtureReducer,
  seedStream,
  type FixtureState,
} from '../../helpers/decide-fixtures.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * `decide` turns the `sequence-conflict` result of the appender into a {@link ConcurrencyError}
 * when the stream tail advances between the fold and the commit.
 *
 * A `decide` call folds the stream and then waits in its closure. A second appender on the same
 * `SqliteBackend` advances the tail. The `decide` call then commits against a stale tail and throws.
 */
describe('decide<TState> — race / OCC (Task 3.5)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let appender: AtomicAppender;
  let registry: ProjectionRegistry;
  const streamId = 'feature/decide-race';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'decide-race-'));
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
   * The per-stream mutex belongs to one appender. So a second appender on the same backend can
   * write while the `decide` closure waits on a gate. The closure runs after the fold and the
   * tail read. The side write moves the tail from 2 to 3, and the commit still expects 2.
   * The case runs the race again with an `operationId`, to read the fields of the error.
   * A lost race has an `expectedVersion` less than the `actualVersion`.
   */
  it('Decide_ThrowsConcurrencyError_WhenStreamTailAdvancedDuringDecide', async () => {
    await seedStream(eventStore, streamId, 2);

    const backend = appender.ensureSqliteBackendSync();
    const sideAppender = new AtomicAppender({
      stateDir,
      sqliteBackend: backend,
    });

    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    const decideAPromise = appender.decide<FixtureState>(
      streamId,
      'fixture@v1',
      async () => {
        await gate;
        return [{ type: 'task.completed', data: { taskId: 'A-decision' } }];
      },
      { registry },
    );

    await Promise.resolve();

    const sideResult = await sideAppender.appendUnkeyed(streamId, [
      { type: 'task.assigned', data: { taskId: 'T-external' } },
    ]);
    expect(sideResult.ok).toBe(true);

    release();

    await expect(decideAPromise).rejects.toBeInstanceOf(ConcurrencyError);

    try {
      let r2!: () => void;
      const g2 = new Promise<void>(resolve => {
        r2 = resolve;
      });
      const p2 = appender.decide<FixtureState>(
        streamId,
        'fixture@v1',
        async () => {
          await g2;
          return [{ type: 'task.completed', data: { taskId: 'B-decision' } }];
        },
        { registry, operationId: 'inspect-op' },
      );
      await Promise.resolve();
      await sideAppender.appendUnkeyed(streamId, [
        { type: 'task.assigned', data: { taskId: 'T-ext-2' } },
      ]);
      r2();
      await p2;
      expect.fail('decide should have thrown a second ConcurrencyError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConcurrencyError);
      const ce = err as ConcurrencyError;
      expect(ce.streamId).toBe(streamId);
      expect(ce.reducerId).toBe('fixture@v1');
      expect(ce.operationId).toBe('inspect-op');
      expect(ce.expectedVersion).toBeLessThan(ce.actualVersion);
    }
  });
});
