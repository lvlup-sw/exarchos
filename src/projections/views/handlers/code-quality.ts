import { EventStore } from '../../../events/store.js';
import { toViewFailure } from '../../degraded-result.js';
import type { ToolResult } from '../../../format.js';
import { logger } from '../../../logger.js';
import { detectRegressions, emitRegressionEvents, type FailureTracker } from '../../quality/regression-detector.js';
import { CODE_QUALITY_VIEW, type CodeQualityViewState } from '../code-quality-view.js';
import { analyticScope } from './analytic-contract.js';
import { foldToTail } from '../../fold-at-tail.js';
import { getOrCreateMaterializer } from './materializer.js';
import { deriveCorrelationFilters, hasCorrelationFilters, materializeFiltered, queryDeltaEvents } from './query.js';

// ─── View Code Quality Handler ──────────────────────────────────────────────

export async function handleViewCodeQuality(
  args: {
    workflowId?: string;
    skill?: string;
    gate?: string;
    limit?: number;
    // DR-8 (Task 024) — compact-by-default; `detail: true` restores the full
    // projection (including the per-model roll-up stripped by default).
    detail?: boolean;
    // Wave 5 (#1437) — correlation tuple filters scope the underlying
    // EventStore.query, so the projection folds only the slice that matches
    // the dispatch boundary. Threaded into queryDeltaEvents below.
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
    // Wave 5 (#1437) — under a correlation filter, fold a fresh projection
    // off `init()` so the materializer cache stays the unfiltered truth.
    const view = correlationFiltered
      ? materializeFiltered<CodeQualityViewState>(
          materializer,
          CODE_QUALITY_VIEW,
          await queryDeltaEvents(store, materializer, streamId, CODE_QUALITY_VIEW, correlationFilters),
        )
      : (await foldToTail<CodeQualityViewState>(store, materializer, streamId, CODE_QUALITY_VIEW)).view;

    // Detect and emit quality regressions with deduplication.
    // _failureTrackers is a non-enumerable property set by code-quality-view.ts.
    //
    // Wave 5 (#1437) — skip regression detection/emission when a
    // correlation filter is active. Regressions are a global SDLC signal
    // derived from the unfiltered fold; detecting them on a filtered slice
    // would (a) produce false negatives (gates that failed outside the
    // slice look healthy) and (b) emit phantom `quality.regression` events
    // that bake a filtered view into the unfiltered truth.
    if (!correlationFiltered) {
      const regressions = detectRegressions(view as CodeQualityViewState & { _failureTrackers?: Record<string, FailureTracker> });
      if (regressions.length > 0) {
        const existingEvents = await store.query(streamId);
        const existingRegressions = existingEvents
          .filter(e => e.type === 'quality.regression')
          .map(e => e.data as { gate: string; skill: string; firstFailureCommit: string });

        const newRegressions = regressions.filter(r =>
          !existingRegressions.some(er =>
            er.gate === r.gate && er.skill === r.skill && er.firstFailureCommit === r.firstFailureCommit
          )
        );

        if (newRegressions.length > 0) {
          try {
            await emitRegressionEvents(newRegressions, streamId, store);
          } catch (err) {
            // Fire-and-forget: emission failure must not break the view
            // query, but swallowing silently hides write-path failures.
            // Log so the failure is observable in operator logs.
            logger.warn(
              {
                streamId,
                regressions: newRegressions.length,
                err: err instanceof Error ? err.message : String(err),
              },
              'handleViewCodeQuality: failed to emit quality.regression events',
            );
          }
        }
      }
    }

    // Apply optional filters
    let filtered: CodeQualityViewState = { ...view };

    if (args.skill) {
      const skillName = args.skill;
      const matchingSkill = filtered.skills[skillName];
      filtered = {
        ...filtered,
        skills: matchingSkill ? { [skillName]: matchingSkill } : {},
      };
    }

    if (args.gate) {
      const gateName = args.gate;
      const matchingGate = filtered.gates[gateName];
      filtered = {
        ...filtered,
        gates: matchingGate ? { [gateName]: matchingGate } : {},
      };
    }

    if (args.limit !== undefined) {
      filtered = {
        ...filtered,
        benchmarks: filtered.benchmarks.slice(0, args.limit),
        regressions: filtered.regressions.slice(0, args.limit),
      };
    }

    // DR-8 (Task 024) P5 — a skill/gate filter scopes the skills+gates records,
    // so report `scope` + `unscopedTotal` (the pre-filter record count) and
    // surface the hidden-rows escape hatch when the filter elided records.
    const filterActive = args.skill !== undefined || args.gate !== undefined;
    const unscopedTotal =
      Object.keys(view.skills).length + Object.keys(view.gates).length;
    const scopedTotal =
      Object.keys(filtered.skills).length + Object.keys(filtered.gates).length;
    const s = analyticScope('code_quality', filterActive, unscopedTotal, scopedTotal);
    const nextActions =
      s.nextActions.length > 0 ? { next_actions: s.nextActions } : {};

    // DR-8 compact-by-default — drop the per-model roll-up (`models`), the
    // heaviest secondary record; `detail: true` restores the full projection.
    if (args.detail) {
      return {
        success: true,
        data: { ...filtered, scope: s.scope, unscopedTotal: s.unscopedTotal },
        ...nextActions,
      };
    }
    const { models: _models, ...compact } = filtered;
    return {
      success: true,
      data: { ...compact, scope: s.scope, unscopedTotal: s.unscopedTotal },
      ...nextActions,
    };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'code_quality' });
  }
}
