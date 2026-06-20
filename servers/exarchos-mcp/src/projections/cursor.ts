/**
 * As-of cursor over an ordered event list (T1, #1555 bounded-fold primitive).
 *
 * `boundEvents` slices an already-ordered single-stream event list down to the
 * events at or before an as-of bound, the building block the bounded-fold
 * primitive (`projectAt`) folds over for time-travel reads.
 *
 * ## Ordering contract
 *
 * The input is assumed to already be in **`(timestamp, sequence)`** order — the
 * exact ordering `EventStore.query(streamId)` produces for a single stream (see
 * `event-store/store.ts`). For a single stream `sequence` is monotonic and
 * `timestamp` is non-decreasing, so the two bound forms reduce to a simple
 * inclusive filter:
 *
 *   - `untilSequence: N` ⇒ keep events with `e.sequence <= N`.
 *   - `untilTimestamp: T` ⇒ keep events with `e.timestamp <= T`
 *     (ISO-8601 strings compare correctly under lexicographic `<=`); an event
 *     whose timestamp equals `T` is INCLUDED. Ties at the same timestamp are
 *     already ordered by sequence in the input, so no re-sort is needed.
 *
 * The two forms are mutually exclusive — a bound carrying both keys is a
 * programming error and raises {@link MutuallyExclusiveBoundError}.
 *
 * ## Purity
 *
 * `boundEvents` performs no I/O and never mutates its input. When a bound is
 * given it returns a filtered copy; with no bound it returns a shallow copy of
 * the input so callers can never alias (and thus mutate) the source array.
 */
import type { WorkflowEvent } from '../event-store/schemas.js';

/**
 * An as-of bound: either a stream-sequence ceiling or a timestamp ceiling.
 *
 * The union is exclusive by construction — a value should carry exactly one of
 * the two keys. A value carrying both is rejected at runtime by
 * {@link boundEvents} (the static type cannot forbid extra keys on a structural
 * object literal).
 */
export type AsOfBound =
  | { untilSequence: number }
  | { untilTimestamp: string };

/**
 * Raised when an {@link AsOfBound} value carries BOTH `untilSequence` and
 * `untilTimestamp`. The two ceilings are mutually exclusive; supplying both is
 * ambiguous, so the helper fails fast rather than silently preferring one.
 */
export class MutuallyExclusiveBoundError extends Error {
  constructor() {
    super(
      'AsOfBound must carry exactly one of untilSequence or untilTimestamp, not both',
    );
    this.name = 'MutuallyExclusiveBoundError';
  }
}

function hasUntilSequence(
  bound: AsOfBound,
): bound is { untilSequence: number } {
  return (bound as { untilSequence?: unknown }).untilSequence !== undefined;
}

function hasUntilTimestamp(
  bound: AsOfBound,
): bound is { untilTimestamp: string } {
  return (bound as { untilTimestamp?: unknown }).untilTimestamp !== undefined;
}

/**
 * Slice `events` down to those at or before `bound`.
 *
 * The input is assumed to already be in `(timestamp, sequence)` order (the
 * single-stream `EventStore.query` ordering). With no bound the full list is
 * returned (as a copy). See the module-level docs for the ordering contract.
 *
 * @param events - An ordered single-stream event list (not mutated).
 * @param bound - Optional as-of ceiling. Omitted/undefined ⇒ return all events.
 * @returns A new array of the retained events.
 * @throws {MutuallyExclusiveBoundError} when `bound` carries both keys.
 */
export function boundEvents(
  events: readonly WorkflowEvent[],
  bound?: AsOfBound,
): WorkflowEvent[] {
  if (bound === undefined) {
    return [...events];
  }

  const hasSeq = hasUntilSequence(bound);
  const hasTs = hasUntilTimestamp(bound);
  if (hasSeq && hasTs) {
    throw new MutuallyExclusiveBoundError();
  }

  if (hasSeq) {
    const ceiling = bound.untilSequence;
    return events.filter((e) => e.sequence <= ceiling);
  }

  // hasTs: ISO-8601 strings compare correctly under lexicographic `<=`; the
  // event whose timestamp equals the ceiling is included.
  const ceiling = bound.untilTimestamp;
  return events.filter((e) => e.timestamp <= ceiling);
}
