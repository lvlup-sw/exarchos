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

/**
 * Handles the `delegation_timeline` view. It pages `tasks[]` and compacts each task unless `detail` is true.
 * With a correlation filter, it folds a fresh projection from `init()`, so the materializer cache keeps the unfiltered view.
 * In that case, `unscopedTotal` comes from a cached fold of the full stream. That fold does not touch the filtered result.
 * The `page` object is separate, so `page.hasMore` does not collide with the projection's own `hasMore`.
 */
export async function handleViewDelegationTimeline(
  args: {
    workflowId?: string;
    /** Page size for `tasks[]`. Without it, the default item cap applies. */
    limit?: number;
    offset?: number;
    detail?: boolean;
    /** A correlation filter. With any correlation filter, the view scope is `correlation`. */
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
    const view = filtered
      ? materializeFiltered<DelegationTimelineViewState>(
          materializer,
          DELEGATION_TIMELINE_VIEW,
          await queryDeltaEvents(store, materializer, streamId, DELEGATION_TIMELINE_VIEW, correlationFilters),
        )
      : (await foldToTail<DelegationTimelineViewState>(store, materializer, streamId, DELEGATION_TIMELINE_VIEW)).view;

    const scopedTasks = view.tasks;
    const total = scopedTasks.length;

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

    const { start, effectiveLimit } = resolveInventoryWindow(args);
    const windowed = scopedTasks.slice(start, start + effectiveLimit);
    const tasks: Array<TimelineTask | CompactTimelineTask> = args.detail
      ? windowed
      : windowed.map(compactTimelineTask);

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
