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

/**
 * Returns the quality attribution for one dimension, with the `entries` list in pages.
 * Both projections fold from one sequence: the filtered event list, or the one tail that `foldPairToTail` pins.
 * Separate folds can let an append between them produce a comparison of a state that the stream never had.
 * The correlation filters scope both projections to the same dispatch boundary.
 *
 * The handler converts a `{ start, end }` time range into a whole-day ISO 8601 duration, such as `P7D`.
 * By default, each entry is compact and the `correlations` matrix is absent. `detail: true` returns the full result.
 */
export async function handleViewQualityAttribution(
  args: {
    workflowId?: string;
    dimension?: string;
    skill?: string;
    timeRange?: { start: string; end: string };
    limit?: number;
    offset?: number;
    detail?: boolean;
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
