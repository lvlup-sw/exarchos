/**
 * The typed degraded result for a read whose coverage is undecidable.
 *
 * `PROJECTION_DEGRADED` does not mean stale. A lag that a re-fold can close is folded
 * forward by `fold-at-tail.ts` before the read answers. The code means that a fold
 * finished short of its pinned tail, because the log did not produce events that a
 * cursor already counted. No re-fold closes that gap, so the read gives no answer.
 *
 * The four outcomes stay separate:
 * - Healthy answer: `success: true` with a payload folded to the tail.
 * - No data: `success: true` with an empty payload, or a domain code such as `STATE_NOT_FOUND`.
 * - Undecidable: `success: false` with `code: 'PROJECTION_DEGRADED'`.
 * - Genuine fault: `success: false` with a different code.
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
 * The reserved error code for a read whose coverage is undecidable.
 *
 * Other failures must not use this code, so `code === PROJECTION_DEGRADED` never
 * overlaps a domain error.
 */
export const PROJECTION_DEGRADED_ERROR_CODE = 'PROJECTION_DEGRADED';

/**
 * The typed degraded payload on `error.projectionDegraded`.
 *
 * It copies the durable state, so a consumer can act on the verdict without a read
 * of the health stream.
 */
export interface ProjectionDegradedDetail {
  /** The assessed stream (the workflow / feature id). */
  readonly streamId: string;
  readonly reason: ProjectionDegradationReason;
  /** `MAX(events.sequence)` for the stream when the disagreement was observed. */
  readonly eventTail: number;
  /** The worst (trailing or contradicting) projection cursor observed. */
  readonly projectionCursor: number;
  /** `eventTail - projectionCursor`. It is negative when a projection runs ahead. */
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
 * `suggestedFix` points at `exarchos_event` `query`, because the log answers
 * without a fold. `remedyFor` drops the suggestion when it names the call that
 * failed. Otherwise a caller repeats the failing read in a loop that never ends.
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

/** The remedy for this result, or `undefined` when the remedy names the failing call. */
function remedyFor(
  streamId: string,
  context?: { readonly tool?: string | undefined; readonly action?: string | undefined },
): { tool: string; params: Record<string, unknown> } | undefined {
  const remedy = { tool: REMEDY_TOOL, params: { action: REMEDY_ACTION, stream: streamId } };
  return isSameCall(remedy, context) ? undefined : remedy;
}

const REMEDY_TOOL = 'exarchos_event';
const REMEDY_ACTION = 'query';

/** True when a suggestion names the call that produced the error. Tests call it directly. */
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
 * The failure envelope for the catch block of a view handler.
 *
 * A {@link ProjectionCoverageError} keeps the reserved code. Each other fault
 * becomes `VIEW_ERROR`. One function decides this, so the handlers cannot drift apart.
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
 * The degraded result for a coverage failure, or `undefined` for a different fault.
 *
 * It is separate from {@link toViewFailure} because some catch sites use a
 * different fallback, such as a legacy default or `STATUS_FAILED`. That fallback
 * is correct for an ordinary fault, but it hides a coverage failure. So a site
 * calls this function first and returns its result when the result is defined.
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
