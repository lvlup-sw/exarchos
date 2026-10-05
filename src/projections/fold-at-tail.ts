/**
 * The sealed fold: a cached view, and the sequence of the event tail that it covers.
 *
 * A read folds first and answers from the result, so it removes staleness and does not report it.
 * A lagging fold (`projection-behind`) folds the delta. A fold that claims events the log cannot
 * produce (`projection-ahead`) is discarded and replayed from the log, which is the source of truth.
 * {@link planRehydrationSource} makes this decision, as it does for `workflow/rehydrate.ts`.
 *
 * One state withholds the answer: a fold that ends short of its pinned tail. The log lost events
 * that the cursor counted, so the coverage question has no answer. That state is
 * {@link ProjectionCoverageError}, which keeps the `PROJECTION_DEGRADED` code.
 */

import type { WorkflowEvent } from '../events/schemas.js';
import type { EventStore } from '../events/store.js';
import { planRehydrationSource } from '../workflow/rehydrate-precedence.js';
import { assessProjectionFreshness, type ProjectionFreshness } from './freshness.js';
import { isInternalSentinelStream, type ViewMaterializer } from './views/materializer.js';

/**
 * A fold, bound to the durable sequence that it covers.
 * A bare view does not show which events it saw, so its answer carries no evidence of currency.
 */
export interface FoldAtTail<T> {
  readonly view: T;
  /**
   * The exact event sequence that this fold covers. The fold stops at the tail pinned when it began.
   * Thus two views of one stream can fold to the same sequence, and a read can compare them.
   */
  readonly sequence: number;
  /**
   * Present only when a contradictory fold was discarded and replayed.
   * The answer is authoritative either way. This field makes the repair observable.
   */
  readonly repaired?: ProjectionFreshness;
}

/**
 * A fold that ended short of its pinned tail. A lagging projection is repaired and does not raise it.
 * The log did not produce events that a cursor already counted, so no fold covers the tail.
 * The caller must not answer from it.
 */
export class ProjectionCoverageError extends Error {
  constructor(
    readonly streamId: string,
    readonly viewName: string,
    readonly freshness: ProjectionFreshness,
  ) {
    super(
      `Fold of '${viewName}' on stream '${streamId}' finished at sequence ` +
        `${freshness.projectionCursor}, short of the durable tail ` +
        `${freshness.eventTail} it was pinned against.`,
    );
    this.name = 'ProjectionCoverageError';
  }
}

/**
 * Folds `viewName` over `streamId` until it covers the durable tail, and returns it with the sequence it reached.
 *
 * This is the only sanctioned way to get a cached fold for an answer, and
 * `tests/architecture/projection-fold-seam.test.ts` enforces it. A bounded read, such as `asOf` or a
 * correlation filter, uses `materializeFresh`, which the guard exempts by name.
 * A warm fold queries `sinceSequence` and applies only the delta.
 *
 * @throws {ProjectionCoverageError} when the fold does not cover the pinned tail.
 */
export async function foldToTail<T>(
  store: EventStore,
  materializer: ViewMaterializer,
  streamId: string,
  viewName: string,
): Promise<FoldAtTail<T>> {
  return foldAtPinnedTail<T>(
    store,
    materializer,
    streamId,
    viewName,
    await pinTail(store, streamId),
  );
}

/**
 * Folds two views of one stream against one pinned tail.
 * Two separate {@link foldToTail} calls pin two tails, so a combined read can describe a state that the stream never had.
 * The function takes two type parameters and not a list, so each view keeps its own state type without a cast.
 */
export async function foldPairToTail<A, B>(
  store: EventStore,
  materializer: ViewMaterializer,
  streamId: string,
  firstView: string,
  secondView: string,
): Promise<{ first: A; second: B; sequence: number }> {
  const eventTail = await pinTail(store, streamId);
  const first = await foldAtPinnedTail<A>(store, materializer, streamId, firstView, eventTail);
  const second = await foldAtPinnedTail<B>(store, materializer, streamId, secondView, eventTail);
  return { first: first.view, second: second.view, sequence: eventTail };
}

/** The tail every fold in one read is measured against. */
async function pinTail(store: EventStore, streamId: string): Promise<number> {
  return isInternalSentinelStream(streamId) ? 0 : store.tailSequence(streamId);
}

/**
 * Folds one view against a tail that the caller already pinned, so several views can share one tail.
 * A sentinel stream such as `__migration__` is never folded, so it makes no coverage claim.
 * A cold view first loads its persisted snapshot, so the plan sees the real start position.
 *
 * A fold ahead of the log is discarded. Without the discard, `materializeAt` drops every event below its high-water mark and applies nothing.
 * The store has no upper-sequence filter, so this function drops the events past the pinned tail.
 * A cursor short of the tail throws {@link ProjectionCoverageError}.
 */
async function foldAtPinnedTail<T>(
  store: EventStore,
  materializer: ViewMaterializer,
  streamId: string,
  viewName: string,
  eventTail: number,
): Promise<FoldAtTail<T>> {
  if (isInternalSentinelStream(streamId)) {
    return { view: materializer.materializeAt<T>(streamId, viewName, []).view, sequence: 0 };
  }

  if (materializer.getState(streamId, viewName) === undefined) {
    await materializer.loadFromSnapshot(streamId, viewName);
  }
  const cached = materializer.getState(streamId, viewName);

  const plan = planRehydrationSource({
    hasSnapshot: cached !== undefined,
    snapshotCursor: cached?.highWaterMark ?? 0,
    eventTail,
    viewName,
  });

  if (!plan.seedFromSnapshot) {
    materializer.discardFold(streamId, viewName);
  }

  const queried: readonly WorkflowEvent[] =
    plan.sinceSequence > 0
      ? await store.query(streamId, { sinceSequence: plan.sinceSequence })
      : await store.query(streamId);
  const events = queried.filter((event) => event.sequence <= eventTail);

  const folded = materializer.materializeAt<T>(streamId, viewName, [...events]);

  if (folded.sequence < eventTail) {
    throw new ProjectionCoverageError(
      streamId,
      viewName,
      assessProjectionFreshness({
        eventTail,
        projectionCursor: folded.sequence,
        viewName,
      }),
    );
  }

  return plan.degraded && plan.freshness !== undefined
    ? { view: folded.view, sequence: folded.sequence, repaired: plan.freshness }
    : { view: folded.view, sequence: folded.sequence };
}
