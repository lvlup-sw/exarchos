import { narrowAffordance } from '../../../dispatch/core/economy.js';
import { EventStore } from '../../../events/store.js';
import { pickFields, type ToolResult } from '../../../format.js';
import type { NextAction } from '../../../next-action.js';
import { TASK_DETAIL_VIEW, type TaskDetail, type TaskDetailViewState } from '../task-detail-view.js';
import { CompactTaskDetail, compactTaskDetail, resolveInventoryWindow, scopeHiddenAffordance } from './inventory-contract.js';
import { getOrCreateMaterializer } from './materializer.js';
import { buildPage } from './pipeline.js';
import { queryDeltaEvents } from './query.js';
import { readWorkflowStateJson } from './streams.js';

// ─── View Tasks Handler ────────────────────────────────────────────────────

export async function handleViewTasks(
  args: {
    workflowId?: string;
    filter?: Record<string, unknown>;
    limit?: number;
    offset?: number;
    fields?: string[];
    // DR-8 (Task 013) — compact-by-default rows; `detail: true` restores the
    // verbose/optional per-task fields (`artifacts`, `error`, `duration`, …).
    detail?: boolean;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const events = await queryDeltaEvents(store, materializer, streamId, TASK_DETAIL_VIEW);
    const view = materializer.materialize<TaskDetailViewState>(
      streamId,
      TASK_DETAIL_VIEW,
      events,
    );

    // Fix 2 (#1184) — the task-detail projection is event-sourced and only
    // populates entries that have a `task.assigned` event. The planner often
    // stamps the full task list via `workflow set` before any dispatch, so
    // we merge state.tasks into the projection: event-sourced detail wins
    // (it has assignee, status, tddPhase, etc.); state-sourced entries fill
    // in the gaps so plan-declared pending tasks appear.
    const state = await readWorkflowStateJson(stateDir, streamId);
    const stateTasksRaw = state?.['tasks'];
    const merged: Record<string, TaskDetail> = { ...view.tasks };
    if (Array.isArray(stateTasksRaw)) {
      for (const entry of stateTasksRaw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const e = entry as Record<string, unknown>;
        const id = typeof e['id'] === 'string' ? (e['id'] as string) : undefined;
        if (!id || merged[id]) continue;
        // Map TaskSchema status (`pending|in_progress|complete|failed`) onto
        // the TaskDetail status union. The schema preprocesses 'completed' →
        // 'complete' so handle both spellings defensively. Plan-state
        // 'pending' must surface as 'pending' so a not-yet-dispatched task
        // is never reported as 'assigned' (which means dispatched to a
        // teammate) — see #1184 / CR feedback on PR #1185.
        const rawStatus = e['status'];
        const status: TaskDetail['status'] =
          rawStatus === 'failed'
            ? 'failed'
            : rawStatus === 'complete' || rawStatus === 'completed'
              ? 'completed'
              : rawStatus === 'in_progress'
                ? 'in-progress'
                : 'pending';
        merged[id] = {
          taskId: id,
          title: typeof e['title'] === 'string' ? (e['title'] as string) : '',
          status,
          ...(typeof e['branch'] === 'string' ? { branch: e['branch'] as string } : {}),
          ...(typeof e['worktreePath'] === 'string'
            ? { worktree: e['worktreePath'] as string }
            : {}),
          ...(typeof e['teammateName'] === 'string'
            ? { assignee: e['teammateName'] as string }
            : {}),
        };
      }
    }
    const allTasks: TaskDetail[] = Object.values(merged);

    // DR-8 P5 — `unscopedTotal` is the PRE-filter count so filter-hidden rows
    // stay perceivable whenever a `filter` scopes the inventory.
    const unscopedTotal = allTasks.length;
    const filterActive =
      args.filter !== undefined && Object.keys(args.filter).length > 0;

    // Apply optional filter (the scope)
    let filteredTasks = allTasks;
    if (args.filter) {
      filteredTasks = allTasks.filter((task) => {
        for (const [key, value] of Object.entries(args.filter!)) {
          if ((task as unknown as Record<string, unknown>)[key] !== value) {
            return false;
          }
        }
        return true;
      });
    }
    const total = filteredTasks.length;

    // DR-8 — deterministic window: honor an explicit `offset`/`limit`, else cap
    // at DEFAULT_VIEW_ITEM_CAP so a large task list never dumps every row.
    const { start, effectiveLimit } = resolveInventoryWindow(args);
    const windowed = filteredTasks.slice(start, start + effectiveLimit);

    // DR-8 — inventory metadata. The `tasks` view keeps its bare-array `data`
    // contract (many in-repo consumers read `data` as an array; the full reshape
    // to `data: { tasks, page }` is DR-12's consumer migration), so `page`,
    // `scope`, and `unscopedTotal` ride `_meta` in the interim.
    const page = buildPage(total, start, effectiveLimit, windowed.length);
    const scope: 'filtered' | 'all' = filterActive ? 'filtered' : 'all';
    const nextActions: NextAction[] = [];
    if (page.hasMore) {
      nextActions.push(
        narrowAffordance('tasks', windowed.length, total, 'exarchos vw tasks --limit 20 --offset 0'),
      );
    }
    if (unscopedTotal > total) {
      nextActions.push(scopeHiddenAffordance('tasks', unscopedTotal - total));
    }
    const envelopeExtras = {
      _meta: { page, scope, unscopedTotal },
      ...(nextActions.length > 0 ? { next_actions: nextActions } : {}),
    };

    // DR-8 — `fields` projection stays verbatim over FULL rows, so an explicit
    // field list can name any field regardless of the compact default.
    if (args.fields) {
      const projected = windowed.map(
        (t) => pickFields(t as unknown as Record<string, unknown>, args.fields!),
      );
      return { success: true, data: projected, ...envelopeExtras };
    }

    // DR-8 — compact by default (drop verbose/optional fields); `detail:true` full.
    const rows: Array<TaskDetail | CompactTaskDetail> = args.detail
      ? windowed
      : windowed.map(compactTaskDetail);
    return { success: true, data: rows, ...envelopeExtras };
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
