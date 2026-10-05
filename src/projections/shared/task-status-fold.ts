/**
 * Monotonic task-status fold, shared by the rehydration reducer and the pipeline view.
 * Both compute task counts and per-id status from one ranking table.
 *
 * A fold only moves an entry up the ladder: pending, in_progress, then complete
 * or failed. The planner stamps the plan again and again, so a later
 * `state.patched` must not move a terminal status back to pending.
 */

/** Canonical task-progress status. It mirrors `TaskSchema.status` in `workflow/schemas.ts`. */
export type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'failed';

/**
 * Status ladder. The higher rank wins a promotion. `complete` and `failed` share
 * rank 2, so neither replaces the other.
 */
export const STATUS_RANK: Readonly<Record<TaskStatus, number>> = {
  pending: 0,
  in_progress: 1,
  complete: 2,
  failed: 2,
};

/** Rank of a status string. An unknown status ranks 0, so it cannot block a promotion. */
export function rankOf(status: string): number {
  return Object.prototype.hasOwnProperty.call(STATUS_RANK, status)
    ? STATUS_RANK[status as TaskStatus]
    : 0;
}

/**
 * Map a status value to `TaskStatus`. An unknown value becomes `pending`.
 *
 * `state.patched` events from `handleSet` skip the `TaskStatusSchema` preprocess,
 * so old events keep the legacy words. This function maps `'completed'` to
 * `'complete'` and `'assigned'` to `'in_progress'`, the same as
 * `upgradeRehydrationDocumentV3toV4`. Without that map, those tasks fall back to
 * `pending` and the counts go wrong.
 */
export function normalizeTaskStatus(raw: unknown): TaskStatus {
  if (raw === 'failed') return 'failed';
  if (raw === 'complete' || raw === 'completed') return 'complete';
  if (raw === 'in_progress' || raw === 'assigned') return 'in_progress';
  return 'pending';
}

/**
 * Set `tasksById[id]` to `nextStatus` when the entry is absent or has a lower rank.
 * It does not change the input. It returns a new map, or the input when nothing changes.
 */
export function promoteStatus(
  tasksById: Readonly<Record<string, string>>,
  id: string,
  nextStatus: TaskStatus,
): Record<string, string> {
  const existing = tasksById[id];
  if (existing === undefined) {
    return { ...tasksById, [id]: nextStatus };
  }
  if (rankOf(nextStatus) > rankOf(existing)) {
    return { ...tasksById, [id]: nextStatus };
  }
  return tasksById as Record<string, string>;
}

/** The id and canonical status of one task from a `state.patched` patch. */
export interface ExtractedPlanTask {
  readonly id: string;
  readonly status: TaskStatus;
}

/**
 * Read the id and status of each entry in `data.patch.tasks` of a `state.patched`
 * event. An entry without a non-empty string `id` is skipped, because a partial
 * entry can update other fields only. Returns `undefined` when no entry remains.
 */
export function extractPlanTasksFromPatch(
  data: { readonly [key: string]: unknown } | undefined,
): readonly ExtractedPlanTask[] | undefined {
  if (!data) return undefined;
  const patch = data['patch'];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return undefined;
  }
  const tasksRaw = (patch as Record<string, unknown>)['tasks'];
  if (!Array.isArray(tasksRaw)) {
    return undefined;
  }

  const out: ExtractedPlanTask[] = [];
  for (const entry of tasksRaw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e['id'] === 'string' ? (e['id'] as string) : undefined;
    if (!id) continue;
    out.push({ id, status: normalizeTaskStatus(e['status']) });
  }

  return out.length > 0 ? out : undefined;
}
