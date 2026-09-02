import { toViewFailure } from '../../degraded-result.js';
import { narrowAffordance } from '../../../dispatch/core/economy.js';
import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import type { NextAction } from '../../../next-action.js';
import { type PrStatus, SHEPHERD_STATUS_VIEW, type ShepherdStatusState } from '../shepherd-status-view.js';
import { CompactPrStatus, compactPrStatus } from './analytic-contract.js';
import { resolveInventoryWindow } from './inventory-contract.js';
import { getOrCreateMaterializer } from './materializer.js';
import { buildPage } from './pipeline.js';
import { foldToTail } from '../../fold-at-tail.js';

// ─── View Shepherd Status Handler ────────────────────────────────────────────

export async function handleViewShepherdStatus(
  args: {
    workflowId?: string;
    // DR-8 (Task 024) — `prs` is a paged list; compact-by-default drops the
    // per-PR severity breakdown; `detail: true` restores it.
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

    const { view } = await foldToTail<ShepherdStatusState>(store, materializer, streamId, SHEPHERD_STATUS_VIEW);

    // DR-8 (Task 024) — `prs` is the dominant list, so page it. Compact-by-
    // default drops each PR's per-severity breakdown; `detail: true` restores it.
    const { start, effectiveLimit } = resolveInventoryWindow(args);
    const windowed = view.prs.slice(start, start + effectiveLimit);
    const page = buildPage(view.prs.length, start, effectiveLimit, windowed.length);
    const nextActions: NextAction[] = [];
    if (page.hasMore) {
      nextActions.push(
        narrowAffordance('shepherd_status', windowed.length, view.prs.length, 'exarchos vw shepherd_status --limit 20 --offset 0'),
      );
    }
    const prs: Array<PrStatus | CompactPrStatus> = args.detail
      ? windowed
      : windowed.map(compactPrStatus);
    return {
      success: true,
      data: { ...view, prs, page },
      ...(nextActions.length > 0 ? { next_actions: nextActions } : {}),
    };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'shepherd_status' });
  }
}
