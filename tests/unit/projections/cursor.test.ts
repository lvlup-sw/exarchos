/**
 * Tests for `boundEvents`, the as-of cursor over an ordered event list.
 * A bound is a sequence ceiling or a timestamp ceiling, and each ceiling is inclusive.
 */

import { describe, it, expect } from 'vitest';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import {
  boundEvents,
  MutuallyExclusiveBoundError,
  type AsOfBound,
} from '../../../src/projections/cursor.js';

/** Builds an event for the cursor tests. `boundEvents` reads only `sequence` and `timestamp`. */
function ev(sequence: number, timestamp: string): WorkflowEvent {
  return {
    streamId: 'wf-cursor',
    sequence,
    timestamp,
    type: 'workflow.started',
    schemaVersion: '1.0',
  } as WorkflowEvent;
}

/** One stream in sequence order, with strictly increasing timestamps. */
const LOG: readonly WorkflowEvent[] = [
  ev(1, '2026-06-20T00:00:01.000Z'),
  ev(2, '2026-06-20T00:00:02.000Z'),
  ev(3, '2026-06-20T00:00:03.000Z'),
  ev(4, '2026-06-20T00:00:04.000Z'),
];

describe('boundEvents — as-of cursor over an ordered event list (T1)', () => {
  it('boundEvents_untilSequence_includesThroughBoundExcludesBeyond', () => {
    const bound: AsOfBound = { untilSequence: 2 };

    const result = boundEvents(LOG, bound);

    expect(result.map((e) => e.sequence)).toEqual([1, 2]);
  });

  /** The ceiling equals the timestamp of event 3, so the inclusive bound keeps that event. */
  it('boundEvents_untilTimestamp_includesTiesBrokenBySequence', () => {
    const bound: AsOfBound = { untilTimestamp: '2026-06-20T00:00:03.000Z' };

    const result = boundEvents(LOG, bound);

    expect(result.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it('boundEvents_boundPastTail_returnsAllEvents', () => {
    const result = boundEvents(LOG, { untilSequence: 999 });

    expect(result.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);

    const byTs = boundEvents(LOG, { untilTimestamp: '2026-06-21T00:00:00.000Z' });
    expect(byTs.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
  });

  /** With no bound, the result is a copy of the input and not the same array. */
  it('boundEvents_emptyOrUndefinedBound_returnsAllEvents', () => {
    const all = boundEvents(LOG);
    expect(all.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);

    expect(boundEvents([])).toEqual([]);

    expect(all).not.toBe(LOG);
  });

  /** A bound with both keys is a programming error, and `boundEvents` rejects it at runtime. */
  it('boundEvents_bothBoundsPresent_throwsMutuallyExclusive', () => {
    const both = {
      untilSequence: 2,
      untilTimestamp: '2026-06-20T00:00:02.000Z',
    } as unknown as AsOfBound;

    expect(() => boundEvents(LOG, both)).toThrow(MutuallyExclusiveBoundError);
  });
});
