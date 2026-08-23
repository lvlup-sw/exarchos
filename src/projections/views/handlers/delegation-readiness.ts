import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import { DELEGATION_READINESS_VIEW, type DelegationReadinessState, scopeReadinessToWave } from '../delegation-readiness-view.js';
import { getOrCreateMaterializer } from './materializer.js';
import { queryDeltaEvents } from './query.js';

// ─── View Delegation Readiness Handler ──────────────────────────────────────

export async function handleViewDelegationReadiness(
  args: {
    workflowId?: string;
    /**
     * WFQ-002: the active wave's task IDs. When present, readiness counters,
     * blockers, and the `ready` flag are computed over exactly this set instead
     * of every historical `task.assigned` event on the stream — the same
     * scoping `prepare_delegation` applies, through the same pure core.
     */
    tasks?: readonly string[];
    // DR-8 (Task 024) — compact-by-default drops the per-task ID tracking
    // lists; `detail: true` restores them.
    detail?: boolean;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, DELEGATION_READINESS_VIEW);
    const materialized = materializer.materialize<DelegationReadinessState>(
      streamId,
      DELEGATION_READINESS_VIEW,
      events,
    );
    const view = scopeReadinessToWave(
      materialized,
      args.tasks?.map((id) => ({ id })),
    );

    // DR-8 (Task 024) compact-by-default — drop the per-task ID tracking lists
    // (`assignedTaskIds` / `readyTaskIds`); the derived `expected` / `ready`
    // counts stay. `detail: true` restores the ID lists.
    if (args.detail) {
      return { success: true, data: view };
    }
    const {
      assignedTaskIds: _assignedTaskIds,
      readyTaskIds: _readyTaskIds,
      ...worktrees
    } = view.worktrees;
    return { success: true, data: { ...view, worktrees } };
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
