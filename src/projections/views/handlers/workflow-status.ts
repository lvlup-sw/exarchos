import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import { type AsOfParam, resolveAsOfEvents } from '../../cursor.js';
import { WORKFLOW_STATUS_VIEW, type WorkflowStatusViewState } from '../workflow-status-view.js';
import { getOrCreateMaterializer } from './materializer.js';
import { queryDeltaEvents } from './query.js';
import { readWorkflowStateJson } from './streams.js';

// ─── View Workflow Status Handler ──────────────────────────────────────────

export async function handleViewWorkflowStatus(
  args: { workflowId?: string; asOf?: AsOfParam; detail?: boolean },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    // #1555 — an `asOf` (bounded-fold) read MUST bypass the hwm cache: fetch
    // ALL events for the stream, bound to `events[0..N]` via the shared
    // `resolveAsOfEvents` seam, and fold fresh from `projection.init()`
    // (`materializeFresh`). Mirrors the correlation-filter precedent so a warm
    // unbounded cache can never bleed into the bounded fold, and the bounded
    // read never contaminates the cache. The live path keeps the cached
    // `queryDeltaEvents` → `materialize`. Behavior lives here in the dispatch
    // core; CLI/MCP adapters only thread `asOf` through (INV-2).
    const view = args.asOf !== undefined
      ? materializer.materializeFresh<WorkflowStatusViewState>(
          WORKFLOW_STATUS_VIEW,
          resolveAsOfEvents(await store.query(streamId), args.asOf),
        )
      : materializer.materialize<WorkflowStatusViewState>(
          streamId,
          WORKFLOW_STATUS_VIEW,
          await queryDeltaEvents(store, materializer, streamId, WORKFLOW_STATUS_VIEW),
        );

    // Fix 2 (#1184) — `tasksTotal` is a plan-state fact: the planner stamps
    // the full task list via `workflow set` (state.patched events), and
    // `task.assigned` only fires for tasks that get dispatched. Sourcing the
    // count from state.tasks.length avoids under-reporting when the planner
    // has declared work that hasn't been kicked off yet.
    //
    // #1555 — but ONLY for a LIVE read. state.json carries the CURRENT tip task
    // list, so folding it into a bounded `asOf` response would leak tip-state
    // counts into a historical projection (INV-1: a bounded read is a pure fold
    // of `events[0..N]`). For a bounded read the fold's own `view.tasksTotal` is
    // the as-of-correct count.
    let tasksTotal = view.tasksTotal;
    if (args.asOf === undefined) {
      const state = await readWorkflowStateJson(stateDir, streamId);
      const stateTasks = state?.['tasks'];
      if (Array.isArray(stateTasks)) {
        tasksTotal = stateTasks.length;
      }
    }

    // C4 (#1226) — strip projection-internal dedup bookkeeping from the
    // public envelope. The `_seen*TaskIds` arrays are needed for replay
    // correctness but must not leak into the response shape.
    // DR-8 (Task 013) — also strip the internal `_taskStore` mirror. It is the
    // largest part of the payload on a big workflow, is documented as
    // "stripped before the view envelope is surfaced", and is restored only
    // under `detail: true`. `workflow_status` is a single-object status (not
    // list-shaped), so it carries no `page`.
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
    return {
      success: false,
      error: {
        code: 'VIEW_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
