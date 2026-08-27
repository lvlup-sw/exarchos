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
 * Wave 3 Task 3.5 — `decide` translates the substrate's `sequence-conflict`
 * AppendResult into a typed {@link ConcurrencyError} when the stream tail
 * advances between the read+fold phase and the commit phase.
 *
 * Pattern (mirrors `atomic-appender.race.test.ts`'s callback-driven
 * harness): two concurrent `decide` invocations target the same stream
 * via separate appenders sharing one SqliteBackend. Both read the tail,
 * fold, and then race for the commit. One commits at `tail+1`; the other
 * sees the now-advanced tail and throws `ConcurrencyError`.
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

  it('Decide_ThrowsConcurrencyError_WhenStreamTailAdvancedDuringDecide', async () => {
    // Seed the stream so tail starts at 2.
    await seedStream(eventStore, streamId, 2);

    // Build a SECOND appender sharing the same SqliteBackend so the
    // per-stream Promise mutex is per-appender (not cross-process here,
    // but per-appender), giving the deterministic race surface needed
    // for the test. The shared backend means substrate-level OCC fires.
    const backend = appender.ensureSqliteBackendSync();
    const sideAppender = new AtomicAppender({
      stateDir,
      sqliteBackend: backend,
    });

    // Gate that lets us deterministically interleave the two decides.
    // decideA's closure waits on this; while it waits, we run a
    // sideAppender.appendUnkeyed to bump the tail. Then we release the
    // gate; decideA commits with a stale expectedSequence.
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    const decideAPromise = appender.decide<FixtureState>(
      streamId,
      'fixture@v1',
      async () => {
        // Pause inside the closure so the external write can land
        // before decide's commit phase. The fold + tail capture already
        // happened (the closure was called with state + ctx).
        await gate;
        return [{ type: 'task.completed', data: { taskId: 'A-decision' } }];
      },
      { registry },
    );

    // Give decideA a microtask to enter its closure (start awaiting gate).
    await Promise.resolve();

    // External advance: another writer commits to the stream.
    const sideResult = await sideAppender.appendUnkeyed(streamId, [
      { type: 'task.assigned', data: { taskId: 'T-external' } },
    ]);
    expect(sideResult.ok).toBe(true);

    // Release decideA: now its commit fires with expectedSequence=2 but
    // the tail is at 3 — sequence-conflict translates to ConcurrencyError.
    release();

    await expect(decideAPromise).rejects.toBeInstanceOf(ConcurrencyError);

    // Re-run to inspect the error fields (rejects.toBeInstanceOf consumes
    // the promise but the underlying decide call already settled — re-issue
    // a fresh one against the now-advanced tail to confirm the canonical
    // path still works.)
    try {
      // Construct a NEW decide call that triggers a similar race so we
      // can inspect the error fields. We seed via another sideAppender
      // write to keep the structure parallel.
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
      // expectedVersion < actualVersion is the canonical signal.
      expect(ce.expectedVersion).toBeLessThan(ce.actualVersion);
    }
  });
});
