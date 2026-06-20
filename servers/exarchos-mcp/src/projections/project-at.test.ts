import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { ProjectionReducer } from './types.js';
import { boundEvents, type AsOfBound } from './cursor.js';
import { projectAt } from './rebuild.js';

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
  await rm(tempDir, { recursive: true, force: true });
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
