import { toViewFailure } from '../../degraded-result.js';
import { narrowAffordance } from '../../../dispatch/core/economy.js';
import { EventStore } from '../../../events/store.js';
import { pickFields, type ToolResult } from '../../../format.js';
import type { NextAction } from '../../../next-action.js';
import { TASK_DETAIL_VIEW, type TaskDetail, type TaskDetailViewState } from '../task-detail-view.js';
import { CompactTaskDetail, compactTaskDetail, resolveInventoryWindow, scopeHiddenAffordance } from './inventory-contract.js';
import { getOrCreateMaterializer } from './materializer.js';
import { buildPage } from './pipeline.js';
import { foldToTail } from '../../fold-at-tail.js';
import { readWorkflowStateJson } from './streams.js';

/**
 * Returns the tasks of a workflow, filtered and in pages.
 * The task-detail projection holds only tasks with a `task.assigned` event, so the handler adds the other tasks from `state.tasks`.
 * A projection entry wins over a state entry with the same id.
 * State statuses other than `failed`, `complete`, `completed`, and `in_progress` map to `pending`, so a task with no dispatch never shows as `assigned`.
 *
 * Callers read `data` as an array, so `page`, `scope`, and `unscopedTotal` (the count before the filter) go in `_meta`.
 * A `fields` list picks from the full rows. Without it, rows are compact unless `detail` is true.
 */
export async function handleViewTasks(
  args: {
    workflowId?: string;
    filter?: Record<string, unknown>;
    limit?: number;
    offset?: number;
    fields?: string[];
    detail?: boolean;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const { view } = await foldToTail<TaskDetailViewState>(store, materializer, streamId, TASK_DETAIL_VIEW);

    const state = await readWorkflowStateJson(stateDir, streamId);
    const stateTasksRaw = state?.['tasks'];
    const merged: Record<string, TaskDetail> = { ...view.tasks };
    if (Array.isArray(stateTasksRaw)) {
      for (const entry of stateTasksRaw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const e = entry as Record<string, unknown>;
        const id = typeof e['id'] === 'string' ? (e['id'] as string) : undefined;
        if (!id || merged[id]) continue;
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

    const unscopedTotal = allTasks.length;
    const filterActive =
      args.filter !== undefined && Object.keys(args.filter).length > 0;

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

    const { start, effectiveLimit } = resolveInventoryWindow(args);
    const windowed = filteredTasks.slice(start, start + effectiveLimit);

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

    if (args.fields) {
      const projected = windowed.map(
        (t) => pickFields(t as unknown as Record<string, unknown>, args.fields!),
      );
      return { success: true, data: projected, ...envelopeExtras };
    }

    const rows: Array<TaskDetail | CompactTaskDetail> = args.detail
      ? windowed
      : windowed.map(compactTaskDetail);
    return { success: true, data: rows, ...envelopeExtras };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'tasks' });
  }
}
