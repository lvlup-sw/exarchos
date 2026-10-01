/**
 * The `session.machinery_consumed` dispatch interceptor. On the first non-rehydrate handler call
 * after a `workflow.rehydrated` event on a stream, it emits one `session.machinery_consumed`
 * event. The event carries the `rehydrateSequence` of that rehydrate.
 *
 * Three layers prevent a duplicate. A process-local cache short-circuits a repeat call. On a cache
 * miss, a query of the event store finds an emission from an earlier process. The idempotency
 * key on the append collapses a race into one durable event.
 *
 * The interceptor skips a call with no stream and a `rehydrate` call, because rehydrate emits
 * `workflow.rehydrated` and a reaction in the same dispatch loops.
 */

import type { EventStore } from '../../../events/store.js';
import type { WorkflowEvent } from '../../../events/schemas.js';
import { workflowLogger } from '../../../logger.js';

/**
 * The `rehydrateSequence` of the last `session.machinery_consumed` emission for each stream. The
 * cache is only an optimization. The event log is the source of truth, and a cache miss queries it.
 */
const machineryConsumedCache = new Map<string, number>();

/**
 * Test hook that clears the per-stream cache between cases. Production code must not call it,
 * because the cache lives for the whole process to keep the interceptor cheap.
 */
export function __resetMachineryConsumedCache(): void {
  machineryConsumedCache.clear();
}

/**
 * Returns the latest event of the given type on the stream, or `undefined`. `EventStore.query()`
 * returns events from the lowest sequence up, so the latest match is the last element.
 * `limit: 1` keeps the first match and not the last, so the query does not use it.
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

/**
 * Runs the interceptor for one dispatch call, after schema validation and before the composite
 * handler. It logs a failure as a warning and swallows it, so the emission never fails a dispatch.
 *
 * @param eventStore  the event store of the context
 * @param streamId    the `featureId` of the dispatched action. The call is a no-op without it.
 * @param actionVerb  the dispatched action name, for example `'get'` or `'rehydrate'`
 */
export async function runSessionMachineryConsumedInterceptor(
  eventStore: EventStore,
  streamId: string | undefined,
  actionVerb: string,
): Promise<void> {
  if (!streamId) return;

  if (actionVerb === 'rehydrate') return;

  try {
    const latestRehydrated = await findLatestEventOfType(
      eventStore,
      streamId,
      'workflow.rehydrated',
    );
    if (!latestRehydrated) return;

    const rehydrateSequence = latestRehydrated.sequence;

    if (machineryConsumedCache.get(streamId) === rehydrateSequence) {
      return;
    }

    const latestMachinery = await findLatestEventOfType(
      eventStore,
      streamId,
      'session.machinery_consumed',
    );
    if (latestMachinery) {
      const machinerySeq = (latestMachinery.data as { rehydrateSequence?: number } | undefined)
        ?.rehydrateSequence;
      if (machinerySeq === rehydrateSequence) {
        machineryConsumedCache.set(streamId, rehydrateSequence);
        return;
      }
    }

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
