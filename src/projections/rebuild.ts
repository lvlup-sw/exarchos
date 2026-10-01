/**
 * Rebuilds a projection by a fold of its reducer over the event log of a stream.
 *
 * `rebuildProjection` replays the full log from sequence 0 and reads no snapshot. The rehydrate
 * handler uses it as the fallback when a snapshot read fails. `projectAt` folds the log up to an
 * as-of bound and can start from a snapshot. Apart from the event and snapshot reads, the helpers
 * do no I/O and do not mutate their inputs. Determinism comes from the purity of `ProjectionReducer.apply`.
 */
import type { EventStore } from '../events/store.js';
import type { ProjectionReducer } from './types.js';
import {
  defaultRegistry,
  type ProjectionRegistry,
} from './registry.js';
import { boundEvents, type AsOfBound } from './cursor.js';
import { readLatestSnapshot } from './store.js';
import type { WorkflowEvent } from '../events/schemas.js';

/** Options for the id form of {@link rebuildProjection}. */
export interface RebuildProjectionOptions {
  /**
   * The registry that resolves a projection id. The default is {@link defaultRegistry}.
   * A test that needs isolation passes a registry from `createRegistry()`.
   */
  readonly registry?: ProjectionRegistry;
}

/**
 * Raised when `rebuildProjection` gets a projection id that the registry does not hold.
 * The caller gets an error and not an initial-state document.
 */
export class UnknownProjectionIdError extends Error {
  constructor(public readonly projectionId: string) {
    super(`unknown projection id: ${projectionId}`);
    this.name = 'UnknownProjectionIdError';
  }
}

/**
 * Rebuilds the state of a projection by a fold of its reducer over every event in `streamId`, from sequence 0.
 *
 * Pass a `ProjectionReducer<State, Event>` to get `Promise<State>`. Pass a projection id to resolve
 * the reducer from `options.registry`. The registry stores `ProjectionReducer<unknown, unknown>`,
 * so the id form returns `Promise<unknown>`.
 *
 * @throws {UnknownProjectionIdError} when the id form gets an id that is not registered.
 * Errors from `eventStore.query` and from the reducer propagate.
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
  const events = await eventStore.query(streamId);
  return foldEvents(reducer, events);
}

/**
 * Folds a reducer over an ordered event list, from `seed` or `reducer.initial`. It is pure.
 * The manual loop avoids extra allocation and keeps a reduce frame out of reducer stack traces.
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
 * Folds the state of a projection as of an optional `bound`. With no `bound`, the result equals `rebuildProjection`.
 *
 * When the reducer has an `id`, the fold can start from the latest snapshot. The snapshot is usable when
 * `snapshot.sequence` is at or below the sequence of the last bounded event. Then only the bounded events
 * after `snapshot.sequence` fold onto `snapshot.state`. `snapshot.sequence` is a stream position and not
 * the count in `projectionSequence`. Writers must persist the stream position, or the warm start begins at
 * the wrong point. A warm start gives the same result as a cold fold, because `apply` is pure.
 *
 * @throws {MutuallyExclusiveBoundError} when `bound` carries both keys.
 */
export async function projectAt<State, Event>(
  reducer: ProjectionReducer<State, Event>,
  eventStore: EventStore,
  streamId: string,
  bound?: AsOfBound,
): Promise<State> {
  const events = await eventStore.query(streamId);
  const bounded = boundEvents(events, bound) as WorkflowEvent[];
  const erasedReducer = reducer as ProjectionReducer<unknown, unknown>;

  const warm = resolveWarmStart(erasedReducer, eventStore, streamId, bounded, events);
  return foldEvents(erasedReducer, warm.tail, warm.seed) as State;
}

/** A resolved warm-start: the seed state and the tail still to fold over it. */
interface WarmStart {
  readonly seed: unknown;
  readonly tail: readonly WorkflowEvent[];
}

/**
 * Returns the snapshot warm start for {@link projectAt}, or the cold fold from `reducer.initial`.
 *
 * A warm start needs a reducer `id` and a bounded slice that is a prefix of the log. The latest snapshot
 * must also be at or below the last bounded sequence, because a later snapshot holds events past the as-of point.
 * The query orders by sequence, so an `untilTimestamp` bound gives a prefix only while timestamps rise with sequence.
 * If clock skew drops an interior event, a warm start puts the effect of that event back into the result.
 */
function resolveWarmStart(
  reducer: ProjectionReducer<unknown, unknown>,
  eventStore: EventStore,
  streamId: string,
  bounded: readonly WorkflowEvent[],
  events: readonly WorkflowEvent[],
): WarmStart {
  const cold: WarmStart = { seed: reducer.initial, tail: bounded };

  if (!reducer.id) return cold;

  if (!isSequencePrefix(bounded, events)) return cold;

  const effectiveN =
    bounded.length > 0 ? (bounded[bounded.length - 1]?.sequence ?? 0) : 0;

  const snapshot = readLatestSnapshot(
    eventStore.getReadBackend(),
    streamId,
    reducer.id,
    String(reducer.version),
  );

  if (snapshot === undefined || snapshot.sequence > effectiveN) {
    return cold;
  }

  return {
    seed: snapshot.state,
    tail: bounded.filter((e) => e.sequence > snapshot.sequence),
  };
}

/**
 * True when each bounded event sits at its original index in the sequence-ordered `events`.
 * `bounded` keeps the order of `events`, so a positional match proves that it is a prefix.
 */
function isSequencePrefix(
  bounded: readonly WorkflowEvent[],
  events: readonly WorkflowEvent[],
): boolean {
  return bounded.every((e, i) => e.sequence === events[i]?.sequence);
}

/**
 * Returns a reducer object unchanged, or looks up a string id in `registry`.
 *
 * @throws {UnknownProjectionIdError} when the id is not registered.
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
