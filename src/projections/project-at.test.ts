import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../events/store.js';
import type { WorkflowEvent } from '../events/schemas.js';
import type { ProjectionReducer } from './types.js';
import { boundEvents, type AsOfBound } from './cursor.js';
import { projectAt } from './rebuild.js';
import { appendSnapshot } from './store.js';
import type { SnapshotRecord } from './snapshot-schema.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

/**
 * T2 — `projectAt` cold-fold + purity.
 *
 * `projectAt(reducer, store, streamId, bound?)` is the bounded analogue of
 * `rebuildProjection`: it folds the reducer over `boundEvents(query(stream),
 * bound)`. The oracle for these tests is a manual fold of exactly that bounded
 * list, so the test pins the equivalence
 *
 *   projectAt(N) ≡ fold(reducer, boundEvents(events, bound)).
 *
 * (T3 extends this file with snapshot warm-start tests; the warm path MUST stay
 * observationally identical to this cold path — INV-1 purity.)
 */

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'project-at-test-'));
  store = new EventStore(tempDir);
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

/**
 * Projected state for the test reducer: the running count of folded events and
 * the ordered list of stream sequences seen. Simple, deterministic, and
 * structurally comparable so a warm fold can be asserted byte-equal to a cold
 * fold.
 */
interface CountState {
  readonly count: number;
  readonly sequences: readonly number[];
}

/**
 * A minimal, pure, stream-scoped reducer used as the oracle subject. It never
 * mutates `state` (spreads a new object every apply), carries an `id`/`version`
 * so T3 can address a snapshot, and is independent of event payload so any
 * appended event advances it deterministically.
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
 * Append `n` events to `streamId` and return the appended events in order.
 *
 * Stamps strictly-increasing timestamps (one second apart) so the
 * `untilTimestamp` bound is meaningfully discriminating. A tight append loop
 * otherwise lands every event in the same millisecond, collapsing the
 * timestamp axis and making `untilTimestamp` indistinguishable from "all
 * events" — which is correct `<= T` behaviour but not what the timestamp test
 * means to exercise.
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
  it('projectAt_untilSequenceN_equalsFoldOfEventsThroughN', async () => {
    // GIVEN a synthetic event log on one stream.
    const streamId = 'wf-pa-seq';
    const tail = 8;
    await seedStream(streamId, tail);
    const events = await store.query(streamId);

    // Property: for any N in [0, tail], projectAt(untilSequence: N) equals a
    //   manual fold over the events with sequence <= N.
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

  it('projectAt_untilTimestamp_matchesEquivalentSequenceFold', async () => {
    // GIVEN a stream; pick the timestamp of a middle event as the ceiling.
    const streamId = 'wf-pa-ts';
    await seedStream(streamId, 6);
    const events = await store.query(streamId);
    const pivot = events[3]; // sequence 4

    const tsBound: AsOfBound = { untilTimestamp: pivot.timestamp };

    // WHEN we project at the timestamp ceiling.
    const actual = await projectAt(countReducer, store, streamId, tsBound);

    // THEN it matches the fold over events with timestamp <= pivot.timestamp,
    //   AND (since per-stream timestamp is monotonic with sequence) equals the
    //   fold at untilSequence: pivot.sequence.
    const oracleTs = foldOracle(countReducer, events, tsBound);
    const oracleSeq = foldOracle(countReducer, events, {
      untilSequence: pivot.sequence,
    });
    expect(actual).toStrictEqual(oracleTs);
    expect(actual).toStrictEqual(oracleSeq);
  });

  it('projectAt_boundPastTail_equalsLiveProjection', async () => {
    // GIVEN a stream of 5 events.
    const streamId = 'wf-pa-tail';
    await seedStream(streamId, 5);
    const events = await store.query(streamId);

    // WHEN we project at a bound past the tip (and with no bound at all).
    const past = await projectAt(countReducer, store, streamId, {
      untilSequence: 999,
    });
    const unbounded = await projectAt(countReducer, store, streamId);

    // THEN both equal the full live fold over every event.
    const liveOracle = foldOracle(countReducer, events);
    expect(past).toStrictEqual(liveOracle);
    expect(unbounded).toStrictEqual(liveOracle);
    expect(unbounded.count).toBe(5);
  });

  it('projectAt_bothBounds_rejects', async () => {
    // GIVEN a stream and a malformed bound carrying both keys.
    const streamId = 'wf-pa-both';
    await seedStream(streamId, 2);
    const both = {
      untilSequence: 1,
      untilTimestamp: '2026-06-20T00:00:00.000Z',
    } as unknown as AsOfBound;

    // WHEN/THEN projectAt surfaces the mutually-exclusive-bound rejection.
    await expect(
      projectAt(countReducer, store, streamId, both),
    ).rejects.toThrow(/mutually|exclusive|both/i);
  });
});

/**
 * A marker the pure reducer can NEVER emit. Real folded sequences are positive
 * integers (`WorkflowEvent.sequence`), so a leading `SENTINEL` in
 * `state.sequences` is observable proof that the warm-start path seeded from a
 * snapshot rather than cold-folding from `reducer.initial`. The honest count is
 * preserved alongside (the reducer still increments `count` per tail event), so
 * `count` stays equal to the cold fold while `sequences[0] === SENTINEL`
 * distinguishes warm from cold.
 */
const SENTINEL = -7;

/**
 * Seed a snapshot whose state is the cold fold of the stream **through
 * `atSequence`** but with a {@link SENTINEL} prepended to `sequences`, stamped
 * with `snapshot.sequence = atSequence`. The stream-scoped snapshot contract:
 * `snapshot.sequence` is the stream sequence of the LAST event baked into
 * `snapshot.state`. The sentinel makes "did warm-start actually consult the
 * snapshot" observable.
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
  it('projectAt_snapshotAtOrBeforeN_equalsColdFold', async () => {
    // GIVEN a 6-event stream and a bound at N=5.
    const streamId = 'wf-pa-warm';
    await seedStream(streamId, 6);
    const events = await store.query(streamId);
    const bound: AsOfBound = { untilSequence: 5 };

    // AND a sentinel snapshot baked at sequence 3 (<= N): a usable warm-start.
    const baked = await seedSentinelSnapshot(streamId, events, 3);

    // WHEN we project at N with the warm snapshot present.
    const warm = await projectAt(countReducer, store, streamId, bound);

    // THEN warm-start DID seed from the snapshot (the sentinel survives), then
    //   folded only the bounded tail (events 4..5) on top of it.
    expect(warm.sequences[0]).toBe(SENTINEL);
    expect(warm).toStrictEqual({
      count: baked.count + 2, // tail events 4 and 5
      sequences: [...baked.sequences, 4, 5],
    });
    // AND the honest count matches the cold fold — warm-start is an
    //   observationally-equivalent optimisation w.r.t. the event count (INV-1).
    const cold = foldOracle(countReducer, events, bound);
    expect(warm.count).toBe(cold.count);
  });

  it('projectAt_snapshotBeyondN_ignoresSnapshotAndColdFolds', async () => {
    // GIVEN a 6-event stream and a bound at N=2.
    const streamId = 'wf-pa-beyond';
    await seedStream(streamId, 6);
    const events = await store.query(streamId);
    const bound: AsOfBound = { untilSequence: 2 };

    // AND a sentinel snapshot baked at sequence 4 (> N): UNUSABLE for an
    //   as-of-2 read — it already folded events 3 and 4 beyond the bound.
    await seedSentinelSnapshot(streamId, events, 4);

    // WHEN we project at N=2.
    const result = await projectAt(countReducer, store, streamId, bound);

    // THEN the beyond-bound snapshot is IGNORED (no sentinel) and the result is
    //   the clean cold fold over events 1..2 only.
    expect(result.sequences).not.toContain(SENTINEL);
    const cold = foldOracle(countReducer, events, bound);
    expect(result).toStrictEqual(cold);
    expect(result.count).toBe(2);
    expect(result.sequences).toEqual([1, 2]);
  });

  it('projectAt_snapshotAtN_foldsEmptyTail', async () => {
    // GIVEN a 4-event stream and a bound exactly at N=4 (the tail).
    const streamId = 'wf-pa-boundary';
    await seedStream(streamId, 4);
    const events = await store.query(streamId);
    const bound: AsOfBound = { untilSequence: 4 };

    // AND a sentinel snapshot baked at sequence 4 == N: the tail is empty.
    const baked = await seedSentinelSnapshot(streamId, events, 4);

    // WHEN we project at N=4.
    const result = await projectAt(countReducer, store, streamId, bound);

    // THEN warm-start seeds from the snapshot and folds an EMPTY tail — the
    //   result is exactly the snapshot state (sentinel intact, no double-count,
    //   no dropped event). count still equals the cold fold's count.
    expect(result).toStrictEqual(baked);
    expect(result.sequences[0]).toBe(SENTINEL);
    const cold = foldOracle(countReducer, events, bound);
    expect(result.count).toBe(cold.count);
  });

  it('projectAt_honestSnapshotPresent_structurallyEqualsColdFold', async () => {
    // The keystone INV-1 guard: with an HONEST snapshot (one whose state is
    //   exactly the cold fold through its sequence, no sentinel), the warm path
    //   must be byte/structurally identical to the cold path — proving
    //   warm-start is a pure optimisation, not just count-equivalent.

    // GIVEN a 6-event stream and a bound at N=5.
    const streamId = 'wf-pa-honest';
    await seedStream(streamId, 6);
    const events = await store.query(streamId);
    const bound: AsOfBound = { untilSequence: 5 };

    // AND an HONEST snapshot at sequence 3 == foldOracle(events, untilSeq 3),
    //   with NO sentinel — a faithful warm-start point.
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

    // WHEN we project at N with the honest snapshot present.
    const warm = await projectAt(countReducer, store, streamId, bound);

    // THEN warm ≡ cold by FULL structural equality (not merely .count).
    const cold = foldOracle(countReducer, events, bound);
    expect(warm).toStrictEqual(cold);
  });

  it('projectAt_untilTimestampNonPrefix_bypassesWarmStartAndColdFolds', async () => {
    // Single-stream `query` orders by SEQUENCE, not timestamp. A backwards clock
    // skew (seq 2 stamped LATER than seq 3) makes an `untilTimestamp` bound drop
    // an interior event, so the bounded slice is NOT a prefix of the log. A
    // snapshot seeded against that subset would smuggle the excluded event's
    // effect into the result — warm-start MUST be bypassed (INV-1 purity).
    const streamId = 'wf-pa-skew';
    const tsAt = (s: number) =>
      new Date(Date.UTC(2026, 5, 20, 0, 0, s)).toISOString();

    // Sequence order 1..4 with NON-monotonic timestamps (seq 2 is the latest):
    //   seq1→t0, seq2→t3, seq3→t1, seq4→t2
    for (const ts of [tsAt(0), tsAt(3), tsAt(1), tsAt(2)]) {
      await store.append(streamId, {
        type: 'task.assigned',
        timestamp: ts,
        data: {},
      });
    }
    const events = await store.query(streamId);

    // Bound at t1 keeps timestamp <= t1: seq1 (t0) and seq3 (t1), NOT seq2 (t3).
    // Bounded = [seq1, seq3] — a non-prefix subset (seq 2 is missing).
    const bound: AsOfBound = { untilTimestamp: tsAt(1) };

    // A snapshot baked at sequence 2 is eligible by the sequence-only check
    // (2 <= effectiveN 3) but bakes in seq 2, which the ceiling excludes.
    await seedSentinelSnapshot(streamId, events, 2);

    const result = await projectAt(countReducer, store, streamId, bound);

    // Warm-start bypassed (no sentinel); the result is the honest cold fold of
    // the timestamp-bounded slice — seq 2's effect never leaks in.
    expect(result.sequences).not.toContain(SENTINEL);
    const cold = foldOracle(countReducer, events, bound);
    expect(result).toStrictEqual(cold);
    expect(result.sequences).toEqual([1, 3]);
  });
});
