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
 *   - `untilTimestamp: T` ⇒ keep events with `e.timestamp <= T`. This relies on
 *     lexicographic `<=` matching chronological order, which holds only because
 *     store timestamps are normalized UTC `Z` ISO-8601 strings of uniform width
 *     (mixed UTC offsets or widths would break the lexical ordering). An event
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
import type { WorkflowEvent } from '../events/schemas.js';

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

/**
 * The public `asOf` param shape (`workflow/schemas.ts::AsOfSchema`): an
 * optional bound where BOTH keys are individually optional. The schema's
 * `.refine` already rejects a value carrying both keys, so by the time a
 * value reaches the dispatch core at most one key is set. This is the
 * loosely-typed sibling of {@link AsOfBound} (exactly-one), kept here so the
 * dispatch core has a single normalize-and-bound seam.
 */
export interface AsOfParam {
  readonly untilSequence?: number | undefined;
  readonly untilTimestamp?: string | undefined;
}

/**
 * Dispatch-core seam shared by the `get` and `view` `asOf` surfaces.
 *
 * Normalizes the schema-shaped {@link AsOfParam} (optional-both) into the
 * exactly-one {@link AsOfBound} and bounds `events` through {@link boundEvents}.
 * An omitted/empty param returns all events (a copy). A param carrying both
 * keys is rejected upstream by `AsOfSchema.refine`; should one slip through
 * (an internal caller bypassing the schema), {@link boundEvents} fails fast
 * with {@link MutuallyExclusiveBoundError}.
 *
 * Centralizing the normalization here keeps `get` and `view` bounding
 * byte-identical (INV-2 facade equivalence) — neither surface re-implements
 * the `untilSequence` / `untilTimestamp` branch.
 *
 * @param events - An ordered single-stream event list (not mutated).
 * @param asOf - Optional schema-shaped bound. Omitted/empty ⇒ all events.
 * @returns A new array of the retained events.
 */
export function resolveAsOfEvents(
  events: readonly WorkflowEvent[],
  asOf?: AsOfParam,
): WorkflowEvent[] {
  const bound = toAsOfBound(asOf);
  return boundEvents(events, bound);
}

/**
 * Normalize an optional-both {@link AsOfParam} into the exactly-one
 * {@link AsOfBound}. Returns `undefined` for an omitted or empty param.
 * Both-keys-present is preserved as a both-keys {@link AsOfBound} so
 * {@link boundEvents} surfaces the {@link MutuallyExclusiveBoundError} rather
 * than this helper silently preferring one.
 */
function toAsOfBound(asOf?: AsOfParam): AsOfBound | undefined {
  if (!asOf) return undefined;
  const hasSeq = asOf.untilSequence !== undefined;
  const hasTs = asOf.untilTimestamp !== undefined;
  if (hasSeq && hasTs) {
    // Defer to boundEvents' fail-fast (MutuallyExclusiveBoundError) by
    // returning the both-keys shape; the static AsOfBound type can't model it
    // so we widen through `unknown` at this single, documented seam.
    return asOf as unknown as AsOfBound;
  }
  if (hasSeq) return { untilSequence: asOf.untilSequence! };
  if (hasTs) return { untilTimestamp: asOf.untilTimestamp! };
  return undefined;
}
