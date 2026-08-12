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
import type { EventStore } from '../events/store.js';
import type { ProjectionReducer } from './types.js';
import {
  defaultRegistry,
  type ProjectionRegistry,
} from './registry.js';
import { boundEvents, type AsOfBound } from './cursor.js';
import { readLatestSnapshot } from './store.js';
import type { WorkflowEvent } from '../events/schemas.js';

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
 * history — the bounded analogue of {@link rebuildProjection} (T2/T3, #1555).
 *
 * Reads the stream via `eventStore.query(streamId)` (full, sequence-ordered),
 * narrows it to the events at or before `bound` via {@link boundEvents}, then
 * folds the reducer over that slice. With no `bound` the result is identical to
 * `rebuildProjection` (the bound past the tail is a no-op).
 *
 * ## Snapshot warm-start (T3)
 *
 * When the reducer carries an `id`, `projectAt` consults the stream-scoped
 * snapshot store for a usable warm-start point. A snapshot is usable iff its
 * `snapshot.sequence <= effectiveN`, where `effectiveN` is the stream sequence
 * of the LAST bounded event (the bound resolved to a concrete sequence ceiling;
 * 0 for an empty bounded slice). When usable, state is seeded from
 * `snapshot.state` and only the bounded tail strictly after `snapshot.sequence`
 * is folded. Otherwise the reducer cold-folds the full bounded slice from
 * `reducer.initial`.
 *
 * The **stream-scoped snapshot contract**: `snapshot.sequence` is the stream
 * sequence of the last event baked into `snapshot.state` — a real event
 * coordinate, which is why it can be compared directly against `effectiveN`
 * above. It is NOT a count of folded events. The reducer's own
 * `projectionSequence` IS such a count (it advances only on events the reducer
 * handles), so the two diverge the moment a stream carries an event type the
 * reducer ignores. Conflating them would make the eligibility test above
 * compare a count against a coordinate and warm-start from the wrong point;
 * writers must therefore persist the absorbed stream position in
 * `snapshot.sequence`, never `projectionSequence` (see `workflow/tools.ts`'s
 * checkpoint snapshot write).
 *
 * INV-1 purity: warm-start is an optimisation. Seeding from a snapshot at or
 * before the bound and folding the remaining tail is observationally identical
 * to cold-folding every bounded event from `reducer.initial`, because reducer
 * `apply` is pure and the snapshot state equals the cold fold through
 * `snapshot.sequence` by construction.
 *
 * A reducer with no `id` cannot key a snapshot, so warm-start is skipped and
 * the cold path runs unconditionally.
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
  // `boundEvents` resolves both bound forms (`untilSequence` / `untilTimestamp`)
  // into a concrete prefix of `WorkflowEvent`s. The last element's sequence is
  // the effective sequence ceiling we test snapshot eligibility against.
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
 * Resolve a snapshot warm-start for {@link projectAt}, or fall back to the cold
 * fold (seed = `reducer.initial`, tail = the full bounded slice).
 *
 * Eligibility: the reducer must carry an `id` (else no snapshot key); the
 * bounded slice must be a true prefix of the sequence-ordered log (see below);
 * and the latest snapshot for `(streamId, reducer.id, String(reducer.version))`
 * must exist with `snapshot.sequence <= effectiveN` (the last bounded event's
 * sequence). A snapshot beyond the bound has already folded events past the
 * as-of point and is therefore unusable — we cold-fold instead.
 *
 * ## Prefix soundness (timestamp bounds)
 *
 * Warm-start seeds the snapshot (the cold fold through `snapshot.sequence`) and
 * folds only the bounded tail after it. That is observationally identical to
 * cold-folding the whole bounded slice ONLY when `bounded` is a true prefix of
 * the log — every bounded event sitting at its original sequence index. Single-
 * stream `EventStore.query` orders by SEQUENCE, not timestamp, so an
 * `untilSequence` bound always yields a prefix, but an `untilTimestamp` bound
 * does so only while stream timestamps stay monotonic with sequence. A
 * backwards clock skew makes `boundEvents` drop an interior event, yielding a
 * non-prefix subset; seeding a snapshot against it would smuggle the excluded
 * event's effect into the result. We therefore validate prefix-ness rather than
 * assume it (INV-1: warm-start must never change the observed fold).
 */
function resolveWarmStart(
  reducer: ProjectionReducer<unknown, unknown>,
  eventStore: EventStore,
  streamId: string,
  bounded: readonly WorkflowEvent[],
  events: readonly WorkflowEvent[],
): WarmStart {
  const cold: WarmStart = { seed: reducer.initial, tail: bounded };

  // A reducer without an id cannot address a snapshot — cold-fold.
  if (!reducer.id) return cold;

  // Only a genuine prefix can be safely warm-started (see doc above). A
  // timestamp bound over a non-monotonic clock can produce a non-prefix subset.
  if (!isSequencePrefix(bounded, events)) return cold;

  const effectiveN =
    bounded.length > 0 ? (bounded[bounded.length - 1]?.sequence ?? 0) : 0;

  const snapshot = readLatestSnapshot(
    eventStore.getReadBackend(),
    streamId,
    reducer.id,
    String(reducer.version),
  );

  // No snapshot, or a snapshot beyond the as-of bound: cold-fold.
  if (snapshot === undefined || snapshot.sequence > effectiveN) {
    return cold;
  }

  // Usable: seed from the snapshot, fold only the bounded tail strictly after
  // the snapshot's baked-in sequence.
  return {
    seed: snapshot.state,
    tail: bounded.filter((e) => e.sequence > snapshot.sequence),
  };
}

/**
 * True iff `bounded` is the leading run of the sequence-ordered `events` — each
 * bounded event sits at its original index. `events` is ascending by sequence
 * and `bounded` is an order-preserving subset, so a positional sequence match
 * across the whole slice proves prefix-ness. Cheap integer compares only, no
 * `reducer.apply`; strictly less work than the cold fold it may unlock.
 */
function isSequencePrefix(
  bounded: readonly WorkflowEvent[],
  events: readonly WorkflowEvent[],
): boolean {
  return bounded.every((e, i) => e.sequence === events[i]?.sequence);
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
