import { getDispatchContext } from '../../../dispatch/dispatch-context.js';
import type { WorkflowEvent } from '../../../events/schemas.js';
import { EventStore } from '../../../events/store.js';
import { logger } from '../../../logger.js';
import { ViewMaterializer } from '../materializer.js';

/**
 * Correlation filters that a view passes down to `EventStore.query`, so the projection folds only the matching events.
 * A filtered query must not use the materializer cache. The cached view holds the unfiltered fold, and a filtered fold on top of it corrupts the cache.
 * Thus a filtered caller folds through {@link materializeFiltered}, which starts from `projection.init()` and does not write the cache.
 */
export interface ViewQueryFilters {
  readonly operationId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

/**
 * @internal Returns true when any correlation filter field is present, so the
 * handler must take the cache-bypass branch.
 */
export function hasCorrelationFilters(filters?: ViewQueryFilters): boolean {
  if (!filters) return false;
  return (
    filters.operationId !== undefined ||
    filters.correlationId !== undefined ||
    filters.causationId !== undefined
  );
}

/**
 * Returns the explicit filter args when any is set.
 * Otherwise, inside an active dispatch context, it returns the `correlationId` of that dispatch, so an agent sees the telemetry of its own workflow.
 * With no args and no context, it returns an empty object.
 */
export function deriveCorrelationFilters(args: {
  operationId?: string | undefined;
  correlationId?: string | undefined;
  causationId?: string | undefined;
}): ViewQueryFilters {
  const explicit: ViewQueryFilters = {
    ...(args.operationId !== undefined ? { operationId: args.operationId } : {}),
    ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
    ...(args.causationId !== undefined ? { causationId: args.causationId } : {}),
  };
  if (Object.keys(explicit).length > 0) {
    return explicit;
  }
  const ctx = getDispatchContext();
  if (ctx) {
    logger.debug(
      { source: 'ctx-default', correlationId: ctx.correlationId },
      'deriveCorrelationFilters: defaulted correlationId from active dispatch context',
    );
    return { correlationId: ctx.correlationId };
  }
  return {};
}

/**
 * Returns the events that the fold of `viewName` needs.
 * A filtered query returns all matching events and skips the cache. A warm cache gets only the events after its high-water mark.
 * A cold cache loads the snapshot first, then returns all events.
 *
 * @internal Exported for CLI commands and testing
 */
export async function queryDeltaEvents(
  store: EventStore,
  materializer: ViewMaterializer,
  streamId: string,
  viewName: string,
  filters?: ViewQueryFilters,
): Promise<WorkflowEvent[]> {
  if (hasCorrelationFilters(filters)) {
    return store.query(streamId, filters);
  }
  const cachedState = materializer.getState(streamId, viewName);
  if (cachedState) {
    const hwm = cachedState.highWaterMark;
    return hwm > 0
      ? store.query(streamId, { sinceSequence: hwm })
      : store.query(streamId);
  }
  await materializer.loadFromSnapshot(streamId, viewName);
  return store.query(streamId);
}

/**
 * Folds `events` from `projection.init()` for a correlation-filtered query.
 * It does not read or write the LRU cache, but it adds 1 to the `bypasses` count of the cache stats.
 */
export function materializeFiltered<T>(
  materializer: ViewMaterializer,
  viewName: string,
  events: WorkflowEvent[],
): T {
  return materializer.materializeFresh<T>(viewName, events);
}
