/**
 * The sealed fold: a cached view, and the proof that it covers the event tail.
 *
 * ## What went wrong without it (#1855)
 *
 * Coverage was checked rather than established. A read folded whichever view it
 * needed, answered, and only then did a separate comparison
 * (`assessStreamFreshness`) ask whether the stream's folds agreed with the
 * durable tail. That comparison quantified over EVERY cached fold of the
 * stream, while a read advances exactly ONE. The two are incompatible the
 * moment a stream has more than one cached fold, and `workflow-state` — folded
 * by orchestrate verbs and gates, folded by no `exarchos_view` action — made it
 * terminal: no view read could restore agreement, and the view surface was the
 * only publisher of `projection.recovered`. `workflow get` and four orchestrate
 * actions stayed refused across processes and restarts, on a lag of one event.
 *
 * ## The construction
 *
 * Staleness is not a verdict to report. It is a condition to remove, and the
 * read already holds everything needed to remove it: the store, the stream, the
 * projection. So this module folds first and answers from the result, and the
 * result carries the sequence it covers rather than leaving that to a later
 * comparison over unrelated cache entries.
 *
 * `projection-behind` is closed by folding the delta. `projection-ahead` — a
 * fold claiming events the log cannot produce — is closed by discarding the
 * fold and replaying from the log, which is authoritative by construction: the
 * event log is the source of truth, so a replay of it cannot be wrong. Neither
 * withholds an answer.
 *
 * The behind/ahead/fresh decision is NOT made here. It is
 * {@link planRehydrationSource}, which `workflow/rehydrate.ts` has always used
 * to reach exactly this outcome — fold the tail forward over a lagging
 * snapshot, discard and replay a contradictory one. That surface repaired while
 * this one refused, on the same verdict, which is why `rehydrate` was the only
 * read that kept working. One decision, two callers, no second opinion.
 *
 * ## What remains withheld
 *
 * One state survives, and it is a genuinely different claim: a fold that
 * finishes SHORT of the tail it was pinned against. The log lost events the
 * cursor had already counted, so the coverage question has no answer rather
 * than an inconvenient one. That is {@link ProjectionCoverageError}, and it is
 * the only path left to `PROJECTION_DEGRADED`. Absence of evidence does not
 * become success.
 */

import type { WorkflowEvent } from '../events/schemas.js';
import type { EventStore } from '../events/store.js';
import { planRehydrationSource } from '../workflow/rehydrate-precedence.js';
import { assessProjectionFreshness, type ProjectionFreshness } from './freshness.js';
import { isInternalSentinelStream, type ViewMaterializer } from './views/materializer.js';

/**
 * A fold, bound to the durable sequence it provably covers.
 *
 * The binding is the point. A bare view says nothing about which events it has
 * seen, so an answer derived from one carries no evidence of its own currency —
 * and the coverage question then has to be asked somewhere else, about
 * something else, too late to fix.
 */
export interface FoldAtTail<T> {
  readonly view: T;
  /**
   * The event sequence this fold covers. Always `>=` the tail read when the
   * fold began; greater when the stream grew while it ran, which is a longer
   * answer and not a staler one.
   */
  readonly sequence: number;
  /**
   * Present only when a contradictory fold was discarded and replayed. The
   * answer is authoritative either way — this is the incident record, so a
   * repair is observable rather than silent.
   */
  readonly repaired?: ProjectionFreshness;
}

/**
 * A fold that finished short of the tail it was pinned against.
 *
 * Not "the projection lagged" — that is repaired. This is the log failing to
 * produce events a cursor had already counted, so no fold can be shown to cover
 * the tail. The caller must not answer from it.
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
 * Fold `viewName` over `streamId` until it covers the stream's durable tail,
 * and return it bound to the sequence it reached.
 *
 * This is the ONLY sanctioned way to obtain a cached fold for an answer;
 * `tests/architecture/projection-fold-seam.test.ts` enforces that. Bounded
 * reads (`asOf`, correlation-filtered) are a different contract — a pure fold
 * of `events[0..N]` — and go through `materializeFresh`, which is exempt by
 * name in the guard's policy rather than by omission.
 *
 * Cost is the delta, not the stream: a warm fold queries `sinceSequence` and
 * applies only what landed since. The path this replaces did the same query and
 * then discarded the result to refuse, so a warm read gets cheaper, not dearer.
 *
 * @throws {ProjectionCoverageError} when the fold cannot be shown to cover the
 * pinned tail.
 */
export async function foldToTail<T>(
  store: EventStore,
  materializer: ViewMaterializer,
  streamId: string,
  viewName: string,
): Promise<FoldAtTail<T>> {
  // A sentinel stream (`__migration__`) is deliberately never folded — see
  // `ViewMaterializer.materializeAt`. It has no cached state to be stale, so
  // there is no coverage claim to make or to break.
  if (isInternalSentinelStream(streamId)) {
    return { view: materializer.materializeAt<T>(streamId, viewName, []).view, sequence: 0 };
  }

  // A cold fold may still have a persisted snapshot to seed from; give it that
  // chance BEFORE the cursor is read, so the plan below sees the real starting
  // position rather than treating a warm-on-disk view as cold.
  if (materializer.getState(streamId, viewName) === undefined) {
    await materializer.loadFromSnapshot(streamId, viewName);
  }

  // Pin the tail first. Everything after this is measured against this number,
  // so an append landing mid-fold widens the answer instead of invalidating it.
  const eventTail = await store.tailSequence(streamId);
  const cached = materializer.getState(streamId, viewName);

  const plan = planRehydrationSource({
    hasSnapshot: cached !== undefined,
    snapshotCursor: cached?.highWaterMark ?? 0,
    eventTail,
    viewName,
  });

  // `projection-ahead`: the cursor counts events the log cannot produce, and
  // `materializeAt`'s high-water-mark filter would drop every event below it,
  // so a re-fold applies nothing. Drop the entry and replay.
  if (!plan.seedFromSnapshot) {
    materializer.discardFold(streamId, viewName);
  }

  const events: WorkflowEvent[] =
    plan.sinceSequence > 0
      ? await store.query(streamId, { sinceSequence: plan.sinceSequence })
      : await store.query(streamId);

  const folded = materializer.materializeAt<T>(streamId, viewName, events);

  // The fold is complete when its cursor reaches the tail it was pinned
  // against. A cursor that stops short means the log did not produce events the
  // cursor had already counted; that is undecidable, not stale, and it is the
  // one thing this seam refuses to answer through.
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
