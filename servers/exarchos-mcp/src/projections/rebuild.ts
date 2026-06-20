/**
 * Generic projection rebuild helper (T029, DR-1, DR-18).
 *
 * Folds a {@link ProjectionReducer} over a stream's full event log starting
 * at sequence 0, returning the resulting `State`. Used by the rehydrate MCP
 * handler (T031) as the degraded / cold-cache fallback whenever the
 * snapshot sidecar is missing, corrupt, or version-skewed. The helper does
 * not consult snapshots or sidecar files — it is the canonical source of
 * truth when the cache is untrustworthy (DR-18).
 *
 * ## Event-store surface
 *
 * Reads the stream exclusively via `EventStore.query(streamId)`, which
 * returns events in sequence order and transparently merges any active
 * sidecar files (see `store.ts`). The helper therefore sees every durable
 * and in-flight event a live reader would, preserving replay fidelity
 * under contention.
 *
 * ## Purity
 *
 * The helper itself performs no I/O beyond the single `query` call and no
 * mutation of its inputs. All determinism guarantees flow through the
 * reducer's purity contract (see `ProjectionReducer.apply`).
 */
import type { EventStore } from '../event-store/store.js';
import type { ProjectionReducer } from './types.js';
import {
  defaultRegistry,
  type ProjectionRegistry,
} from './registry.js';
import { boundEvents, type AsOfBound } from './cursor.js';

/**
 * Optional overrides for {@link rebuildProjection}.
 *
 * Only meaningful when `rebuildProjection` is called with a projection id
 * string — `registry` selects the lookup source. Defaults to the
 * process-wide {@link defaultRegistry} so production call sites need not
 * thread it through.
 */
export interface RebuildProjectionOptions {
  /**
   * Registry to resolve a projection id against. Defaults to
   * {@link defaultRegistry}. Tests needing isolation inject a fresh
   * registry created via `createRegistry()`.
   */
  readonly registry?: ProjectionRegistry;
}

/**
 * Error raised when `rebuildProjection` is passed a projection id that is
 * not present in the resolution registry. Surfaces as a structured error so
 * the rehydrate handler (T031) can translate it to a degraded-mode response
 * (DR-18) rather than silently returning an initial-state document.
 */
export class UnknownProjectionIdError extends Error {
  constructor(public readonly projectionId: string) {
    super(`unknown projection id: ${projectionId}`);
    this.name = 'UnknownProjectionIdError';
  }
}

/**
 * Rebuild a projection's state by folding its reducer over every event in
 * `streamId`, starting from sequence 0.
 *
 * Two call shapes:
 *
 * 1. **Direct reducer form** — pass a `ProjectionReducer<State, Event>`.
 *    The return type is `Promise<State>` with full type parametricity.
 * 2. **Registry form** — pass a projection id string; the reducer is
 *    resolved via `options.registry` (default: {@link defaultRegistry}).
 *    Because the registry stores reducers as
 *    `ProjectionReducer<unknown, unknown>`, the return type is
 *    `Promise<unknown>`. Callers that need a narrower type should use the
 *    direct reducer form or type-guard the result.
 *
 * @throws {UnknownProjectionIdError} if the id form is used and the id is
 *   not registered. Propagates any error raised by `eventStore.query` or by
 *   the reducer itself.
 */
export function rebuildProjection<State, Event>(
  reducer: ProjectionReducer<State, Event>,
  eventStore: EventStore,
  streamId: string,
): Promise<State>;
export function rebuildProjection(
  projectionId: string,
  eventStore: EventStore,
  streamId: string,
  options?: RebuildProjectionOptions,
): Promise<unknown>;
export async function rebuildProjection(
  reducerOrId: ProjectionReducer<unknown, unknown> | string,
  eventStore: EventStore,
  streamId: string,
  options?: RebuildProjectionOptions,
): Promise<unknown> {
  const reducer = resolveReducer(reducerOrId, options?.registry);
  // `eventStore.query(streamId)` returns every durable event for the stream
  // in sequence order, merged with any sidecar entries (see `store.ts`).
  // No filters → full replay from the beginning of the log (DR-18).
  const events = await eventStore.query(streamId);
  return foldEvents(reducer, events);
}

/**
 * Fold a reducer over an ordered event list starting from `reducer.initial`.
 *
 * Shared cold-fold kernel for {@link rebuildProjection} (full replay) and
 * {@link projectAt} (bounded replay). Pure: no I/O, no mutation of inputs.
 *
 * Uses a manual loop (rather than `events.reduce(...)`) to keep the hot path
 * allocation-free beyond the per-event `reducer.apply` return value, and to
 * preserve reducer-side stack traces without a reduce frame on top.
 */
function foldEvents(
  reducer: ProjectionReducer<unknown, unknown>,
  events: readonly unknown[],
  seed: unknown = reducer.initial,
): unknown {
  let state: unknown = seed;
  for (const event of events) {
    state = reducer.apply(state, event);
  }
  return state;
}

/**
 * Fold a projection's state **as of** an optional point in the stream's
 * history — the bounded analogue of {@link rebuildProjection} (T2, #1555).
 *
 * Reads the stream via `eventStore.query(streamId)` (full, sequence-ordered),
 * narrows it to the events at or before `bound` via {@link boundEvents}, then
 * cold-folds the reducer over that slice. With no `bound` the result is
 * identical to `rebuildProjection` (the bound past the tail is a no-op).
 *
 * Cold path only — no snapshot warm-start (added in T3). Determinism flows
 * through the reducer's purity contract: the fold over a bounded prefix
 * reproduces the state the live system observed at that point.
 *
 * @typeParam State - The projected state type the reducer produces.
 * @typeParam Event - The event type the reducer consumes.
 * @param reducer - A stream-scoped {@link ProjectionReducer}.
 * @param eventStore - Initialised event store to read from.
 * @param streamId - The stream to fold.
 * @param bound - Optional as-of ceiling (`untilSequence` | `untilTimestamp`).
 * @returns The projected state as of `bound`.
 * @throws {MutuallyExclusiveBoundError} when `bound` carries both keys.
 */
export async function projectAt<State, Event>(
  reducer: ProjectionReducer<State, Event>,
  eventStore: EventStore,
  streamId: string,
  bound?: AsOfBound,
): Promise<State> {
  const events = await eventStore.query(streamId);
  const bounded = boundEvents(events, bound);
  return foldEvents(
    reducer as ProjectionReducer<unknown, unknown>,
    bounded,
  ) as State;
}

/**
 * Resolve a reducer argument into a concrete {@link ProjectionReducer}.
 *
 * - If given a reducer object, returns it unchanged.
 * - If given a string id, looks it up in the provided registry (or the
 *   process-wide default). Throws {@link UnknownProjectionIdError} when the
 *   id is not registered.
 *
 * Split out from `rebuildProjection` so the overload body stays a single
 * straight-line sequence of `(resolve, query, fold)` without a conditional
 * on the reducer argument shape.
 */
function resolveReducer(
  reducerOrId: ProjectionReducer<unknown, unknown> | string,
  registry: ProjectionRegistry = defaultRegistry,
): ProjectionReducer<unknown, unknown> {
  if (typeof reducerOrId === 'string') {
    const resolved = registry.get(reducerOrId);
    if (!resolved) {
      throw new UnknownProjectionIdError(reducerOrId);
    }
    return resolved;
  }
  return reducerOrId as ProjectionReducer<unknown, unknown>;
}
