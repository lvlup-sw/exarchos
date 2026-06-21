/**
 * `bisect` — binary search over the bounded-fold axis (T5, #1555).
 *
 * `git bisect` for workflow state: given a stream and a predicate over the
 * projected state, find the FIRST event at which the predicate becomes true.
 * Each probe is a warm-started {@link projectAt} at a candidate sequence, so the
 * search runs in `O(log n)` cheap folds rather than the `O(n)` of a linear
 * replay.
 *
 * ## Monotonicity contract
 *
 * `bisect` assumes the predicate is **monotonic** along the sequence axis: once
 * `predicate(projectAt(seq))` is true it stays true for every later `seq`
 * (false…false → true…true). Under that assumption `bisect` returns *the* first
 * flip boundary.
 *
 * If the predicate is **not** monotonic, `bisect` returns *a* flip boundary, not
 * *the only* flip — a non-monotonic predicate yields a misleading result. This
 * is by design (verbatim from design §9): "document the monotonicity contract;
 * `bisect` returns *a* flip, not *the only* flip". Callers needing every
 * transition of a non-monotonic predicate must scan linearly instead.
 *
 * ## Cost
 *
 * The candidate boundaries are the stream's own event sequences (read once via
 * `store.query`), so a returned `event` is always a real event. The search then
 * probes `O(log n)` of those candidates. When a projection snapshot exists,
 * `projectAt` warm-starts each probe from the nearest snapshot — a cheap
 * incremental fold rather than a full replay. With NO snapshot present each
 * probe cold-folds `events[0..mid]`, so the search costs `O(n log n)` total
 * `apply`s; the win there is still `O(log n)` *probes* to locate the boundary
 * (versus a linear predicate scan), and the warm-start path makes the probes
 * genuinely cheap once snapshots are in play.
 *
 * `bisect` is an internal projection primitive — it is not exposed as a public
 * verb (no `get`/`view` action) yet.
 */
import type { EventStore } from '../event-store/store.js';
import type { ProjectionReducer } from './types.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
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
 * Binary-search a stream for the first event at which `predicate(state)` flips
 * to true, where `state` is the projection folded as of that event's sequence.
 *
 * Returns the boundary `{ sequence, event }`, or `null` when the predicate is
 * never true through the tip (or the stream is empty — there is no event to
 * return as a boundary).
 *
 * Assumes a **monotonic** predicate; see the module-level monotonicity
 * contract. Each probe folds via
 * `projectAt(reducer, eventStore, streamId, { untilSequence: mid })`, so the
 * search is `O(log n)` warm-started folds.
 *
 * @typeParam State - The projected state type the reducer produces.
 * @typeParam Event - The event type the reducer consumes.
 * @param reducer - A stream-scoped {@link ProjectionReducer}.
 * @param eventStore - Initialised event store to read from.
 * @param streamId - The stream to search.
 * @param predicate - Monotonic predicate over the projected state.
 * @returns The first flip boundary, or `null` if the predicate never holds.
 */
export async function bisect<State, Event>(
  reducer: ProjectionReducer<State, Event>,
  eventStore: EventStore,
  streamId: string,
  predicate: (state: State) => boolean,
): Promise<BisectResult | null> {
  // The candidate boundaries are the stream's own event sequences, read once.
  // Using real event sequences (rather than the integer range [1..tail])
  // guarantees a returned boundary maps to an actual event and tolerates any
  // gaps in the sequence axis.
  const events = await eventStore.query(streamId);
  if (events.length === 0) {
    return null;
  }

  // Invariant maintained by the loop: predicate is false for every candidate
  // strictly before `lo`, and (once `hi` has been narrowed) true at `hi`.
  // We search the INDEX axis [0, length) over `events`; each probe folds via
  // `projectAt` at the candidate event's sequence.
  let lo = 0;
  let hi = events.length; // exclusive upper bound: `length` = "no flip found".

  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const candidate = events[mid];
    const state = await projectAt<State, Event>(reducer, eventStore, streamId, {
      untilSequence: candidate.sequence,
    });
    if (predicate(state)) {
      // Flip at or before `mid`: tighten the upper bound (keep `mid` in range).
      hi = mid;
    } else {
      // Still false at `mid`: the flip, if any, is strictly after `mid`.
      lo = mid + 1;
    }
  }

  // `lo === hi`. If it landed past the last event, the predicate never flipped.
  if (lo >= events.length) {
    return null;
  }

  const boundary = events[lo];
  return { sequence: boundary.sequence, event: boundary };
}
