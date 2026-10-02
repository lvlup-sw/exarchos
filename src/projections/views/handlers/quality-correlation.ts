import { EventStore } from '../../../events/store.js';
import { toViewFailure } from '../../degraded-result.js';
import type { ToolResult } from '../../../format.js';
import { correlateQualityAndEvals } from '../../quality/quality-correlation.js';
import { CODE_QUALITY_VIEW, type CodeQualityViewState } from '../code-quality-view.js';
import { EVAL_RESULTS_VIEW, type EvalResultsViewState } from '../eval-results-view.js';
import { CompactSkillCorrelation, compactSkillCorrelation } from './analytic-contract.js';
import { foldPairToTail } from '../../fold-at-tail.js';
import { getOrCreateMaterializer } from './materializer.js';
import { deriveCorrelationFilters, hasCorrelationFilters, materializeFiltered, queryDeltaEvents } from './query.js';

/**
 * Handles the `quality_correlation` view: it joins the code-quality and eval-results views for each skill.
 * Both views fold from one event sequence, so an append between the two folds cannot give a state that the stream never had.
 * With correlation filters, both views fold the same filtered event list. Without filters, `foldPairToTail` pins one tail for the pair.
 * Each skill entry has only `skill`, `gatePassRate` and `evalScore`, unless `detail` is true.
 */
export async function handleViewQualityCorrelation(
  args: {
    workflowId?: string;
    detail?: boolean;
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

    const correlation = correlateQualityAndEvals(cqView, erView);
    if (args.detail) {
      return { success: true, data: correlation };
    }
    const skills: Record<string, CompactSkillCorrelation> = {};
    for (const [name, c] of Object.entries(correlation.skills)) {
      skills[name] = compactSkillCorrelation(c);
    }
    return { success: true, data: { skills } };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'quality_correlation' });
  }
}
