/**
 * T-12 — `session.machinery_consumed` dispatch interceptor.
 *
 * Plan: docs/plans/archive/2026-05-08-rehydration-machinery-plan.md (T-12)
 * Design: docs/research/2026-05-08-rehydrate-machinery-reinit.md §11.4 (P4)
 *
 * On the first non-rehydrate L5 handler invocation that follows a
 * `workflow.rehydrated` event landing on a stream, this interceptor emits a
 * single `session.machinery_consumed` event correlating back to the
 * triggering rehydrate via `rehydrateSequence`. Subsequent invocations on
 * the same rehydrate-sequence are a no-op until another `workflow.rehydrated`
 * lands on the stream.
 *
 * Idempotency strategy:
 *   1. Process-local cache (`machineryConsumedCache`) avoids the per-dispatch
 *      double-emit cost: once we've emitted for sequence S on stream X, the
 *      cache short-circuits the next invocation.
 *   2. Per-call defensive query against the event store — if a previous
 *      process already emitted `session.machinery_consumed` for sequence S,
 *      we honor that even when our local cache is empty (e.g. cold start
 *      after restart).
 *   3. Idempotency key on the append: `session.machinery_consumed:${stream}:${sequence}`.
 *      The event-store's `UNIQUE INDEX (idempotency_key)` collapse converts a
 *      racing duplicate into a no-op. (T-13 will pin this property explicitly.)
 *
 * Short-circuits:
 *   - `action === 'rehydrate'`: rehydrate emits `workflow.rehydrated`, so
 *     reacting to the just-landed rehydrate from inside the same dispatch
 *     would loop.
 *   - missing `streamId` (no `featureId` on the dispatched args): no stream
 *     to correlate against — bail.
 *
 * Cost: one tail query per dispatch when the cache misses; zero on a cache
 * hit. The query is type-filtered so the event-store's index-on-type path
 * is exercised rather than a full stream scan.
 */

import type { EventStore } from '../../events/store.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import { workflowLogger } from '../../logger.js';

// ─── Process-local cache ───────────────────────────────────────────────────

/**
 * Map of `streamId` → the `rehydrateSequence` for which we've most recently
 * emitted `session.machinery_consumed`. The cache is purely an optimization:
 * the source-of-truth is the event log itself (queried on cache miss). The
 * cache resets on process restart, at which point the first dispatch
 * post-restart re-derives the latest state from the event store.
 *
 * Exported via the `__resetMachineryConsumedCache` test hook below; production
 * code does not mutate this map directly.
 */
const machineryConsumedCache = new Map<string, number>();

/**
 * Test-only hook to reset the per-stream cache between cases. Production
 * code must not call this — the cache is intentionally process-lifetime to
 * keep the interceptor cheap. Suite teardown invokes this so a stale cached
 * sequence from one test doesn't suppress emission in the next.
 */
export function __resetMachineryConsumedCache(): void {
  machineryConsumedCache.clear();
}

// ─── Helper: latest event of type ──────────────────────────────────────────

/**
 * Find the most-recent event of the given type on the stream. Returns
 * `undefined` when no event of that type exists on the stream.
 *
 * `EventStore.query()` returns events in sequence order (lowest first), so
 * the latest match is the LAST element of the filtered list. We don't pass
 * `limit: 1` because that would drop the tail — we explicitly want the
 * highest-sequence match.
 *
 * Exported so a future second interceptor (or a parity-harness test) can
 * reuse the same primitive.
 */
export async function findLatestEventOfType(
  eventStore: EventStore,
  streamId: string,
  type: string,
): Promise<WorkflowEvent | undefined> {
  const events = await eventStore.query(streamId, { type });
  if (events.length === 0) return undefined;
  return events[events.length - 1];
}

// ─── Interceptor entry point ───────────────────────────────────────────────

/**
 * Run the `session.machinery_consumed` interceptor for one dispatch call.
 *
 * Wired by `dispatch()` AFTER schema validation succeeds and BEFORE the
 * composite handler runs. Failures here are LOGGED-AND-SWALLOWED — the
 * observability emission must never turn a successful dispatch into a
 * failed one. Same posture as `workflow.rehydrated` emission inside
 * `handleRehydrate` (see workflow/rehydrate.ts ~line 576).
 *
 * @param eventStore  the per-context event store handle
 * @param streamId    the dispatched action's `featureId` (no-op when absent)
 * @param actionVerb  the action name being dispatched (e.g. `'get'`,
 *                    `'task_complete'`, `'rehydrate'`)
 */
export async function runSessionMachineryConsumedInterceptor(
  eventStore: EventStore,
  streamId: string | undefined,
  actionVerb: string,
): Promise<void> {
  // Short-circuit: no stream to correlate against.
  if (!streamId) return;

  // Short-circuit: rehydrate is the verb that EMITS workflow.rehydrated;
  // reacting to that emission from inside the same dispatch would loop.
  if (actionVerb === 'rehydrate') return;

  try {
    const latestRehydrated = await findLatestEventOfType(
      eventStore,
      streamId,
      'workflow.rehydrated',
    );
    if (!latestRehydrated) return;

    const rehydrateSequence = latestRehydrated.sequence;

    // Cache hit — already emitted for this rehydrate-sequence, nothing to do.
    if (machineryConsumedCache.get(streamId) === rehydrateSequence) {
      return;
    }

    // Cache miss — defensive event-store query. Covers cold-start restart
    // (cache empty but a prior process already emitted) and the race where
    // a sibling process emitted between our cache write and now.
    const latestMachinery = await findLatestEventOfType(
      eventStore,
      streamId,
      'session.machinery_consumed',
    );
    if (latestMachinery) {
      const machinerySeq = (latestMachinery.data as { rehydrateSequence?: number } | undefined)
        ?.rehydrateSequence;
      if (machinerySeq === rehydrateSequence) {
        // Already emitted in a prior process / sibling. Update the local
        // cache so future invocations on this stream short-circuit at the
        // cache layer.
        machineryConsumedCache.set(streamId, rehydrateSequence);
        return;
      }
    }

    // Emit. The idempotency key collapses any race on the event-store side
    // into a single durable event (T-13 pins this property explicitly).
    await eventStore.append(
      streamId,
      {
        type: 'session.machinery_consumed',
        data: {
          rehydrateSequence,
          firstActionVerb: actionVerb,
          firstActionAt: new Date().toISOString(),
        },
      },
      {
        idempotencyKey: `session.machinery_consumed:${streamId}:${rehydrateSequence}`,
      },
    );
    machineryConsumedCache.set(streamId, rehydrateSequence);
  } catch (err) {
    // Swallow — see header comment. The interceptor is observability scaffolding
    // for v2.11/v2.12 lifecycle queries; it must not propagate failures
    // into the dispatch return path. Emit a structured warn so the swallow
    // path is still visible to oncall (parity with handleRehydrate /
    // buildDegradedResponse). F-05.
    workflowLogger.warn(
      {
        streamId,
        actionVerb,
        err: err instanceof Error ? err.message : String(err),
      },
      'session-machinery interceptor swallowed error',
    );
  }
}
