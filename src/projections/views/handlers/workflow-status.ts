import { toViewFailure } from '../../degraded-result.js';
import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import { type AsOfParam, resolveAsOfEvents } from '../../cursor.js';
import { WORKFLOW_STATUS_VIEW, type WorkflowStatusViewState } from '../workflow-status-view.js';
import { foldToTail } from '../../fold-at-tail.js';
import { getOrCreateMaterializer } from './materializer.js';
import { queryDeltaEvents } from './query.js';
import { readWorkflowStateJson } from './streams.js';

/**
 * Return the workflow-status view of one stream.
 *
 * An `asOf` read folds the bounded events fresh and does not use the cache, so the cache and
 * the bounded fold cannot mix. A live read takes `tasksTotal` from the task list in the state
 * file, because the planner declares tasks before `task.assigned` fires. A bounded read keeps
 * the fold count, because the state file holds only the current list. The response omits the
 * `_seen*TaskIds` replay bookkeeping, and holds `_taskStore` only with `detail: true`.
 */
export async function handleViewWorkflowStatus(
  args: { workflowId?: string; asOf?: AsOfParam; detail?: boolean },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const view = args.asOf !== undefined
      ? materializer.materializeFresh<WorkflowStatusViewState>(
          WORKFLOW_STATUS_VIEW,
          resolveAsOfEvents(await store.query(streamId), args.asOf),
        )
      : (await foldToTail<WorkflowStatusViewState>(
          store,
          materializer,
          streamId,
          WORKFLOW_STATUS_VIEW,
        )).view;

    let tasksTotal = view.tasksTotal;
    if (args.asOf === undefined) {
      const state = await readWorkflowStateJson(stateDir, streamId);
      const stateTasks = state?.['tasks'];
      if (Array.isArray(stateTasks)) {
        tasksTotal = stateTasks.length;
      }
    }

    const {
      _seenAssignedTaskIds: _ignoredAssigned,
      _seenCompletedTaskIds: _ignoredCompleted,
      _taskStore: internalTaskStore,
      ...publicView
    } = view;

    const data = args.detail
      ? { ...publicView, tasksTotal, _taskStore: internalTaskStore }
      : { ...publicView, tasksTotal };

    return { success: true, data };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'workflow_status' });
  }
}
