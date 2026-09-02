import { narrowAffordance } from '../../../dispatch/core/economy.js';
import { toViewFailure } from '../../degraded-result.js';
import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import type { NextAction } from '../../../next-action.js';
import { DELEGATION_TIMELINE_VIEW, type DelegationTimelineViewState, type TimelineTask } from '../delegation-timeline-view.js';
import { CompactTimelineTask, compactTimelineTask, resolveInventoryWindow, scopeHiddenAffordance } from './inventory-contract.js';
import { foldToTail } from '../../fold-at-tail.js';
import { getOrCreateMaterializer } from './materializer.js';
import { buildPage } from './pipeline.js';
import { deriveCorrelationFilters, hasCorrelationFilters, materializeFiltered, queryDeltaEvents } from './query.js';

// ─── View Delegation Timeline Handler ───────────────────────────────────────

export async function handleViewDelegationTimeline(
  args: {
    workflowId?: string;
    // DR-8 (Task 013) — list/inventory paging + compact-by-default over `tasks[]`.
    limit?: number;
    offset?: number;
    detail?: boolean;
    // Wave 5 (#1437) — correlation filters scope the projection fold.
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
    const filtered = hasCorrelationFilters(correlationFilters);
    // Wave 5 (#1437) — under a correlation filter, fold a fresh projection
    // off `init()` so the materializer cache stays the unfiltered truth.
    const view = filtered
      ? materializeFiltered<DelegationTimelineViewState>(
          materializer,
          DELEGATION_TIMELINE_VIEW,
          await queryDeltaEvents(store, materializer, streamId, DELEGATION_TIMELINE_VIEW, correlationFilters),
        )
      : (await foldToTail<DelegationTimelineViewState>(store, materializer, streamId, DELEGATION_TIMELINE_VIEW)).view;

    // DR-8 — the `tasks[]` list is the paged inventory; `total` is the scoped
    // (possibly correlation-filtered) task count.
    const scopedTasks = view.tasks;
    const total = scopedTasks.length;

    // DR-8 P5 — a correlation filter is this view's SCOPE. Report `scope` +
    // `unscopedTotal` so rows hidden by the filter stay perceivable. The
    // unfiltered count comes from a cached fold of the full stream: the
    // correlation-filtered path bypasses the cache, so this fold neither reads
    // from nor contaminates the filtered result — the same seam pipeline uses
    // to derive its pre-scope count.
    let scope: 'all' | 'correlation' = 'all';
    let unscopedTotal = total;
    if (filtered) {
      scope = 'correlation';
      const unfiltered = await foldToTail<DelegationTimelineViewState>(
        store,
        materializer,
        streamId,
        DELEGATION_TIMELINE_VIEW,
      );
      unscopedTotal = unfiltered.view.tasks.length;
    }

    // DR-8 — deterministic window (default item cap when `limit` omitted).
    const { start, effectiveLimit } = resolveInventoryWindow(args);
    const windowed = scopedTasks.slice(start, start + effectiveLimit);
    // DR-8 — compact by default (drop per-task ISO timestamps); `detail:true` full.
    const tasks: Array<TimelineTask | CompactTimelineTask> = args.detail
      ? windowed
      : windowed.map(compactTimelineTask);

    // DR-8 — `page` is namespaced so `page.hasMore` never collides with the
    // projection's own per-view eviction `hasMore` (mirrors the pipeline note).
    const page = buildPage(total, start, effectiveLimit, windowed.length);
    const nextActions: NextAction[] = [];
    if (page.hasMore) {
      nextActions.push(
        narrowAffordance('delegation_timeline', windowed.length, total, 'exarchos vw delegation_timeline --limit 20 --offset 0'),
      );
    }
    if (unscopedTotal > total) {
      nextActions.push(scopeHiddenAffordance('delegation_timeline', unscopedTotal - total));
    }

    return {
      success: true,
      data: { ...view, tasks, page, scope, unscopedTotal },
      ...(nextActions.length > 0 ? { next_actions: nextActions } : {}),
    };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'delegation_timeline' });
  }
}
