import { EventStore } from '../../../events/store.js';
import { toViewFailure } from '../../degraded-result.js';
import type { ToolResult } from '../../../format.js';
import { DELEGATION_READINESS_VIEW, type DelegationReadinessState, scopeReadinessToWave } from '../delegation-readiness-view.js';
import { getOrCreateMaterializer } from './materializer.js';
import { foldToTail } from '../../fold-at-tail.js';

export async function handleViewDelegationReadiness(
  args: {
    workflowId?: string;
    /**
     * Task IDs of the active batch. When present, the counters, blockers and `ready` flag use only this set.
     * `prepare_delegation` applies the same scope through the same pure function.
     */
    tasks?: readonly string[];
    /** When true, the result keeps `assignedTaskIds` and `readyTaskIds`. By default, it drops them and keeps the counts. */
    detail?: boolean;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const { view: materialized } = await foldToTail<DelegationReadinessState>(store, materializer, streamId, DELEGATION_READINESS_VIEW);
    const view = scopeReadinessToWave(
      materialized,
      args.tasks?.map((id) => ({ id })),
    );

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
    return toViewFailure(err, { tool: 'exarchos_view', action: 'delegation_readiness' });
  }
}
