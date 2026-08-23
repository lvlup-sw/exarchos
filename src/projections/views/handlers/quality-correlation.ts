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

// ─── View Quality Correlation Handler ────────────────────────────────────────

export async function handleViewQualityCorrelation(
  args: {
    workflowId?: string;
    // DR-8 (Task 024) — compact-by-default per-skill; `detail: true` restores
    // each skill's trend + regression-count detail.
    detail?: boolean;
    // Wave 5 (#1437) — correlation filters scope both underlying projections
    // (CQ + ER) to the same dispatch boundary so the joined view stays
    // internally consistent.
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

    // Under a correlation filter, `queryDeltaEvents` short-circuits the
    // cache and returns `store.query(streamId, filters)` regardless of
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

    const correlation = correlateQualityAndEvals(cqView, erView);
    // DR-8 (Task 024) compact-by-default — keep each skill's headline (pass rate
    // + eval score); `detail: true` restores the trend + regression-count detail.
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
