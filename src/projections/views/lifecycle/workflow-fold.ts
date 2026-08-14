import type {
  StorageBackend,
  WorkflowLifecycleStatus,
  WorkflowSummaryFilter,
} from '../../../storage/backend.js';

/**
 * Workflow-fold view (DR-3) — the read half of the `ps` workflows fold.
 *
 * Folds the backend's {@link StorageBackend.listWorkflowSummaries} rows into
 * the display shape a `ps`-style listing renders: one row per workflow with a
 * computed `ageMs`. The heavy lifting (the indexed `workflow_type` pushdown,
 * the lifecycle-axis filtering, the terminal-state default) lives in the
 * backend so both storage implementations stay row-for-row equivalent; this
 * view is the thin, backend-agnostic layer that adds age.
 *
 * It is NOT an event fold — it reads the projected summary rows, never a
 * `switch (event.type)` over `WorkflowEvent` — so it sits entirely outside the
 * single-workflow-fold CI gate (`tools/audit/gates/check-single-workflow-fold.mjs`).
 */

/**
 * One rendered workflow row. `ageMs` is the elapsed time since the workflow's
 * earliest event envelope, or `null` when the stream carries no events (no
 * envelope to measure from).
 */
export interface WorkflowFoldRow {
  readonly featureId: string;
  readonly workflowType: string;
  readonly phase: string;
  readonly status: WorkflowLifecycleStatus;
  readonly ageMs: number | null;
}

/**
 * Options for {@link foldWorkflowSummaries}: the backend
 * {@link WorkflowSummaryFilter} plus an injectable clock for deterministic age
 * assertions.
 */
export interface WorkflowFoldOptions extends WorkflowSummaryFilter {
  /** Wall-clock reference for age computation, in epoch ms. Defaults to `Date.now()`. */
  nowMs?: number;
}

/**
 * Read the filtered workflow summaries from `backend` and fold them into
 * {@link WorkflowFoldRow}s, computing `ageMs` from each row's event-envelope
 * `createdAt` against `nowMs`.
 *
 * Rows are ordered oldest-first (largest `ageMs`), with envelope-less rows
 * (`ageMs === null`) sorted last and `featureId` as a stable tie-break — the
 * order a `ps` listing wants (the stalest workflows, the ones most likely to
 * need attention, surface at the top).
 */
export function foldWorkflowSummaries(
  backend: StorageBackend,
  options: WorkflowFoldOptions = {},
): WorkflowFoldRow[] {
  const { nowMs, ...filter } = options;
  const now = nowMs ?? Date.now();

  const rows: WorkflowFoldRow[] = backend
    .listWorkflowSummaries(filter)
    .map((summary) => ({
      featureId: summary.featureId,
      workflowType: summary.workflowType,
      phase: summary.phase,
      status: summary.status,
      ageMs: computeAgeMs(summary.createdAt, now),
    }));

  rows.sort((a, b) => {
    // Nulls last; otherwise oldest (largest age) first.
    if (a.ageMs === null && b.ageMs === null) return a.featureId.localeCompare(b.featureId);
    if (a.ageMs === null) return 1;
    if (b.ageMs === null) return -1;
    if (a.ageMs !== b.ageMs) return b.ageMs - a.ageMs;
    return a.featureId.localeCompare(b.featureId);
  });

  return rows;
}

/**
 * Elapsed ms from an ISO-8601 event-envelope timestamp to `nowMs`. Returns
 * `null` when there is no envelope (`createdAt === null`) or the timestamp is
 * unparseable, and clamps negative ages (a clock-skewed future envelope) to 0
 * so `ageMs` is never negative.
 */
function computeAgeMs(createdAt: string | null, nowMs: number): number | null {
  if (createdAt === null) return null;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return null;
  return Math.max(0, nowMs - created);
}
