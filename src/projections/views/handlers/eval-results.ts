import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import { EVAL_RESULTS_VIEW, type EvalResultsViewState } from '../eval-results-view.js';
import { analyticScope } from './analytic-contract.js';
import { getOrCreateMaterializer } from './materializer.js';
import { deriveCorrelationFilters, hasCorrelationFilters, materializeFiltered, queryDeltaEvents } from './query.js';

// ─── View Eval Results Handler ──────────────────────────────────────────────

export async function handleViewEvalResults(
  args: {
    workflowId?: string;
    skill?: string;
    limit?: number;
    // DR-8 (Task 024) — compact-by-default; `detail: true` restores the full
    // projection (including the `calibrations` array stripped by default).
    detail?: boolean;
    // Wave 5 (#1437) — correlation filters scope the projection fold to
    // a single dispatch boundary.
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
    const events = await queryDeltaEvents(store, materializer, streamId, EVAL_RESULTS_VIEW, correlationFilters);
    // Wave 5 (#1437) — under a correlation filter, fold a fresh projection
    // off `init()` so the materializer cache stays the unfiltered truth.
    const view = correlationFiltered
      ? materializeFiltered<EvalResultsViewState>(materializer, EVAL_RESULTS_VIEW, events)
      : materializer.materialize<EvalResultsViewState>(
          streamId,
          EVAL_RESULTS_VIEW,
          events,
        );

    // Apply optional filters
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

    // DR-8 (Task 024) P5 — a skill filter scopes the skills record, so report
    // `scope` + `unscopedTotal` (the pre-filter skill count) + the escape hatch.
    const filterActive = args.skill !== undefined;
    const unscopedTotal = Object.keys(view.skills).length;
    const scopedTotal = Object.keys(filtered.skills).length;
    const s = analyticScope('eval_results', filterActive, unscopedTotal, scopedTotal);
    const nextActions =
      s.nextActions.length > 0 ? { next_actions: s.nextActions } : {};

    // DR-8 compact-by-default — drop the `calibrations` array (secondary, and
    // un-capped today); `detail: true` restores the full projection.
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
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
