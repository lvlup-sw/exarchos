// Two `EventStore` instances over one state directory.
//
// The test pins three facts:
//   1. Both instances initialize with no error and no file-system exclusion.
//   2. Interleaved appends from both instances give the gapless sequence 1, 2, 3 on one stream.
//   3. The state directory holds no `.event-store.lock` file after the test.
//
// The two instances stand for two OS processes that attach to one SQLite file, as in
// `store.race.test.ts` and `cli-concurrency.test.ts`. SQLite serializes the writers with WAL,
// `BEGIN IMMEDIATE` and the `(streamId, sequence)` primary key. The test mocks nothing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { EventStore } from '../../../src/events/store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

describe('EventStore cross-process attach (#1343, Wave A5)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventstore-multiproc-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /**
   * Both `initialize()` calls must resolve: no PID lock excludes the second instance.
   * The appends alternate between the instances and the test awaits each one, so the order is
   * deterministic. `query()` reads the shared SQLite file, so each instance must see all three
   * events in order.
   * `fs.access` rejects for a path that does not exist. That is the expected state of the lock
   * path, and a lock file there is a regression.
   */
  it('EventStore_TwoProcesses_InterleavedAppendsAreObservedByBoth', async () => {
    const STREAM_ID = 'multi-process-stream';

    const storeA = new EventStore(stateDir);
    const storeB = new EventStore(stateDir);

    await expect(storeA.initialize()).resolves.toBeUndefined();
    await expect(storeB.initialize()).resolves.toBeUndefined();

    const ack1 = await storeA.append(STREAM_ID, {
      type: 'task.assigned',
      data: { source: 'storeA', step: 1 },
    });
    const ack2 = await storeB.append(STREAM_ID, {
      type: 'task.completed',
      data: { source: 'storeB', step: 2 },
    });
    const ack3 = await storeA.append(STREAM_ID, {
      type: 'workflow.transition',
      data: { source: 'storeA', step: 3 },
    });

    expect(ack1.sequence).toBe(1);
    expect(ack2.sequence).toBe(2);
    expect(ack3.sequence).toBe(3);

    const eventsFromA = await storeA.query(STREAM_ID);
    const eventsFromB = await storeB.query(STREAM_ID);

    expect(eventsFromA).toHaveLength(3);
    expect(eventsFromB).toHaveLength(3);

    const seqsA = eventsFromA.map((e) => e.sequence);
    const seqsB = eventsFromB.map((e) => e.sequence);
    expect(seqsA).toEqual([1, 2, 3]);
    expect(seqsB).toEqual([1, 2, 3]);

    expect(eventsFromA[0].type).toBe('task.assigned');
    expect(eventsFromA[1].type).toBe('task.completed');
    expect(eventsFromA[2].type).toBe('workflow.transition');

    const lockPath = path.join(stateDir, '.event-store.lock');
    await expect(fs.access(lockPath)).rejects.toThrow();
  });
});
