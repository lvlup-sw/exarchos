import { EventStore } from '../../../events/store.js';
import { toViewFailure } from '../../degraded-result.js';
import type { ToolResult } from '../../../format.js';
import { correlateQualityAndEvals } from '../../quality/quality-correlation.js';
import { CODE_QUALITY_VIEW, type CodeQualityViewState } from '../code-quality-view.js';
import { EVAL_RESULTS_VIEW, type EvalResultsViewState } from '../eval-results-view.js';
import { CompactSkillCorrelation, compactSkillCorrelation } from './analytic-contract.js';
import { foldToTail } from '../../fold-at-tail.js';
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
    // `viewName` — so both calls would fetch an identical event list.
    // Fetch once and fold the same list into both projections (each
    // projection's `apply` ignores event types it doesn't care about).
    const cqEvents = await queryDeltaEvents(store, materializer, streamId, CODE_QUALITY_VIEW, correlationFilters);
    const cqView = correlationFiltered
      ? materializeFiltered<CodeQualityViewState>(materializer, CODE_QUALITY_VIEW, cqEvents)
      : (await foldToTail<CodeQualityViewState>(store, materializer, streamId, CODE_QUALITY_VIEW)).view;

    const erView = correlationFiltered
      ? materializeFiltered<EvalResultsViewState>(materializer, EVAL_RESULTS_VIEW, cqEvents)
      : (await foldToTail<EvalResultsViewState>(store, materializer, streamId, EVAL_RESULTS_VIEW)).view;

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
