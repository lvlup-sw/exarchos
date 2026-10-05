/**
 * `bisect` finds the first event at which a predicate over the projected state becomes true.
 * It is a binary search over the event sequences of one stream, so a returned `event` is always a real event.
 * Each probe is a {@link projectAt} fold at a candidate sequence.
 *
 * The predicate must be monotonic: after it is true at a sequence, it stays true at every later sequence.
 * For a predicate that is not monotonic, `bisect` returns one flip boundary, not every flip.
 * To find every transition of such a predicate, scan the stream linearly.
 *
 * The search does `O(log n)` probes. `projectAt` warm-starts a probe from the latest snapshot only when that snapshot is at or below the probe sequence.
 * Without a usable snapshot, a probe folds from the first event, so the worst total cost is `O(n log n)` reducer applies.
 * No public verb exposes `bisect`.
 */

// RESERVED(issue: #1555, owner: exarchos, expires: 2027-01-31) — dead stub, deleted at expiry if no caller adopts it.

import type { EventStore } from '../events/store.js';
import type { ProjectionReducer } from './types.js';
import type { WorkflowEvent } from '../events/schemas.js';
import { projectAt } from './rebuild.js';

/**
 * The flip boundary `bisect` locates: the first event at which the predicate
 * becomes true, paired with that event's stream sequence.
 */
export interface BisectResult {
  /** The stream sequence of the boundary event (where the predicate flipped). */
  readonly sequence: number;
  /** The boundary event itself — the event that caused the flip. */
  readonly event: WorkflowEvent;
}

/**
 * Binary-searches a stream for the first event at which `predicate(state)` is true.
 * The `state` is the projection folded through the sequence of that event.
 * The candidates are the real event sequences, so a gap in the sequence axis does no harm.
 * The loop keeps one invariant: the predicate is false before `lo`, and true at `hi` after `hi` narrows.
 *
 * @param predicate - Monotonic predicate over the projected state.
 * @returns The first flip boundary, or `null` when the stream is empty or the predicate never holds.
 */
export async function bisect<State, Event>(
  reducer: ProjectionReducer<State, Event>,
  eventStore: EventStore,
  streamId: string,
  predicate: (state: State) => boolean,
): Promise<BisectResult | null> {
  const events = await eventStore.query(streamId);
  if (events.length === 0) {
    return null;
  }

  let lo = 0;
  let hi = events.length;

  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const candidate = events[mid]!;
    const state = await projectAt<State, Event>(reducer, eventStore, streamId, {
      untilSequence: candidate.sequence,
    });
    if (predicate(state)) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }

  if (lo >= events.length) {
    return null;
  }

  const boundary = events[lo]!;
  return { sequence: boundary.sequence, event: boundary };
}
