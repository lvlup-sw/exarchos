/**
 * Chaos test for the rehydration reducer. It calls `apply` directly on 10,000 seeded events.
 * 70% are valid task events, and 15% have a known type with malformed `data`. 10% have an unknown
 * type, and 5% have no `type` or a non-object `data`. The seed is a constant, so a failure is reproducible.
 *
 * The test pins three properties. The reducer throws on none of the events. The heap grows by
 * less than 50 MB. The final document parses with `RehydrationDocumentSchema`.
 */
import { describe, it, expect } from 'vitest';
import { rehydrationReducer } from '../../../../src/projections/rehydration/reducer.js';
import { RehydrationDocumentSchema, type RehydrationDocument } from '../../../../src/projections/rehydration/schema.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';

/** A linear congruential generator with the Numerical Recipes constants. It returns a float in [0, 1) and is not cryptographic. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pickInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pickFrom<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

/** A structurally valid event base. Each factory overrides `type`, `data` or both. */
function scaffold(
  sequence: number,
  overrides: { type?: string; data?: unknown },
): unknown {
  return {
    streamId: 'wf-chaos',
    sequence,
    timestamp: '2026-04-24T00:00:00.000Z',
    schemaVersion: '1.0',
    ...overrides,
  };
}

/** The 70% bucket: a valid `task.assigned` or `task.completed` event. */
function makeValidTaskEvent(rng: () => number, sequence: number): unknown {
  const type = pickFrom(rng, ['task.assigned', 'task.completed'] as const);
  const taskId = `T${pickInt(rng, 1, 500).toString().padStart(3, '0')}`;
  return scaffold(sequence, { type, data: { taskId } });
}

/** The 15% bucket: a known `type` with malformed `data`. */
function makeMalformedDataEvent(rng: () => number, sequence: number): unknown {
  const type = pickFrom(
    rng,
    [
      'task.assigned',
      'task.completed',
      'task.failed',
      'workflow.started',
      'workflow.transition',
      'state.patched',
      'review.completed',
    ] as const,
  );
  const variant = pickInt(rng, 0, 5);
  let data: unknown;
  switch (variant) {
    case 0:
      data = {};
      break;
    case 1:
      data = { taskId: null };
      break;
    case 2:
      data = { taskId: 12345 };
      break;
    case 3:
      data = { taskId: '' };
      break;
    case 4:
      data = { featureId: 42, workflowType: false };
      break;
    case 5:
      data = { patch: 'not-an-object', verdict: []  };
      break;
  }
  return scaffold(sequence, { type, data });
}

/** The 10% bucket: an unknown event type. */
function makeUnknownTypeEvent(rng: () => number, sequence: number): unknown {
  const type = pickFrom(
    rng,
    [
      'random.gibberish',
      'foo.bar',
      'nonexistent.event',
      'test.unknown',
      'legacy.removed',
    ] as const,
  );
  return scaffold(sequence, { type, data: { random: rng() } });
}

/** The 5% bucket: an event with no `type`, or with `data` that is a string, an array, a number or `null`. */
function makeUtterlyMalformedEvent(rng: () => number, sequence: number): unknown {
  const variant = pickInt(rng, 0, 4);
  switch (variant) {
    case 0:
      return scaffold(sequence, { data: { taskId: 'orphan' } });
    case 1:
      return scaffold(sequence, { type: 'task.assigned', data: 'not-an-object' });
    case 2:
      return scaffold(sequence, { type: 'task.completed', data: [1, 2, 3] });
    case 3:
      return scaffold(sequence, { type: 'state.patched', data: 42 });
    case 4:
    default:
      return scaffold(sequence, { type: 'review.completed', data: null });
  }
}

/** Builds `total` events with the 70/15/10/5 distribution. Each event gets a strictly increasing `sequence`. */
function generateChaosEvents(total: number, seed: number): readonly unknown[] {
  const rng = makeRng(seed);
  const events: unknown[] = [];
  for (let i = 0; i < total; i++) {
    const roll = rng();
    let event: unknown;
    if (roll < 0.7) {
      event = makeValidTaskEvent(rng, i);
    } else if (roll < 0.85) {
      event = makeMalformedDataEvent(rng, i);
    } else if (roll < 0.95) {
      event = makeUnknownTypeEvent(rng, i);
    } else {
      event = makeUtterlyMalformedEvent(rng, i);
    }
    events.push(event);
  }
  return events;
}

describe('rehydration reducer — chaos test (T057, DR-18)', () => {
  /**
   * `MAX_ERRORS` is 0: the reducer returns `state` unchanged for a malformed event and does not throw.
   * The heap limit is generous, because the state holds at most 500 task entries.
   * `gc` exists only when node runs with `--expose-gc`. Without it, the heap measurement has more noise.
   * `projectionSequence` counts only the handled events, so it can be less than the event count.
   */
  it(
    'Reducer_10kMalformedEvents_NoSilentDropsBoundedHeap',
    { timeout: 30_000 },
    () => {
      const TOTAL_EVENTS = 10_000;
      const SEED = 0xC0FFEE;
      const MAX_ERRORS = 0;
      const MAX_HEAP_DELTA_BYTES = 50 * 1024 * 1024;

      const events = generateChaosEvents(TOTAL_EVENTS, SEED);
      expect(events.length).toBe(TOTAL_EVENTS);

      const gc = (globalThis as { gc?: () => void }).gc;
      gc?.();

      const heapBefore = process.memoryUsage().heapUsed;
      const t0 = Date.now();

      let state: RehydrationDocument = rehydrationReducer.initial;
      let errorCount = 0;

      for (const event of events) {
        try {
          state = rehydrationReducer.apply(state, event as WorkflowEvent);
        } catch {
          errorCount++;
        }
      }

      const t1 = Date.now();
      gc?.();
      const heapAfter = process.memoryUsage().heapUsed;
      const heapDelta = heapAfter - heapBefore;

      expect(errorCount).toBeLessThanOrEqual(MAX_ERRORS);

      expect(heapDelta).toBeLessThan(MAX_HEAP_DELTA_BYTES);

      const parsed = RehydrationDocumentSchema.safeParse(state);
      expect(parsed.success).toBe(true);

      expect(state.projectionSequence).toBeLessThanOrEqual(TOTAL_EVENTS);
      expect(state.projectionSequence).toBeGreaterThan(0);

      if (process.env['CHAOS_REPORT']) {
        console.log(
          `[chaos] events=${TOTAL_EVENTS} errors=${errorCount} ` +
            `heapDeltaBytes=${heapDelta} durationMs=${t1 - t0} ` +
            `projectionSequence=${state.projectionSequence}`,
        );
      }
    },
  );
});
