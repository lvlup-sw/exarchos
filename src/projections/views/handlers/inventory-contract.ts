import { DEFAULT_VIEW_ITEM_CAP } from '../../../dispatch/core/economy.js';
import type { NextAction } from '../../../next-action.js';
import type { TimelineTask } from '../delegation-timeline-view.js';
import type { TaskDetail } from '../task-detail-view.js';
import type { TeammateMetrics } from '../team-performance-view.js';

// ─── DR-8 (Task 013): generalized inventory-view contract helpers ────────────
//
// The `pipeline` and `worktrees` views were migrated first (#1659 + the shared
// `dispatch/core/economy.ts` kit). This batch generalizes the SAME contract to the
// remaining list/inventory-shaped views in this file:
//   • `page: {total, offset, limit, hasMore}` metadata when list-shaped;
//   • `detail: true` honored — compact by default, full rows on request;
//   • P5 scope perceivability — a scoped view reports `scope` + `unscopedTotal`
//     so rows hidden by the scope (a filter, not just paging) stay perceivable.
// Each migrated view rides Task 003's dispatch-core economy backstop and carries
// a DR-2-style token-budget test. The `tasks` view keeps its bare-array `data`
// contract for now (many in-repo consumers read `data` as an array); its page /
// scope metadata rides `_meta` in the interim, and the full `data` reshape is
// DR-12's consumer-migration work. The other list views carry the metadata in
// `data` directly, matching the `pipeline` precedent.

/**
 * Resolve the deterministic paging window shared by the inventory views. When
 * the caller omits `limit`, cap at `defaultCap` so a large inventory never dumps
 * every row; an explicit `limit` is honored verbatim.
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
 * P5 escape-hatch affordance for a FILTER-scoped view (mirrors pipeline's
 * `scopeAllAffordance` for repo scope). Fires whenever the active scope hid rows
 * (`unscopedTotal > page.total`) so the elided rows are always perceivable. Verb
 * is the view's own name so it validates against the catch-all `NextActionSchema`.
 */
export function scopeHiddenAffordance(verb: string, hiddenCount: number): NextAction {
  return {
    verb,
    reason: `${hiddenCount} row${hiddenCount === 1 ? '' : 's'} hidden by the active scope/filter — remove the filter (or widen the query) to include ${hiddenCount === 1 ? 'it' : 'them'}.`,
    hint: `exarchos vw ${verb}`,
  };
}

/** DR-8 compact `TimelineTask`: drop the verbose ISO timestamps; `detail:true` restores them. */
export type CompactTimelineTask = Omit<TimelineTask, 'assignedAt' | 'completedAt'>;
export function compactTimelineTask(t: TimelineTask): CompactTimelineTask {
  const { assignedAt: _assignedAt, completedAt: _completedAt, ...rest } = t;
  return rest;
}

/** DR-8 compact `TeammateMetrics`: drop the per-teammate module-expertise list; `detail:true` restores it. */
export type CompactTeammateMetrics = Omit<TeammateMetrics, 'moduleExpertise'>;
export function compactTeammate(m: TeammateMetrics): CompactTeammateMetrics {
  const { moduleExpertise: _moduleExpertise, ...rest } = m;
  return rest;
}

/** DR-8 compact `TaskDetail`: drop the verbose/optional fields; `detail:true` restores them. */
export type CompactTaskDetail = Omit<TaskDetail, 'artifacts' | 'error' | 'tddPhase' | 'duration'>;
export function compactTaskDetail(t: TaskDetail): CompactTaskDetail {
  const { artifacts: _artifacts, error: _error, tddPhase: _tddPhase, duration: _duration, ...rest } = t;
  return rest;
}
