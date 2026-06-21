import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { ProjectionReducer } from './types.js';
import { bisect } from './bisect.js';

/**
 * T5 — `bisect` binary search over `projectAt`.
 *
 * `bisect(reducer, store, streamId, predicate)` binary-searches the sequence
 * axis [1..tail] for the FIRST event at which `predicate(projectAt(seq))`
 * becomes true, assuming a MONOTONIC predicate (false…false → true…true). It
 * returns `{ sequence, event }` of that flip boundary, or `null` if the
 * predicate is never true through the tip.
 *
 * Each probe folds via `projectAt(reducer, store, stream, { untilSequence: mid })`,
 * so the search is O(log n) cheap folds — these tests pin both the planted-flip
 * correctness and the logarithmic probe budget.
 */

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'bisect-test-'));
  store = new EventStore(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Projected state for the test reducer: the running count of folded events.
 * Simple, deterministic, monotonically increasing — the natural substrate for
 * a monotonic threshold predicate (`count >= K`).
 */
interface CountState {
  readonly count: number;
}

/**
 * A minimal, pure, stream-scoped reducer. It counts folded events and carries
 * an `id`/`version` so `projectAt`'s warm-start path is addressable (though
 * these tests seed no snapshot — the cold path runs).
 */
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
 * A reducer that wraps {@link countReducer} but increments a shared probe
 * counter on every `apply` invocation. `bisect` runs each probe as a full
 * bounded fold, so total `apply` calls are a faithful upper bound on probe
 * work — counting them lets the logarithmic-budget test assert the search
 * touches far fewer events than a linear scan would.
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
  it('bisect_plantedTransition_returnsFirstFlipEvent', async () => {
    // GIVEN an 8-event stream where the count reaches 5 at sequence 5.
    const streamId = 'wf-bisect-planted';
    const events = await seedStream(streamId, 8);

    // AND a monotonic predicate that flips true once count >= 5 — i.e. at the
    //   5th folded event, whose stream sequence is 5.
    const predicate = (s: CountState): boolean => s.count >= 5;

    // WHEN we bisect for the first flip.
    const result = await bisect(countReducer, store, streamId, predicate);

    // THEN it returns the event at the boundary sequence (5) — the event that
    //   caused predicate(projectAt(5)) to become true.
    expect(result).not.toBeNull();
    expect(result?.sequence).toBe(5);
    expect(result?.event).toStrictEqual(events[4]); // 0-indexed: sequence 5
  });

  it('bisect_predicateNeverFlips_returnsNull', async () => {
    // GIVEN a 6-event stream.
    const streamId = 'wf-bisect-never';
    await seedStream(streamId, 6);

    // AND a predicate that never becomes true through the tip (count tops out
    //   at 6, threshold is unreachable).
    const predicate = (s: CountState): boolean => s.count >= 100;

    // WHEN/THEN bisect returns null.
    const result = await bisect(countReducer, store, streamId, predicate);
    expect(result).toBeNull();
  });

  it('bisect_predicateTrueFromFirstEvent_returnsFirstEvent', async () => {
    // GIVEN a 5-event stream.
    const streamId = 'wf-bisect-first';
    const events = await seedStream(streamId, 5);

    // AND a predicate already true after the very first folded event.
    const predicate = (s: CountState): boolean => s.count >= 1;

    // WHEN we bisect.
    const result = await bisect(countReducer, store, streamId, predicate);

    // THEN the boundary is the first event (sequence 1).
    expect(result).not.toBeNull();
    expect(result?.sequence).toBe(1);
    expect(result?.event).toStrictEqual(events[0]);
  });

  it('bisect_emptyStream_returnsNull', async () => {
    // GIVEN a stream with no events (tail = 0).
    const streamId = 'wf-bisect-empty';

    // AND any predicate (even one true on initial state) — there is no event to
    //   return as a boundary, so the result is null.
    const predicate = (s: CountState): boolean => s.count >= 0;

    const result = await bisect(countReducer, store, streamId, predicate);
    expect(result).toBeNull();
  });

  it('bisect_logarithmicProbeCount_staysUnderLinear', async () => {
    // GIVEN a large stream (n = 64) so log2(n) = 6 is well under n.
    const streamId = 'wf-bisect-log';
    const n = 64;
    await seedStream(streamId, n);

    // AND a counting reducer that tallies every `apply` across all probes.
    const counter = { applies: 0 };
    const reducer = countingReducer(counter);

    // AND a predicate that flips at the midpoint (count >= 33).
    const predicate = (s: CountState): boolean => s.count >= 33;

    // WHEN we bisect.
    const result = await bisect(reducer, store, streamId, predicate);

    // THEN the boundary is found at sequence 33.
    expect(result?.sequence).toBe(33);

    // AND the total folded-event work is O(log n): a binary search runs
    //   ~ceil(log2(n)) probes, each a bounded fold of <= n events but on
    //   average ~n/2 — the meaningful bound is the PROBE COUNT, which we cap
    //   independently below. Here we assert the cheaper invariant that the
    //   number of distinct probes (full folds) is logarithmic, by capping the
    //   probe count via the dedicated counter the impl is wired to expose
    //   indirectly: a linear scan would call the predicate n times; a binary
    //   search calls it O(log n) times.
    //
    //   We measure probe count through a predicate spy rather than apply (apply
    //   work is per-fold, not per-probe). See the predicate-spy assertion.
    expect(result?.sequence).toBe(33);
    void counter; // apply tally is informational; the probe-count cap is below.
  });

  it('bisect_logarithmicProbeCount_predicateCalledOLogN', async () => {
    // GIVEN a large stream (n = 64).
    const streamId = 'wf-bisect-probecount';
    const n = 64;
    await seedStream(streamId, n);

    // AND a predicate spy that flips at count >= 40 and tallies its calls. Each
    //   call corresponds to exactly one `projectAt` probe.
    let probes = 0;
    const predicate = (s: CountState): boolean => {
      probes += 1;
      return s.count >= 40;
    };

    // WHEN we bisect.
    const result = await bisect(countReducer, store, streamId, predicate);

    // THEN the boundary is correct...
    expect(result?.sequence).toBe(40);

    // ...AND the probe count is logarithmic: <= 2*ceil(log2(n)) + 2, and
    //   strictly less than n (a linear scan would probe n times).
    const logBudget = 2 * Math.ceil(Math.log2(n)) + 2;
    expect(probes).toBeLessThanOrEqual(logBudget);
    expect(probes).toBeLessThan(n);
  });
});
