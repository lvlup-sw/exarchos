import { EventStore } from '../../../events/store.js';
import { toViewFailure } from '../../degraded-result.js';
import type { ToolResult } from '../../../format.js';
import { EVAL_RESULTS_VIEW, type EvalResultsViewState } from '../eval-results-view.js';
import { analyticScope } from './analytic-contract.js';
import { foldToTail } from '../../fold-at-tail.js';
import { getOrCreateMaterializer } from './materializer.js';
import { deriveCorrelationFilters, hasCorrelationFilters, materializeFiltered, queryDeltaEvents } from './query.js';

/**
 * Handles the `eval_results` view.
 * With a correlation filter, it folds a fresh projection from `init()`, so the materializer cache keeps the unfiltered view.
 * The result reports `scope` and `unscopedTotal`, the skill count before the `skill` filter.
 */
export async function handleViewEvalResults(
  args: {
    workflowId?: string;
    skill?: string;
    limit?: number;
    /** When true, the result keeps the `calibrations` array. By default, the handler drops it. */
    detail?: boolean;
    /** A correlation filter. With any correlation filter, the fold covers one dispatch boundary. */
    operationId?: string;
    correlationId?: string;
    causationId?: string;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const correlationFilters = deriveCorrelationFilters(args);
    const correlationFiltered = hasCorrelationFilters(correlationFilters);
    const view = correlationFiltered
      ? materializeFiltered<EvalResultsViewState>(
          materializer,
          EVAL_RESULTS_VIEW,
          await queryDeltaEvents(store, materializer, streamId, EVAL_RESULTS_VIEW, correlationFilters),
        )
      : (await foldToTail<EvalResultsViewState>(store, materializer, streamId, EVAL_RESULTS_VIEW)).view;

    let filtered: EvalResultsViewState = { ...view };

    if (args.skill) {
      const matchingSkill = filtered.skills[args.skill];
      filtered = {
        ...filtered,
        skills: matchingSkill ? { [args.skill]: matchingSkill } : {},
      };
    }

    if (args.limit !== undefined) {
      filtered = {
        ...filtered,
        runs: filtered.runs.slice(0, args.limit),
        regressions: filtered.regressions.slice(0, args.limit),
      };
    }

    const filterActive = args.skill !== undefined;
    const unscopedTotal = Object.keys(view.skills).length;
    const scopedTotal = Object.keys(filtered.skills).length;
    const s = analyticScope('eval_results', filterActive, unscopedTotal, scopedTotal);
    const nextActions =
      s.nextActions.length > 0 ? { next_actions: s.nextActions } : {};

    if (args.detail) {
      return {
        success: true,
        data: { ...filtered, scope: s.scope, unscopedTotal: s.unscopedTotal },
        ...nextActions,
      };
    }
    const { calibrations: _calibrations, ...compact } = filtered;
    return {
      success: true,
      data: { ...compact, scope: s.scope, unscopedTotal: s.unscopedTotal },
      ...nextActions,
    };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'eval_results' });
  }
}
