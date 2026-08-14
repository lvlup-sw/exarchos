import { getDispatchContext } from '../../../dispatch/dispatch-context.js';
import type { WorkflowEvent } from '../../../events/schemas.js';
import { EventStore } from '../../../events/store.js';
import { logger } from '../../../logger.js';
import { ViewMaterializer } from '../materializer.js';

// ─── Helper: query delta events using materializer high-water mark ──────────

/**
 * Wave 5 (#1437) — view-action correlation filter passthrough.
 *
 * Telemetry view callers can pass `operationId / correlationId / causationId`
 * down to the underlying `EventStore.query` so the projection folds only the
 * slice that matches a dispatch-boundary tuple. The filter handle is the
 * indexed correlation columns on the SQLite substrate (a post-fetch JS
 * filter on the in-memory backend); INV-1 keeps the value of truth on the
 * payload, mirrored to the indexed columns.
 *
 * Cache semantics: a filtered query MUST bypass the materializer LRU cache.
 * The cached `view` baked in the unfiltered roll-up of every event past the
 * high-water mark; folding only a filtered subset on top of that base would
 * silently contaminate the cache (e.g. a `correlationId: cor-X` query would
 * leave the cache reading "everything except cor-Y"). Callers route through
 * `materializeFiltered` below when filters are present so the fold runs
 * from `projection.init()` against the filtered event list and the cache
 * is never written.
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
 * Wave 2 (#1448) — AsyncLocalStorage-aware default for correlation filters.
 *
 * Returns the explicit args verbatim if any are supplied (explicit-wins).
 * Otherwise, if a dispatch context is active, defaults `correlationId` to
 * the active dispatch's correlationId — the chain-stable anchor for the
 * current workflow scope. If no args AND no active context, returns empty.
 *
 * The default makes "show me telemetry for the workflow I'm in" Just Work
 * inside an agent dispatch without requiring the agent to thread the
 * correlation tuple back into every telemetry call.
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

/** @internal Exported for CLI commands and testing */
export async function queryDeltaEvents(
  store: EventStore,
  materializer: ViewMaterializer,
  streamId: string,
  viewName: string,
  filters?: ViewQueryFilters,
): Promise<WorkflowEvent[]> {
  // Wave 5 (#1437) — filtered queries bypass the cache entirely so the
  // hwm-relative incremental path can't bleed an unfiltered base into a
  // filtered fold. See ViewQueryFilters doc for the contamination scenario.
  if (hasCorrelationFilters(filters)) {
    return store.query(streamId, filters);
  }
  const cachedState = materializer.getState(streamId, viewName);
  if (cachedState) {
    // Warm call: only fetch events past the high-water mark
    const hwm = cachedState.highWaterMark;
    return hwm > 0
      ? store.query(streamId, { sinceSequence: hwm })
      : store.query(streamId);
  }
  // Cold call: load snapshot then query all events
  await materializer.loadFromSnapshot(streamId, viewName);
  return store.query(streamId);
}

/**
 * Cache-bypassing fold for correlation-filtered queries (Wave 5 / #1437).
 *
 * Reads the registered projection for `viewName`, builds a fresh
 * `projection.init()` base, and applies every event in the input list in
 * order. Never reads or writes the materializer LRU cache, so an unfiltered
 * call before or after retains the full roll-up untouched.
 */
export function materializeFiltered<T>(
  materializer: ViewMaterializer,
  viewName: string,
  events: WorkflowEvent[],
): T {
  // Delegates to the shared cache-bypassing fresh fold (#1555 consolidation).
  // `materializeFresh` records the bypass on every successful call so the
  // correlation-filtered traffic is visible alongside the LRU hit/miss stats —
  // without it, a healthy hitRate can mask thousands of cache-skipping calls
  // (PR #1447 DIM-2 audit) — and never touches the LRU cache.
  return materializer.materializeFresh<T>(viewName, events);
}
