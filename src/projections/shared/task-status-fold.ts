/**
 * Shared monotonic task-status fold helper (#1359 / PR4 T13).
 *
 * Used by both the rehydration projection reducer
 * (`projections/rehydration/reducer.ts`) and the pipeline view projection
 * (`projections/views/pipeline-view.ts`) so both surfaces compute taskCount /
 * completedCount / per-id status from a single ranking table.
 *
 * Canonical vocabulary mirrors the workflow-side `TaskSchema.status` enum
 * (`workflow/schemas.ts`): `pending | in_progress | complete | failed`.
 *
 * Monotonic promotion rule: a fold can ONLY advance an entry up the
 * precedence ladder (pending → in_progress → complete/failed). It must NOT
 * regress a terminal status back to pending (the planner stamps the plan
 * repeatedly; events / later state.patched re-assertions must not undo
 * execution truth). Per CR review 4178067854.
 */

/**
 * Canonical task-progress status union — single source of truth for both
 * projection reducers. Mirrors `TaskSchema.status` post-#1359.
 */
export type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'failed';

/**
 * Status precedence ladder. Higher rank "wins" when promoting an entry.
 * `complete` and `failed` are sibling terminal ranks (rank 2) — neither
 * regresses to the other.
 */
export const STATUS_RANK: Readonly<Record<TaskStatus, number>> = {
  pending: 0,
  in_progress: 1,
  complete: 2,
  failed: 2,
};

/**
 * Look up the rank of an arbitrary string status, defaulting to 0 for any
 * value outside the canonical ladder so unknown statuses can never block a
 * known promotion.
 */
export function rankOf(status: string): number {
  return Object.prototype.hasOwnProperty.call(STATUS_RANK, status)
    ? STATUS_RANK[status as TaskStatus]
    : 0;
}

/**
 * Normalize a `TaskSchema.status` value (or close approximation thereof)
 * into the canonical TaskStatus surface. Anything not recognized falls
 * back to `pending` — the safe default for plan-state assertion folds.
 *
 * Legacy aliases (Sentry follow-ups on PR #1394) — `state.patched`
 * events emitted by `handleSet` do NOT route their `input.updates`
 * through `TaskStatusSchema`'s `z.preprocess`, so historical events with
 * pre-#1359 vocabulary arrive at projections unchanged. The mappings
 * below mirror `upgradeRehydrationDocumentV3toV4` (`projections/
 * rehydration/upgrade.ts`) so the on-disk migration and the live event
 * fold agree byte-for-byte on legacy → canonical:
 *
 *   - `'completed'` → `'complete'`     (matches `TaskStatusSchema` preprocess)
 *   - `'assigned'`  → `'in_progress'`  (matches v3→v4 task vocabulary rename)
 *
 * Without these, tasks silently downgrade to `pending` (the
 * unrecognized-value fallback), breaking taskCount / completedCount and
 * risking re-dispatch of work already in flight or finished.
 */
export function normalizeTaskStatus(raw: unknown): TaskStatus {
  if (raw === 'failed') return 'failed';
  if (raw === 'complete' || raw === 'completed') return 'complete';
  if (raw === 'in_progress' || raw === 'assigned') return 'in_progress';
  return 'pending';
}

/**
 * Monotonically promote `tasksById[id]` to `nextStatus` if and only if
 * `nextStatus` outranks the existing entry. Returns a new map; never
 * mutates the input.
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

/**
 * Extract `{id, status}[]` from a `state.patched` event's `data.patch.tasks`
 * subtree, mapping each entry onto canonical TaskStatus. Returns
 * `undefined` when the event has no actionable tasks subtree.
 *
 * The workflow-side `TaskSchema` carries many fields; we only consume id +
 * status. Anything without a non-empty string `id` is skipped — the patch
 * could carry an intentionally partial entry (e.g. only `title` updates)
 * that we should not invent an id for.
 */
export interface ExtractedPlanTask {
  readonly id: string;
  readonly status: TaskStatus;
}

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
