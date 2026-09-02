/**
 * DR-4 — the ONE typed degraded result every consumer returns.
 *
 * ## Why this module exists
 *
 * T-06 made the projection-freshness verdict durable: `projection.degraded` /
 * `projection.recovered` on `meta/projection-health`, folded back by
 * `readProjectionDegradedState`. It published a fact that nothing consumed.
 *
 * Every read surface still answered `success: true` off the same in-memory
 * materializer LRU that CB-8 caught lying — a cancelled workflow reporting
 * `plan-review`, 7 of 10 tasks visible, lag past 500s. The only signal was
 * `_meta.projectionDegraded`, an ephemeral per-response courtesy on ONE
 * composite that a consumer had to know to look for and that vanished the
 * moment the process restarted with a cold cache.
 *
 * This module closes that: one shape, one error code, one guard, reused
 * verbatim by every readiness / workflow / reliability consumer. No consumer
 * invents its own degraded envelope, so an agent can branch on a single
 * condition rather than a per-surface dialect.
 *
 * ## The contract, after #1855
 *
 * The rule above was right about the harm and wrong about the remedy. It read
 * "a fold that does not cover the tail must not be served" as "must not be
 * answered", when the read holds everything needed to make the fold cover the
 * tail — and `projections/fold-at-tail.ts` now does exactly that before any
 * answer is produced. Refusing a lag a re-fold closes cost more than the
 * staleness did: the refusal was published durably, only the refused surface
 * could clear it, and `workflow get` stayed unreadable on a lag of one event.
 *
 * So `PROJECTION_DEGRADED` no longer means "stale". It means **undecidable**:
 * a fold finished SHORT of the tail it was pinned against, because the log did
 * not produce events a cursor had already counted. There is no re-fold that
 * closes that, and there is no answer to give. Everything a re-fold closes is
 * closed instead of reported.
 *
 * ## Distinguishability (the four outcomes must never be confused)
 *
 * | outcome        | shape                                                      |
 * |----------------|------------------------------------------------------------|
 * | healthy answer | `success: true` + payload, folded to the tail              |
 * | **no data**    | `success: true` with an empty payload, or a domain code     |
 * |                | such as `STATE_NOT_FOUND` — the store was asked and         |
 * |                | answered "nothing here", which is a TRUE fact about the tail|
 * | **undecidable**| `success: false`, `code: 'PROJECTION_DEGRADED'` — the fold  |
 * |                | could not be shown to cover the tail. NOT "stale", and NOT  |
 * |                | "no data"                                                   |
 * | genuine fault  | `success: false` with any other code                        |
 *
 * The reserved code is what keeps those separable: "no tasks completed" and
 * "coverage could not be established" are different claims, and CB-8 is what
 * happens when a surface conflates them.
 */

import type { ToolResult } from '../format.js';
import { ProjectionCoverageError } from './fold-at-tail.js';
import {
  readProjectionDegradedState,
  type DurableProjectionDegradedState,
  type ProjectionDegradationReason,
  type ProjectionHealthJournal,
} from './freshness.js';

/**
 * The reserved error code for a refused-because-stale read.
 *
 * Reserved: no other failure mode may use it, so `code === PROJECTION_DEGRADED`
 * is a total test for "the answer was withheld because the projection could not
 * be trusted" and never overlaps a domain error.
 */
export const PROJECTION_DEGRADED_ERROR_CODE = 'PROJECTION_DEGRADED';

/**
 * The typed degraded payload carried on `error.projectionDegraded`.
 *
 * A structural copy of the durable state (minus nothing) so a consumer can act
 * on the verdict — how far behind, which folds, observed when — without
 * re-reading the health stream itself.
 */
export interface ProjectionDegradedDetail {
  /** The assessed stream (the workflow / feature id). */
  readonly streamId: string;
  readonly reason: ProjectionDegradationReason;
  /** `MAX(events.sequence)` for the stream when the disagreement was observed. */
  readonly eventTail: number;
  /** The worst (trailing or contradicting) projection cursor observed. */
  readonly projectionCursor: number;
  /** `eventTail - projectionCursor`; negative when a projection runs ahead. */
  readonly lag: number;
  /** The folds that disagree with the tail, worst first. */
  readonly staleViews: readonly string[];
  /** Envelope timestamp of the publishing `projection.degraded` event. */
  readonly observedAt: string;
  /** Sequence of the publishing event on `meta/projection-health`. */
  readonly sequence: number;
}

/** Narrow the durable state to the wire detail. */
function toProjectionDegradedDetail(
  state: DurableProjectionDegradedState,
): ProjectionDegradedDetail {
  return {
    streamId: state.streamId,
    reason: state.reason,
    eventTail: state.eventTail,
    projectionCursor: state.projectionCursor,
    lag: state.lag,
    staleViews: state.staleViews,
    observedAt: state.observedAt,
    sequence: state.sequence,
  };
}

function describe(detail: ProjectionDegradedDetail): string {
  return detail.reason === 'projection-behind'
    ? `a fold of it finished ${detail.lag} event(s) short of the tail it was pinned against (tail ${detail.eventTail}, cursor ${detail.projectionCursor})`
    : `a fold of it claims ${Math.abs(detail.lag)} event(s) the log cannot produce (tail ${detail.eventTail}, cursor ${detail.projectionCursor})`;
}

/**
 * Build the typed degraded result for a read whose coverage is undecidable.
 *
 * `suggestedFix` names the durable event log, and it is chosen rather than
 * hardcoded. The old suggestion was a constant — `exarchos_view`
 * `workflow_status` — which named the failing call itself whenever that was the
 * refusing surface. A caller following it re-ran the same read, failed
 * identically, and each attempt left a window for more events to land, so the
 * loop never converged (#1855). A remedy that can be the disease is not a
 * remedy: `remedyFor` below drops the suggestion entirely when `isSameCall`
 * shows it would name the call that just failed.
 *
 * `exarchos_event` `query` is the right destination on the merits too. This
 * result means no fold could be shown to cover the tail, and the log is the one
 * surface that answers without folding anything.
 */
export function toProjectionDegradedResult(
  state: DurableProjectionDegradedState,
  context?: { readonly tool?: string | undefined; readonly action?: string | undefined },
): ToolResult {
  const projectionDegraded = toProjectionDegradedDetail(state);
  const suggestedFix = remedyFor(projectionDegraded.streamId, context);
  return {
    success: false,
    error: {
      code: PROJECTION_DEGRADED_ERROR_CODE,
      message:
        `Cannot answer from stream '${projectionDegraded.streamId}': ` +
        `${describe(projectionDegraded)}. This is NOT "no data", and it is not ` +
        `mere staleness — a lagging fold is folded forward before any read ` +
        `answers. The log did not produce events the fold had already counted, ` +
        `so coverage cannot be established at all. Read the durable log directly.`,
      ...(context?.tool === undefined ? {} : { tool: context.tool }),
      ...(context?.action === undefined ? {} : { action: context.action }),
      ...(suggestedFix === undefined ? {} : { suggestedFix }),
      projectionDegraded,
    },
  };
}

/** The remedy this result points at, or `undefined` when it would be circular. */
function remedyFor(
  streamId: string,
  context?: { readonly tool?: string | undefined; readonly action?: string | undefined },
): { tool: string; params: Record<string, unknown> } | undefined {
  const remedy = { tool: REMEDY_TOOL, params: { action: REMEDY_ACTION, stream: streamId } };
  return isSameCall(remedy, context) ? undefined : remedy;
}

const REMEDY_TOOL = 'exarchos_event';
const REMEDY_ACTION = 'query';

/**
 * True when a suggestion names the very call that produced the error.
 *
 * Exported so the invariant is testable directly rather than only through the
 * surfaces that happen to build a suggestion today.
 */
export function isSameCall(
  remedy: { tool: string; params: Record<string, unknown> },
  context?: { readonly tool?: string | undefined; readonly action?: string | undefined },
): boolean {
  return remedy.tool === context?.tool && remedy.params['action'] === context?.action;
}

/** True when a result is the reserved degraded refusal (and not a domain error). */
export function isProjectionDegradedResult(result: ToolResult): boolean {
  return result.success === false && result.error?.code === PROJECTION_DEGRADED_ERROR_CODE;
}

/**
 * The failure envelope for a view handler's catch block.
 *
 * One place decides which faults are `PROJECTION_DEGRADED` and which are
 * `VIEW_ERROR`, so the distinction cannot drift across seventeen handlers that
 * each wrote the same catch by hand. A {@link ProjectionCoverageError} is the
 * undecidable case and keeps the reserved code; everything else is an ordinary
 * view fault.
 */
export function toViewFailure(
  err: unknown,
  context?: { readonly tool?: string | undefined; readonly action?: string | undefined },
): ToolResult {
  return toCoverageFailure(err, context) ?? {
    success: false,
    error: {
      code: 'VIEW_ERROR',
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

/**
 * The degraded result for a coverage failure, or `undefined` for any other
 * fault.
 *
 * Separate from {@link toViewFailure} because not every catch site wants
 * `VIEW_ERROR` as its fallback: some fall back to a legacy default, some to
 * `STATUS_FAILED`. Each of those is a reasonable answer to an ordinary fault
 * and the wrong answer to "no fold could be shown to cover the tail" — a
 * best-effort fallback there is the silent degradation this whole seam exists
 * to remove. Reading as `const refusal = toCoverageFailure(err, ctx); if
 * (refusal) return refusal;` keeps the distinction at every site instead of
 * forcing one fallback on all of them.
 */
export function toCoverageFailure(
  err: unknown,
  context?: { readonly tool?: string | undefined; readonly action?: string | undefined },
): ToolResult | undefined {
  if (!(err instanceof ProjectionCoverageError)) return undefined;
  return toProjectionDegradedResult(
    {
      streamId: err.streamId,
      reason: err.freshness.reason ?? 'projection-behind',
      eventTail: err.freshness.eventTail,
      projectionCursor: err.freshness.projectionCursor,
      lag: err.freshness.lag,
      staleViews: err.freshness.staleViews,
      sequence: 0,
      observedAt: new Date().toISOString(),
    },
    context,
  );
}

// ─── Removed: `resolveProjectionStreamId` / `guardProjectionDegraded` ───────
//
// A consumer-side chokepoint that refused to serve any stream carrying a
// durable `projection.degraded` row, plus the arg-dialect resolver that told it
// which stream a composite's args named.
//
// It has no consumers because the question it answered is now answered earlier
// and better. A durable marker is a point-in-time OBSERVATION, not a current
// fact about the stream: by the time a read consults it, the lagging fold has
// already been folded forward (`projections/fold-at-tail.ts`) and the read can
// prove its own coverage. Deferring to the marker anyway wedges a healthy
// stream on a spent observation — the latch that
// `FoldAtTail_FabricatedDegradedMarker_DoesNotWedgeAHealthyStream` and
// `Consumer_StaleFoldAndDurableMarker_IsNotWedged` exist to reject.
//
// `toProjectionDegradedResult` and `readProjectionDegradedState` above are what
// survive: the durable row is still WRITTEN and still readable, so the journal
// records live conditions. Nothing reads it to refuse.
