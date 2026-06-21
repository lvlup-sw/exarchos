import { describe, it, expect } from 'vitest';
import type { WorkflowEvent } from '../event-store/schemas.js';
import {
  boundEvents,
  MutuallyExclusiveBoundError,
  type AsOfBound,
} from './cursor.js';

/**
 * T1 — `boundEvents` as-of cursor helper.
 *
 * `boundEvents` slices an already-ordered event list down to the events at or
 * before an as-of bound. The bound is either a stream sequence ceiling
 * (`untilSequence`) or a timestamp ceiling (`untilTimestamp`); the two are
 * mutually exclusive. Canonical ordering is `(timestamp, sequence)` — the same
 * ordering `EventStore.query` produces for a single stream — so for a single
 * stream `untilSequence: N` keeps `e.sequence <= N` and `untilTimestamp: T`
 * keeps `e.timestamp <= T` (ISO lexicographic compare), ties broken by
 * sequence.
 *
 * The helper performs no I/O and does not mutate its input.
 */

/**
 * Build a minimal but schema-shaped `WorkflowEvent` for cursor tests. Only the
 * fields `boundEvents` reads (`streamId`, `sequence`, `timestamp`, `type`) are
 * load-bearing; the rest carry schema-valid defaults.
 */
function ev(sequence: number, timestamp: string): WorkflowEvent {
  return {
    streamId: 'wf-cursor',
    sequence,
    timestamp,
    type: 'workflow.started',
    schemaVersion: '1.0',
  } as WorkflowEvent;
}

/**
 * A small, monotonic single-stream log: sequence 1..4 with strictly
 * increasing timestamps. Matches the `(timestamp, sequence)` ordering the
 * store guarantees per stream.
 */
const LOG: readonly WorkflowEvent[] = [
  ev(1, '2026-06-20T00:00:01.000Z'),
  ev(2, '2026-06-20T00:00:02.000Z'),
  ev(3, '2026-06-20T00:00:03.000Z'),
  ev(4, '2026-06-20T00:00:04.000Z'),
];

describe('boundEvents — as-of cursor over an ordered event list (T1)', () => {
  it('boundEvents_untilSequence_includesThroughBoundExcludesBeyond', () => {
    // GIVEN a 1..4 log and an untilSequence ceiling of 2.
    const bound: AsOfBound = { untilSequence: 2 };

    // WHEN we bound the log.
    const result = boundEvents(LOG, bound);

    // THEN events at sequence <= 2 are included; 3 and 4 are excluded.
    expect(result.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it('boundEvents_untilTimestamp_includesTiesBrokenBySequence', () => {
    // GIVEN a ceiling exactly equal to event 3's timestamp.
    const bound: AsOfBound = { untilTimestamp: '2026-06-20T00:00:03.000Z' };

    // WHEN we bound the log.
    const result = boundEvents(LOG, bound);

    // THEN the event AT exactly T is INCLUDED (<= semantics), and the later
    //   event 4 is excluded.
    expect(result.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it('boundEvents_boundPastTail_returnsAllEvents', () => {
    // GIVEN a sequence bound well past the tail (tail is sequence 4).
    const result = boundEvents(LOG, { untilSequence: 999 });

    // THEN every event is retained.
    expect(result.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);

    // AND the same holds for a timestamp bound past the tail.
    const byTs = boundEvents(LOG, { untilTimestamp: '2026-06-21T00:00:00.000Z' });
    expect(byTs.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
  });

  it('boundEvents_emptyOrUndefinedBound_returnsAllEvents', () => {
    // GIVEN no bound (undefined) ⇒ the full list, unchanged.
    const all = boundEvents(LOG);
    expect(all.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);

    // AND an empty input with no bound ⇒ an empty result.
    expect(boundEvents([])).toEqual([]);

    // AND the helper does not mutate its input (returns a copy).
    expect(all).not.toBe(LOG);
  });

  it('boundEvents_bothBoundsPresent_throwsMutuallyExclusive', () => {
    // GIVEN a bound object carrying BOTH keys (a programming error).
    const both = {
      untilSequence: 2,
      untilTimestamp: '2026-06-20T00:00:02.000Z',
    } as unknown as AsOfBound;

    // WHEN/THEN boundEvents rejects it with the dedicated error type.
    expect(() => boundEvents(LOG, both)).toThrow(MutuallyExclusiveBoundError);
  });
});
