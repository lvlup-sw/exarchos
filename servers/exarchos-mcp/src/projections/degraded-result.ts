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
 * ## The contract
 *
 * A degraded read is a FAILURE, not an annotated success. `success: false` with
 * `error.code === 'PROJECTION_DEGRADED'` and the durable state attached to
 * `error.projectionDegraded`. The stale payload is DROPPED — annotating it
 * would leave the same footgun in place for every caller that checks `success`
 * and never reads `_meta`.
 *
 * ## Distinguishability (the three outcomes must never be confused)
 *
 * | outcome        | shape                                                      |
 * |----------------|------------------------------------------------------------|
 * | healthy answer | `success: true` + payload                                   |
 * | **no data**    | `success: true` with an empty payload, or a domain code such |
 * |                | as `STATE_NOT_FOUND` — the store was asked and answered      |
 * |                | "nothing here", which is a TRUE fact about the tail          |
 * | **degraded**   | `success: false`, `code: 'PROJECTION_DEGRADED'`, with the    |
 * |                | observed tail/cursor/lag — "cannot answer", NOT "no data"    |
 * | genuine fault  | `success: false` with any other code                         |
 *
 * The reserved code is what makes the middle two separable: "no tasks
 * completed" and "the fold has not seen the events that completed them" are
 * different claims, and CB-8 is what happens when a surface conflates them.
 */

import type { ToolResult } from '../format.js';
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
export function toProjectionDegradedDetail(
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
    ? `its projections stop ${detail.lag} event(s) short of the durable tail (tail ${detail.eventTail}, worst cursor ${detail.projectionCursor})`
    : `its projections claim ${Math.abs(detail.lag)} event(s) the log cannot produce (tail ${detail.eventTail}, worst cursor ${detail.projectionCursor})`;
}

/**
 * Build the typed degraded result for a consumer that refused to answer.
 *
 * `suggestedFix` names the recovery action deliberately: the view chokepoint is
 * the surface that re-folds, re-assesses and publishes `projection.recovered`,
 * so it is the action that CLEARS this state. Without it the refusal reads as a
 * dead end rather than a step, and a caller has no way back to a healthy read.
 */
export function toProjectionDegradedResult(
  state: DurableProjectionDegradedState,
  context?: { readonly tool?: string | undefined; readonly action?: string | undefined },
): ToolResult {
  const projectionDegraded = toProjectionDegradedDetail(state);
  return {
    success: false,
    error: {
      code: PROJECTION_DEGRADED_ERROR_CODE,
      message:
        `Refusing to answer from stream '${projectionDegraded.streamId}': ` +
        `${describe(projectionDegraded)}. This is NOT "no data" — the answer is ` +
        `withheld because the fold it would be derived from provably does not ` +
        `cover the event tail. Re-read the stream through exarchos_view to re-fold ` +
        `and clear this state.`,
      ...(context?.tool === undefined ? {} : { tool: context.tool }),
      ...(context?.action === undefined ? {} : { action: context.action }),
      suggestedFix: {
        tool: 'exarchos_view',
        params: { action: 'workflow_status', workflowId: projectionDegraded.streamId },
      },
      projectionDegraded,
    },
  };
}

/** True when a result is the reserved degraded refusal (and not a domain error). */
export function isProjectionDegradedResult(result: ToolResult): boolean {
  return result.success === false && result.error?.code === PROJECTION_DEGRADED_ERROR_CODE;
}

/**
 * The stream id a composite's args identify, if any.
 *
 * The three composites spell the same concept differently — `exarchos_view`
 * takes `workflowId`, `exarchos_workflow` and `exarchos_orchestrate` take
 * `featureId` — and both names denote the SAME event stream. Resolving that in
 * one place keeps the guard's coverage from depending on which dialect a given
 * action happens to speak.
 *
 * Returns `undefined` for a stream-less action (`describe`, `runbook`, …),
 * which the guard treats as "nothing to assess" rather than "assume healthy".
 */
export function resolveProjectionStreamId(
  args: Record<string, unknown>,
): string | undefined {
  for (const key of ['workflowId', 'featureId', 'streamId', 'stream'] as const) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * The consumer-side chokepoint: refuse to serve a stream recorded as degraded.
 *
 * Returns the typed degraded result when the durable state says this stream's
 * projections disagree with its tail, and `undefined` when there is nothing to
 * report — so a caller reads as `const refusal = await guard(...); if (refusal)
 * return refusal;` before it does any projection-derived work.
 *
 * ## Why a read fault passes through
 *
 * If the health stream itself cannot be read we do not know whether the stream
 * is degraded. Failing every read on that basis would make an unreadable meta
 * stream a total outage of surfaces that may be perfectly healthy — the
 * freshness probe must never be the reason a good read fails (the same rule the
 * EFF-002 view stamp adopted). We pass through and let the caller answer; the
 * fault is logged by the caller's own `onError` hook so it is not silent.
 */
export async function guardProjectionDegraded(
  journal: ProjectionHealthJournal,
  streamId: string | undefined,
  context?: {
    readonly tool?: string | undefined;
    readonly action?: string | undefined;
    readonly onError?: (err: unknown) => void;
  },
): Promise<ToolResult | undefined> {
  if (streamId === undefined || streamId.length === 0) return undefined;
  try {
    const state = await readProjectionDegradedState(journal, streamId);
    if (state === undefined) return undefined;
    return toProjectionDegradedResult(state, context);
  } catch (err) {
    context?.onError?.(err);
    return undefined;
  }
}
