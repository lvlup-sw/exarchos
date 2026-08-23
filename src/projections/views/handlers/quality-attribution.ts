import { narrowAffordance } from '../../../dispatch/core/economy.js';
import { toViewFailure } from '../../degraded-result.js';
import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import type { NextAction } from '../../../next-action.js';
import { type AttributionDimension, computeAttribution, isValidDimension } from '../../quality/attribution.js';
import { CODE_QUALITY_VIEW, type CodeQualityViewState } from '../code-quality-view.js';
import { EVAL_RESULTS_VIEW, type EvalResultsViewState } from '../eval-results-view.js';
import { compactAttributionEntry } from './analytic-contract.js';
import { resolveInventoryWindow } from './inventory-contract.js';
import { foldPairToTail } from '../../fold-at-tail.js';
import { getOrCreateMaterializer } from './materializer.js';
import { buildPage } from './pipeline.js';
import { deriveCorrelationFilters, hasCorrelationFilters, materializeFiltered, queryDeltaEvents } from './query.js';

// ─── View Quality Attribution Handler ─────────────────────────────────────────

export async function handleViewQualityAttribution(
  args: {
    workflowId?: string;
    dimension?: string;
    skill?: string;
    timeRange?: { start: string; end: string };
    // DR-8 (Task 024) — `entries` is a paged list; compact-by-default drops the
    // secondary roll-up counts per entry and the `correlations` matrix;
    // `detail: true` restores the full attribution result.
    limit?: number;
    offset?: number;
    detail?: boolean;
    // Wave 5 (#1437) — correlation filters scope both underlying projections
    // (CQ + ER) to the same dispatch boundary so the attribution roll-up
    // stays internally consistent.
    operationId?: string;
    correlationId?: string;
    causationId?: string;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  const dimension = args.dimension;
  if (!dimension || !isValidDimension(dimension)) {
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: `Invalid attribution dimension: ${String(dimension)}`,
      },
    };
  }

  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const correlationFilters = deriveCorrelationFilters(args);
    const correlationFiltered = hasCorrelationFilters(correlationFilters);

    // Both projections describe ONE state of the stream, so both must come from
    // one sequence. Filtered, that is the single fetched event list they each
    // fold; unfiltered, it is the single tail `foldPairToTail` pins for the
    // pair. Folding them independently would let an append between the two
    // produce a comparison of a state the stream was never in — and would also
    // charge every unfiltered read for an event query it does not use.
    let cqView: CodeQualityViewState;
    let erView: EvalResultsViewState;
    if (correlationFiltered) {
      const cqEvents = await queryDeltaEvents(
        store,
        materializer,
        streamId,
        CODE_QUALITY_VIEW,
        correlationFilters,
      );
      cqView = materializeFiltered<CodeQualityViewState>(materializer, CODE_QUALITY_VIEW, cqEvents);
      erView = materializeFiltered<EvalResultsViewState>(materializer, EVAL_RESULTS_VIEW, cqEvents);
    } else {
      const pair = await foldPairToTail<CodeQualityViewState, EvalResultsViewState>(
        store,
        materializer,
        streamId,
        CODE_QUALITY_VIEW,
        EVAL_RESULTS_VIEW,
      );
      cqView = pair.first;
      erView = pair.second;
    }

    // AttributionQuery.timeRange expects ISO 8601 duration string (e.g., 'P7D'),
    // but the MCP handler receives { start, end } — compute duration from the range
    let timeRange: string | undefined;
    if (args.timeRange) {
      const startMs = Date.parse(args.timeRange.start);
      const endMs = Date.parse(args.timeRange.end);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
        return {
          success: false,
          error: {
            code: 'VIEW_ERROR',
            message: 'Invalid timeRange: expected ISO timestamps with end >= start',
          },
        };
      }
      const diffDays = Math.max(1, Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000)));
      timeRange = `P${diffDays}D`;
    }
    const query = {
      dimension: dimension as AttributionDimension,
      skill: args.skill,
      timeRange,
    };
    const attribution = computeAttribution(query, cqView, erView);
    // DR-8 (Task 024) — `entries` is the dominant list, so page it. Compact-by-
    // default compacts each entry to its headline and drops the `correlations`
    // matrix; `detail: true` restores the full attribution roll-up.
    const { start, effectiveLimit } = resolveInventoryWindow(args);
    const windowed = attribution.entries.slice(start, start + effectiveLimit);
    const page = buildPage(attribution.entries.length, start, effectiveLimit, windowed.length);
    const nextActions: NextAction[] = [];
    if (page.hasMore) {
      nextActions.push(
        narrowAffordance('quality_attribution', windowed.length, attribution.entries.length, 'exarchos vw quality_attribution --limit 20 --offset 0'),
      );
    }
    const nextActionsWrap =
      nextActions.length > 0 ? { next_actions: nextActions } : {};
    if (args.detail) {
      return {
        success: true,
        data: { ...attribution, entries: windowed, page },
        ...nextActionsWrap,
      };
    }
    const entries = windowed.map(compactAttributionEntry);
    const { correlations: _correlations, ...rest } = attribution;
    return {
      success: true,
      data: { ...rest, entries, page },
      ...nextActionsWrap,
    };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'quality_attribution' });
  }
}
