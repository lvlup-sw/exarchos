/**
 * Tests for `bisect`, the binary search over `projectAt` folds of one stream.
 * They pin the first flip event of a monotonic predicate and the logarithmic probe count.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../../../src/events/store.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import type { ProjectionReducer } from '../../../src/projections/types.js';
import { bisect } from '../../../src/projections/bisect.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'bisect-test-'));
  store = new EventStore(tempDir);
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

/** The state of the test reducers: the count of folded events. */
interface CountState {
  readonly count: number;
}

/** Counts the folded events. No test seeds a snapshot, so each `projectAt` probe folds from the first event. */
const countReducer: ProjectionReducer<CountState, WorkflowEvent> = {
  id: 'bisect-count@v1',
  version: 1,
  scope: 'stream',
  initial: { count: 0 },
  apply(state) {
    return { count: state.count + 1 };
  },
};

/**
 * Counts the folded events and adds one to `counter.applies` on each `apply` call.
 * Each probe is one bounded fold, so the total measures the work of all probes.
 */
function countingReducer(counter: { applies: number }): ProjectionReducer<
  CountState,
  WorkflowEvent
> {
  return {
    id: 'bisect-counting@v1',
    version: 1,
    scope: 'stream',
    initial: { count: 0 },
    apply(state) {
      counter.applies += 1;
      return { count: state.count + 1 };
    },
  };
}

/** Append `n` events to `streamId` and return the appended events in order. */
async function seedStream(
  streamId: string,
  n: number,
): Promise<WorkflowEvent[]> {
  const out: WorkflowEvent[] = [];
  for (let i = 0; i < n; i++) {
    const timestamp = new Date(Date.UTC(2026, 5, 20, 0, 0, i)).toISOString();
    out.push(
      await store.append(streamId, {
        type: 'task.assigned',
        timestamp,
        data: { taskId: `T${i}` },
      }),
    );
  }
  return out;
}

describe('bisect — binary search over projectAt (T5)', () => {
  /** The count reaches 5 at sequence 5, so the boundary is the fifth event that `store.query` returns. */
  it('bisect_plantedTransition_returnsFirstFlipEvent', async () => {
    const streamId = 'wf-bisect-planted';
    await seedStream(streamId, 8);
    const events = await store.query(streamId);

    const predicate = (s: CountState): boolean => s.count >= 5;

    const result = await bisect(countReducer, store, streamId, predicate);

    expect(result).not.toBeNull();
    expect(result?.sequence).toBe(5);
    expect(result?.event).toStrictEqual(events[4]);
  });

  it('bisect_predicateNeverFlips_returnsNull', async () => {
    const streamId = 'wf-bisect-never';
    await seedStream(streamId, 6);

    const predicate = (s: CountState): boolean => s.count >= 100;

    const result = await bisect(countReducer, store, streamId, predicate);
    expect(result).toBeNull();
  });

  it('bisect_predicateTrueFromFirstEvent_returnsFirstEvent', async () => {
    const streamId = 'wf-bisect-first';
    await seedStream(streamId, 5);
    const events = await store.query(streamId);

    const predicate = (s: CountState): boolean => s.count >= 1;

    const result = await bisect(countReducer, store, streamId, predicate);

    expect(result).not.toBeNull();
    expect(result?.sequence).toBe(1);
    expect(result?.event).toStrictEqual(events[0]);
  });

  /** The predicate is true on the initial state, but an empty stream has no event to return. */
  it('bisect_emptyStream_returnsNull', async () => {
    const streamId = 'wf-bisect-empty';

    const predicate = (s: CountState): boolean => s.count >= 0;

    const result = await bisect(countReducer, store, streamId, predicate);
    expect(result).toBeNull();
  });

  /** Each probe folds at most `n` events. The test bounds the `apply` total by `n` times a logarithmic probe budget. */
  it('bisect_logarithmicProbeCount_staysUnderLinear', async () => {
    const streamId = 'wf-bisect-log';
    const n = 64;
    await seedStream(streamId, n);

    const counter = { applies: 0 };
    const reducer = countingReducer(counter);

    const predicate = (s: CountState): boolean => s.count >= 33;

    const result = await bisect(reducer, store, streamId, predicate);

    expect(result?.sequence).toBe(33);

    const probeBudget = 2 * Math.ceil(Math.log2(n)) + 2;
    expect(counter.applies).toBeLessThanOrEqual(n * probeBudget);
  });

  /** Each predicate call is one `projectAt` probe. A linear scan does `n` probes. */
  it('bisect_logarithmicProbeCount_predicateCalledOLogN', async () => {
    const streamId = 'wf-bisect-probecount';
    const n = 64;
    await seedStream(streamId, n);

    let probes = 0;
    const predicate = (s: CountState): boolean => {
      probes += 1;
      return s.count >= 40;
    };

    const result = await bisect(countReducer, store, streamId, predicate);

    expect(result?.sequence).toBe(40);

    const logBudget = 2 * Math.ceil(Math.log2(n)) + 2;
    expect(probes).toBeLessThanOrEqual(logBudget);
    expect(probes).toBeLessThan(n);
  });
});
