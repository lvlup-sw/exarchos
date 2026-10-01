/**
 * Shared contract helpers for the list-shaped inventory views.
 *
 * A list view reports `page: {total, offset, limit, hasMore}` and returns compact rows
 * unless the caller sets `detail: true`. A scoped view also reports `scope` and
 * `unscopedTotal`, so rows that a filter hides stay visible. The `tasks` view keeps a
 * bare-array `data` and puts that metadata in `_meta`, because callers read `data` as an array.
 */
import { DEFAULT_VIEW_ITEM_CAP } from '../../../dispatch/core/economy.js';
import type { NextAction } from '../../../next-action.js';
import type { TimelineTask } from '../delegation-timeline-view.js';
import type { TaskDetail } from '../task-detail-view.js';
import type { TeammateMetrics } from '../team-performance-view.js';

/**
 * Resolve the paging window of an inventory view. Without `limit`, the window holds at most
 * `defaultCap` rows, so a large inventory does not return every row. An explicit `limit` is used as given.
 */
export function resolveInventoryWindow(
  args: { limit?: number; offset?: number },
  defaultCap: number = DEFAULT_VIEW_ITEM_CAP,
): { start: number; effectiveLimit: number; explicitLimit: boolean } {
  const start = args.offset ?? 0;
  const explicitLimit = args.limit !== undefined;
  const effectiveLimit = explicitLimit ? (args.limit as number) : defaultCap;
  return { start, effectiveLimit, explicitLimit };
}

/**
 * Next action that tells the caller how many rows the active filter hides. It is the filter
 * counterpart of the pipeline `scopeAllAffordance`. The verb is the view name, so it passes
 * the catch-all `NextActionSchema`.
 */
export function scopeHiddenAffordance(verb: string, hiddenCount: number): NextAction {
  return {
    verb,
    reason: `${hiddenCount} row${hiddenCount === 1 ? '' : 's'} hidden by the active scope/filter — remove the filter (or widen the query) to include ${hiddenCount === 1 ? 'it' : 'them'}.`,
    hint: `exarchos vw ${verb}`,
  };
}

/** Compact `TimelineTask` without the ISO timestamps. `detail: true` returns them. */
export type CompactTimelineTask = Omit<TimelineTask, 'assignedAt' | 'completedAt'>;
export function compactTimelineTask(t: TimelineTask): CompactTimelineTask {
  const { assignedAt: _assignedAt, completedAt: _completedAt, ...rest } = t;
  return rest;
}

/** Compact `TeammateMetrics` without the module-expertise list. `detail: true` returns it. */
export type CompactTeammateMetrics = Omit<TeammateMetrics, 'moduleExpertise'>;
export function compactTeammate(m: TeammateMetrics): CompactTeammateMetrics {
  const { moduleExpertise: _moduleExpertise, ...rest } = m;
  return rest;
}

/** Compact `TaskDetail` without the optional detail fields. `detail: true` returns them. */
export type CompactTaskDetail = Omit<TaskDetail, 'artifacts' | 'error' | 'tddPhase' | 'duration'>;
export function compactTaskDetail(t: TaskDetail): CompactTaskDetail {
  const { artifacts: _artifacts, error: _error, tddPhase: _tddPhase, duration: _duration, ...rest } = t;
  return rest;
}
