/**
 * Tests for `projectAt`, the bounded fold of a reducer over one stream.
 * The oracle is a manual fold of `boundEvents(events, bound)`.
 * A snapshot warm start must give the same result as the cold fold.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../../../src/events/store.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import type { ProjectionReducer } from '../../../src/projections/types.js';
import { boundEvents, type AsOfBound } from '../../../src/projections/cursor.js';
import { projectAt } from '../../../src/projections/rebuild.js';
import { appendSnapshot } from '../../../src/projections/store.js';
import type { SnapshotRecord } from '../../../src/projections/snapshot-schema.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'project-at-test-'));
  store = new EventStore(tempDir);
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

/** The state of the test reducer: the count of folded events and the stream sequences in fold order. */
interface CountState {
  readonly count: number;
  readonly sequences: readonly number[];
}

/**
 * A pure reducer that ignores the event payload, so each appended event advances it.
 * Its `id` and `version` let a test address a snapshot.
 */
const countReducer: ProjectionReducer<CountState, WorkflowEvent> = {
  id: 'project-at-count@v1',
  version: 1,
  scope: 'stream',
  initial: { count: 0, sequences: [] },
  apply(state, event) {
    return {
      count: state.count + 1,
      sequences: [...state.sequences, event.sequence],
    };
  },
};

/** Manual fold over a bounded slice — the oracle the warm/cold paths must match. */
function foldOracle(
  reducer: ProjectionReducer<CountState, WorkflowEvent>,
  events: readonly WorkflowEvent[],
  bound?: AsOfBound,
): CountState {
  return boundEvents(events, bound).reduce(
    (acc, ev) => reducer.apply(acc, ev),
    reducer.initial,
  );
}

/**
 * Appends `n` events to `streamId` and returns them in order. The timestamps are one second apart.
 * Without these explicit timestamps, a tight append loop can put every event in one millisecond.
 * Then an `untilTimestamp` bound keeps all events.
 */
async function seedStream(
  streamId: string,
  n: number,
): Promise<WorkflowEvent[]> {
  const out: WorkflowEvent[] = [];
  for (let i = 0; i < n; i++) {
    const timestamp = new Date(
      Date.UTC(2026, 5, 20, 0, 0, i),
    ).toISOString();
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

describe('projectAt — cold bounded fold (T2)', () => {
  /** Property: for each `N` from 0 to the tail, `projectAt` at `untilSequence: N` equals the manual fold of the events through `N`. */
  it('projectAt_untilSequenceN_equalsFoldOfEventsThroughN', async () => {
    const streamId = 'wf-pa-seq';
    const tail = 8;
    await seedStream(streamId, tail);
    const events = await store.query(streamId);

    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: tail }), async (n) => {
        const bound: AsOfBound = { untilSequence: n };
        const actual = await projectAt(countReducer, store, streamId, bound);
        const oracle = foldOracle(countReducer, events, bound);
        expect(actual).toStrictEqual(oracle);
      }),
      { numRuns: 50 },
    );
  });

  /**
   * The ceiling is the timestamp of the event at sequence 4.
   * Timestamps rise with sequence here, so the result also equals the fold at `untilSequence: 4`.
   */
  it('projectAt_untilTimestamp_matchesEquivalentSequenceFold', async () => {
    const streamId = 'wf-pa-ts';
    await seedStream(streamId, 6);
    const events = await store.query(streamId);
    const pivot = events[3];

    const tsBound: AsOfBound = { untilTimestamp: pivot.timestamp };

    const actual = await projectAt(countReducer, store, streamId, tsBound);

    const oracleTs = foldOracle(countReducer, events, tsBound);
    const oracleSeq = foldOracle(countReducer, events, {
      untilSequence: pivot.sequence,
    });
    expect(actual).toStrictEqual(oracleTs);
    expect(actual).toStrictEqual(oracleSeq);
  });

  it('projectAt_boundPastTail_equalsLiveProjection', async () => {
    const streamId = 'wf-pa-tail';
    await seedStream(streamId, 5);
    const events = await store.query(streamId);

    const past = await projectAt(countReducer, store, streamId, {
      untilSequence: 999,
    });
    const unbounded = await projectAt(countReducer, store, streamId);

    const liveOracle = foldOracle(countReducer, events);
    expect(past).toStrictEqual(liveOracle);
    expect(unbounded).toStrictEqual(liveOracle);
    expect(unbounded.count).toBe(5);
  });

  it('projectAt_bothBounds_rejects', async () => {
    const streamId = 'wf-pa-both';
    await seedStream(streamId, 2);
    const both = {
      untilSequence: 1,
      untilTimestamp: '2026-06-20T00:00:00.000Z',
    } as unknown as AsOfBound;

    await expect(
      projectAt(countReducer, store, streamId, both),
    ).rejects.toThrow(/mutually|exclusive|both/i);
  });
});

/**
 * A marker that the reducer never emits, because real sequences are positive integers.
 * A leading `SENTINEL` in `state.sequences` proves that the fold started from a snapshot and not from `reducer.initial`.
 * The reducer still counts each tail event, so `count` equals the count of the cold fold.
 */
const SENTINEL = -7;

/**
 * Writes a snapshot at `atSequence`. Its state is the cold fold through `atSequence`, with {@link SENTINEL} first in `sequences`.
 * `snapshot.sequence` is the stream sequence of the last event in `snapshot.state`.
 */
async function seedSentinelSnapshot(
  streamId: string,
  events: readonly WorkflowEvent[],
  atSequence: number,
): Promise<CountState> {
  const honest = foldOracle(countReducer, events, {
    untilSequence: atSequence,
  });
  const baked: CountState = {
    count: honest.count,
    sequences: [SENTINEL, ...honest.sequences],
  };
  const record: SnapshotRecord = {
    projectionId: countReducer.id,
    projectionVersion: String(countReducer.version),
    sequence: atSequence,
    state: baked,
    timestamp: '2026-06-20T12:00:00.000Z',
  };
  appendSnapshot(store.getReadBackend(), streamId, record);
  return baked;
}

describe('projectAt — snapshot warm-start equivalence (T3)', () => {
  /**
   * The snapshot at sequence 3 is usable for a bound of 5. The sentinel stays, so the fold started from the snapshot.
   * Only tail events 4 and 5 fold onto it, and the count equals the count of the cold fold.
   */
  it('projectAt_snapshotAtOrBeforeN_equalsColdFold', async () => {
    const streamId = 'wf-pa-warm';
    await seedStream(streamId, 6);
    const events = await store.query(streamId);
    const bound: AsOfBound = { untilSequence: 5 };

    const baked = await seedSentinelSnapshot(streamId, events, 3);

    const warm = await projectAt(countReducer, store, streamId, bound);

    expect(warm.sequences[0]).toBe(SENTINEL);
    expect(warm).toStrictEqual({
      count: baked.count + 2,
      sequences: [...baked.sequences, 4, 5],
    });
    const cold = foldOracle(countReducer, events, bound);
    expect(warm.count).toBe(cold.count);
  });

  /**
   * The snapshot at sequence 4 holds events 3 and 4, which are past the bound of 2.
   * So the read ignores the snapshot and folds events 1 and 2 cold.
   */
  it('projectAt_snapshotBeyondN_ignoresSnapshotAndColdFolds', async () => {
    const streamId = 'wf-pa-beyond';
    await seedStream(streamId, 6);
    const events = await store.query(streamId);
    const bound: AsOfBound = { untilSequence: 2 };

    await seedSentinelSnapshot(streamId, events, 4);

    const result = await projectAt(countReducer, store, streamId, bound);

    expect(result.sequences).not.toContain(SENTINEL);
    const cold = foldOracle(countReducer, events, bound);
    expect(result).toStrictEqual(cold);
    expect(result.count).toBe(2);
    expect(result.sequences).toEqual([1, 2]);
  });

  /**
   * The snapshot sits at the bound, so the tail is empty.
   * The result is exactly the snapshot state: no event counts twice and none is lost.
   */
  it('projectAt_snapshotAtN_foldsEmptyTail', async () => {
    const streamId = 'wf-pa-boundary';
    await seedStream(streamId, 4);
    const events = await store.query(streamId);
    const bound: AsOfBound = { untilSequence: 4 };

    const baked = await seedSentinelSnapshot(streamId, events, 4);

    const result = await projectAt(countReducer, store, streamId, bound);

    expect(result).toStrictEqual(baked);
    expect(result.sequences[0]).toBe(SENTINEL);
    const cold = foldOracle(countReducer, events, bound);
    expect(result.count).toBe(cold.count);
  });

  /**
   * The snapshot holds exactly the cold fold through sequence 3, with no sentinel.
   * The warm result must then equal the cold fold in full structure, not only in `count`.
   */
  it('projectAt_honestSnapshotPresent_structurallyEqualsColdFold', async () => {
    const streamId = 'wf-pa-honest';
    await seedStream(streamId, 6);
    const events = await store.query(streamId);
    const bound: AsOfBound = { untilSequence: 5 };

    const honestState = foldOracle(countReducer, events, {
      untilSequence: 3,
    });
    const honestRecord: SnapshotRecord = {
      projectionId: countReducer.id,
      projectionVersion: String(countReducer.version),
      sequence: 3,
      state: honestState,
      timestamp: '2026-06-20T12:00:00.000Z',
    };
    appendSnapshot(store.getReadBackend(), streamId, honestRecord);

    const warm = await projectAt(countReducer, store, streamId, bound);

    const cold = foldOracle(countReducer, events, bound);
    expect(warm).toStrictEqual(cold);
  });

  /**
   * A single-stream `query` orders by sequence, not by timestamp. Here sequence 2 has the latest timestamp.
   * So a bound at `tsAt(1)` keeps sequences 1 and 3, which is not a prefix of the log.
   * The snapshot at sequence 2 passes the sequence check (2 is at or below 3), but it holds the excluded event.
   * `projectAt` must skip the warm start and fold the bounded slice cold.
   */
  it('projectAt_untilTimestampNonPrefix_bypassesWarmStartAndColdFolds', async () => {
    const streamId = 'wf-pa-skew';
    const tsAt = (s: number) =>
      new Date(Date.UTC(2026, 5, 20, 0, 0, s)).toISOString();

    for (const ts of [tsAt(0), tsAt(3), tsAt(1), tsAt(2)]) {
      await store.append(streamId, {
        type: 'task.assigned',
        timestamp: ts,
        data: {},
      });
    }
    const events = await store.query(streamId);

    const bound: AsOfBound = { untilTimestamp: tsAt(1) };

    await seedSentinelSnapshot(streamId, events, 2);

    const result = await projectAt(countReducer, store, streamId, bound);

    expect(result.sequences).not.toContain(SENTINEL);
    const cold = foldOracle(countReducer, events, bound);
    expect(result).toStrictEqual(cold);
    expect(result.sequences).toEqual([1, 3]);
  });
});
