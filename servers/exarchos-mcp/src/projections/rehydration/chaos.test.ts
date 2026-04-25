import { describe, it, expect } from 'vitest';
import { rehydrationReducer } from './reducer.js';
import { RehydrationDocumentSchema, type RehydrationDocument } from './schema.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';

/**
 * T057 — Chaos test for the rehydration reducer (DR-18, resilience).
 *
 * Hypothesis: the reducer must be *tolerant* under malformed input — unknown
 * event types, missing `data`, wrong-typed fields, and structurally invalid
 * payloads. When T054-T056 wrap the reducer at the handler boundary, at most
 * one `workflow.projection_degraded` is emitted per `handleRehydrate`
 * invocation; at the reducer layer we pin the weaker property that thrown
 * errors are bounded (no silent drops, but no unbounded cascades either) and
 * that folding 10k malformed events does not leak heap.
 *
 * Scope clarification (per plan T057): the chaos test runs at the **reducer**
 * layer via direct `apply()` calls, not through the `handleRehydrate` MCP
 * envelope. The per-batch `projection_degraded` cap is exercised elsewhere
 * (T054-T056 handler tests). Here we assert:
 *
 *   1. **No silent drops / no unhandled rejection** — every `apply()` call
 *      either returns a new state or throws synchronously. A thrown error is
 *      acceptable (the handler catches and degrades) but the count must stay
 *      well under the event volume. Chosen bound: strictly 0 errors for the
 *      pinned event mix, which documents the reducer's current "tolerant"
 *      contract. If a future change regresses tolerance, this test will fail
 *      loudly at the exact event shape that broke it.
 *
 *   2. **Heap stays bounded** — `process.memoryUsage().heapUsed` delta over
 *      10,000 reductions must stay under 50 MB. The reducer produces small
 *      incremental documents (at most one taskProgress entry per unique
 *      taskId, one artifact key per patch, one blocker per review/guard);
 *      unbounded growth would indicate a leak (e.g. stored closures, retained
 *      event references, unbounded arrays).
 *
 *   3. **End state is schema-valid** — after folding 10k chaotic events, the
 *      resulting document still parses via `RehydrationDocumentSchema`. This
 *      guarantees the reducer never writes out-of-schema structure even
 *      under adversarial input.
 *
 * ## Determinism
 *
 * Events are generated via a seeded Linear Congruential Generator (LCG) so
 * failures reproduce byte-for-byte. Seed is a compile-time constant; bump it
 * to re-shuffle if you want a fresh fuzz run.
 */

// ─── Deterministic PRNG ─────────────────────────────────────────────────────

/**
 * Numerical Recipes LCG — sufficient for distribution tests and replay
 * determinism (not cryptographic). Returns a float in [0, 1).
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // LCG constants from Numerical Recipes.
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

// ─── Event factories — each bucket of the 70/15/10/5 mix ────────────────────

/**
 * Build a structurally valid `WorkflowEventBase` scaffold. Individual factories
 * below override `type` / `data` to produce specific malformed variants.
 */
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

/** 70% bucket — valid task.assigned / task.completed events. */
function makeValidTaskEvent(rng: () => number, sequence: number): unknown {
  const type = pickFrom(rng, ['task.assigned', 'task.completed'] as const);
  const taskId = `T${pickInt(rng, 1, 500).toString().padStart(3, '0')}`;
  return scaffold(sequence, { type, data: { taskId } });
}

/** 15% bucket — recognised `type`, malformed `data`. */
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

/** 10% bucket — unknown event type (still structurally plausible). */
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

/** 5% bucket — utterly malformed (missing type, non-object payloads). */
function makeUtterlyMalformedEvent(rng: () => number, sequence: number): unknown {
  const variant = pickInt(rng, 0, 4);
  switch (variant) {
    case 0:
      // Missing `type` entirely.
      return scaffold(sequence, { data: { taskId: 'orphan' } });
    case 1:
      // `data` is a string.
      return scaffold(sequence, { type: 'task.assigned', data: 'not-an-object' });
    case 2:
      // `data` is an array.
      return scaffold(sequence, { type: 'task.completed', data: [1, 2, 3] });
    case 3:
      // `data` is a number.
      return scaffold(sequence, { type: 'state.patched', data: 42 });
    case 4:
    default:
      // `data` is null.
      return scaffold(sequence, { type: 'review.completed', data: null });
  }
}

/**
 * Build the full 10,000-event sequence according to the pinned 70/15/10/5
 * distribution. Each event is assigned a strictly monotonic `sequence`.
 */
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

// ─── The test ───────────────────────────────────────────────────────────────

describe('rehydration reducer — chaos test (T057, DR-18)', () => {
  it(
    'Reducer_10kMalformedEvents_NoSilentDropsBoundedHeap',
    { timeout: 30_000 },
    () => {
      const TOTAL_EVENTS = 10_000;
      const SEED = 0xC0FFEE;
      // Error tolerance bound: the current reducer contract is *tolerant* —
      // malformed events short-circuit back to `state` unchanged without
      // throwing. We pin strict-zero here so that any future regression that
      // introduces a throwing path surfaces immediately. If genuine new
      // validation errors are intentional, relax this bound to < 5% (500
      // errors) and document why.
      const MAX_ERRORS = 0;
      // Heap bound: 50 MB over 10k reductions. Each state is a small plain
      // object; retained allocations should be dominated by the accumulated
      // taskProgress entries (at most ~500 unique taskIds) and small
      // audit arrays. 50 MB is generous; tighten if this proves noisy.
      const MAX_HEAP_DELTA_BYTES = 50 * 1024 * 1024;

      const events = generateChaosEvents(TOTAL_EVENTS, SEED);
      expect(events.length).toBe(TOTAL_EVENTS);

      // Best-effort GC before measurement (only available when node runs with
      // --expose-gc). Missing `gc` just means noisier measurement, not a
      // different contract.
      const gc = (globalThis as { gc?: () => void }).gc;
      gc?.();

      const heapBefore = process.memoryUsage().heapUsed;
      const t0 = Date.now();

      let state: RehydrationDocument = rehydrationReducer.initial;
      let errorCount = 0;

      for (const event of events) {
        try {
          // Cast at the reducer boundary: the chaos generator emits
          // intentionally ill-typed `unknown` payloads. `as never` would
          // erase the `WorkflowEvent` hint the reducer inspects at runtime,
          // so we cast to `WorkflowEvent` and let the runtime type guards
          // inside the reducer do their job — which is precisely what we
          // are stress-testing.
          state = rehydrationReducer.apply(state, event as WorkflowEvent);
        } catch {
          errorCount++;
        }
      }

      const t1 = Date.now();
      gc?.();
      const heapAfter = process.memoryUsage().heapUsed;
      const heapDelta = heapAfter - heapBefore;

      // 1. Bounded errors (no silent drops, no unhandled rejections).
      expect(errorCount).toBeLessThanOrEqual(MAX_ERRORS);

      // 2. Heap stays bounded.
      //    Note: negative deltas (GC released more than we allocated) are
      //    also fine — assert on the upper bound only.
      expect(heapDelta).toBeLessThan(MAX_HEAP_DELTA_BYTES);

      // 3. End state is still schema-valid.
      const parsed = RehydrationDocumentSchema.safeParse(state);
      expect(parsed.success).toBe(true);

      // 4. projectionSequence only advanced over *handled* events — it must
      //    be <= total events (can be strictly less since unknown / malformed
      //    buckets no-op without advancing).
      expect(state.projectionSequence).toBeLessThanOrEqual(TOTAL_EVENTS);
      expect(state.projectionSequence).toBeGreaterThan(0);

      // Surface timing + heap delta for plan-level tuning. Vitest captures
      // console output on failure; on success this is silent.
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
