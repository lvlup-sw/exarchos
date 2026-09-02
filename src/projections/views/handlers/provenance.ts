import { narrowAffordance } from '../../../dispatch/core/economy.js';
import { toViewFailure } from '../../degraded-result.js';
import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import type { NextAction } from '../../../next-action.js';
import { PROVENANCE_VIEW, type ProvenanceViewState } from '../provenance-view.js';
import { resolveInventoryWindow } from './inventory-contract.js';
import { getOrCreateMaterializer } from './materializer.js';
import { buildPage } from './pipeline.js';
import { foldToTail } from '../../fold-at-tail.js';

// ─── View Provenance Handler ──────────────────────────────────────────────

export async function handleViewProvenance(
  args: {
    workflowId?: string;
    // DR-8 (Task 024) — `requirements` is a paged list; compact-by-default
    // strips the internal `_completedTaskIds` mirror; `detail: true` restores
    // both.
    limit?: number;
    offset?: number;
    detail?: boolean;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const { view } = await foldToTail<ProvenanceViewState>(store, materializer, streamId, PROVENANCE_VIEW);

    // DR-8 (Task 024) — `requirements` is the dominant list, so page it. Strip
    // the internal `_completedTaskIds` mirror by default (mirrors
    // `workflow_status` stripping `_taskStore`); `detail: true` restores both.
    const { start, effectiveLimit } = resolveInventoryWindow(args);
    const windowed = view.requirements.slice(start, start + effectiveLimit);
    const page = buildPage(view.requirements.length, start, effectiveLimit, windowed.length);
    const nextActions: NextAction[] = [];
    if (page.hasMore) {
      nextActions.push(
        narrowAffordance('provenance', windowed.length, view.requirements.length, 'exarchos vw provenance --limit 20 --offset 0'),
      );
    }
    const nextActionsWrap =
      nextActions.length > 0 ? { next_actions: nextActions } : {};
    if (args.detail) {
      return {
        success: true,
        data: { ...view, requirements: windowed, page },
        ...nextActionsWrap,
      };
    }
    const { _completedTaskIds: _ignoredCompletedTaskIds, ...publicView } = view;
    return {
      success: true,
      data: { ...publicView, requirements: windowed, page },
      ...nextActionsWrap,
    };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'provenance' });
  }
}
