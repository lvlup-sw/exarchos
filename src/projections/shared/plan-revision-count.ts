/**
 * The plan-revision count of a workflow, read from its event rows.
 *
 * The `revisions-exhausted` guard, its admission fact and the `prepare_review` cap all read this
 * count. Thus they read one number from the same rows, and they cannot disagree. The guard and the
 * admission fact read the log that the transition handler loads into `state._events`. The
 * `prepare_review` handler reads the same rows from the event store.
 */

/** The event that `prepare_review` appends for each plan-review dispatch. */
const PLAN_REVIEW_DISPATCHED_EVENT = 'workflow.plan-review-dispatched';

/** The event-store type of the counted revise edge of the overhaul track. */
const PLAN_REVISION_STORED_EVENT = 'workflow.plan-revision';

/**
 * The counted revise edge of the overhaul track. The HSM result gives it the type
 * `plan-revision`, and the event store gives it the type `workflow.plan-revision`.
 */
const PLAN_REVISION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'plan-revision',
  PLAN_REVISION_STORED_EVENT,
]);

/**
 * The event-store types that `tallyPlanRevisions` counts. A reader of the event store queries
 * only these types, because the tally ignores all other rows.
 */
export const PLAN_REVISION_COUNTED_STORE_TYPES: readonly string[] = Object.freeze([
  PLAN_REVIEW_DISPATCHED_EVENT,
  PLAN_REVISION_STORED_EVENT,
]);

/** The plan-review dispatches and the plan revisions in a list of event rows. */
export interface PlanRevisionTally {
  /** The number of dispatch rows. The next dispatch takes this number as its `ordinal`. */
  readonly dispatches: number;
  /** The number of `plan-revision` rows of the overhaul revise edge. */
  readonly edgeRevisions: number;
  /** The number of plan revisions that the rows consumed. */
  readonly revisions: number;
}

/**
 * The plan revisions for a number of dispatches and revise-edge rows.
 * The first dispatch is the initial review, so each later dispatch is one revision.
 * A revise-edge row is one revision of the overhaul track, which counts at its revise edge.
 * One revise loop can add a row of each kind, so the result is the larger count, not the sum.
 */
function revisionsFrom(dispatches: number, edgeRevisions: number): number {
  return Math.max(dispatches - 1, edgeRevisions, 0);
}

function eventTypeOf(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const type: unknown = (entry as { readonly type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

/** Count the plan revisions in a list of event rows. A row of another type does not count. */
export function tallyPlanRevisions(events: readonly unknown[]): PlanRevisionTally {
  let dispatches = 0;
  let edgeRevisions = 0;
  for (const entry of events) {
    const type = eventTypeOf(entry);
    if (type === PLAN_REVIEW_DISPATCHED_EVENT) dispatches += 1;
    else if (type !== undefined && PLAN_REVISION_EVENT_TYPES.has(type)) edgeRevisions += 1;
  }
  return { dispatches, edgeRevisions, revisions: revisionsFrom(dispatches, edgeRevisions) };
}

/** True when the consumed plan revisions reach the cap. The `revisions-exhausted` guard reads it. */
export function planRevisionCapReached(revisions: number, cap: number): boolean {
  return revisions >= cap;
}

/**
 * True when one more plan-review dispatch takes the plan revisions past the cap. `prepare_review`
 * refuses that dispatch. An overhaul revise edge counts its revision before the re-review, so that
 * re-review consumes no second revision and stays admitted at the cap. When this function refuses
 * a dispatch, `planRevisionCapReached` is also true, so the guard opens `blocked`.
 */
export function planReviewDispatchExceedsCap(tally: PlanRevisionTally, cap: number): boolean {
  return revisionsFrom(tally.dispatches + 1, tally.edgeRevisions) > cap;
}
