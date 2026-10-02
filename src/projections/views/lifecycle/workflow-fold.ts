/**
 * Workflow-fold view: the read half of the `ps` workflows fold.
 * It adds a computed `ageMs` to the {@link StorageBackend.listWorkflowSummaries} rows.
 * The backend applies the filters and the defaults, so both storage implementations give the same rows.
 * It reads summary rows, not events, so the single-workflow-fold CI gate (`tools/audit/gates/check-single-workflow-fold.mjs`) does not apply to it.
 */
import type {
  StorageBackend,
  WorkflowLifecycleStatus,
  WorkflowSummaryFilter,
} from '../../../storage/backend.js';

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
 * Reads the filtered summaries from `backend`, and computes `ageMs` from each `createdAt` and `nowMs`.
 * The rows sort oldest first, with `ageMs === null` rows last and `featureId` as the tie-break. Thus the stalest workflows come first.
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
