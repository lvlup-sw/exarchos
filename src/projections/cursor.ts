/**
 * As-of cursor over an ordered event list, for time-travel reads.
 *
 * The input must be in `(timestamp, sequence)` order, the order that `EventStore.query(streamId)` returns.
 * In one stream, `sequence` increases and `timestamp` does not decrease, so each bound is an inclusive filter.
 * A timestamp bound uses a lexical `<=`. This is correct only because store timestamps are UTC `Z` ISO-8601 strings of one width.
 * An event at the bound is kept. The functions do no I/O and do not mutate the input.
 */
import type { WorkflowEvent } from '../events/schemas.js';

/**
 * An as-of bound: a stream-sequence ceiling or a timestamp ceiling.
 * The static type cannot forbid a value with both keys, so {@link boundEvents} rejects it at runtime.
 */
export type AsOfBound =
  | { untilSequence: number }
  | { untilTimestamp: string };

/** Thrown when an {@link AsOfBound} value has both `untilSequence` and `untilTimestamp`. */
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
 * Returns the events at or before `bound` as a new array.
 * With no bound, it returns a copy of all events.
 *
 * @throws {MutuallyExclusiveBoundError} when `bound` has both keys.
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

  const ceiling = bound.untilTimestamp;
  return events.filter((e) => e.timestamp <= ceiling);
}

/**
 * The public `asOf` param shape of `AsOfSchema` in `workflow/schemas.ts`. Both keys are optional.
 * The schema rejects a value with both keys.
 */
export interface AsOfParam {
  readonly untilSequence?: number | undefined;
  readonly untilTimestamp?: string | undefined;
}

/**
 * Bounds `events` by the schema-shaped `asOf` param, and returns a new array.
 * The `get` and `view` surfaces both use this function, so they bound events identically.
 * An omitted or empty param keeps all events. A param with both keys throws {@link MutuallyExclusiveBoundError}.
 */
export function resolveAsOfEvents(
  events: readonly WorkflowEvent[],
  asOf?: AsOfParam,
): WorkflowEvent[] {
  const bound = toAsOfBound(asOf);
  return boundEvents(events, bound);
}

/**
 * Converts an {@link AsOfParam} into an {@link AsOfBound}, or `undefined` when no key is set.
 * A param with both keys passes through unchanged so that {@link boundEvents} throws for it.
 * The type cannot hold both keys, so that case casts through `unknown`.
 */
function toAsOfBound(asOf?: AsOfParam): AsOfBound | undefined {
  if (!asOf) return undefined;
  const hasSeq = asOf.untilSequence !== undefined;
  const hasTs = asOf.untilTimestamp !== undefined;
  if (hasSeq && hasTs) {
    return asOf as unknown as AsOfBound;
  }
  if (hasSeq) return { untilSequence: asOf.untilSequence! };
  if (hasTs) return { untilTimestamp: asOf.untilTimestamp! };
  return undefined;
}
