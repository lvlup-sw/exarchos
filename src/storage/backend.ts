import type { WorkflowEvent } from '../events/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import type { QueryFilters } from '../events/store.js';
import type { SnapshotRecord } from '../projections/snapshot-schema.js';

export type { QueryFilters } from '../events/store.js';

/**
 * Abstraction for sending events to a remote endpoint.
 * Used by outbox drain operations to decouple from specific transport implementations.
 */
export interface EventSender {
  appendEvents(
    streamId: string,
    events: Array<{
      streamId: string;
      sequence: number;
      timestamp: string;
      type: string;
      correlationId?: string | undefined;
      causationId?: string | undefined;
      agentId?: string | undefined;
      agentRole?: string | undefined;
      source?: string | undefined;
      schemaVersion?: string | undefined;
      data?: Record<string, unknown> | undefined;
      idempotencyKey?: string | undefined;
    }>,
  ): Promise<{ accepted: number; streamVersion: number }>;
}

/** Cached view state with its high-water mark for incremental materialization. */
export interface ViewCacheEntry {
  readonly state: unknown;
  readonly highWaterMark: number;
}

/** Result of draining the outbox for a given stream. */
export interface DrainResult {
  readonly sent: number;
  readonly failed: number;
}

/**
 * Coarse lifecycle status derived from the phase of a workflow. Each phase other
 * than `completed`, `cancelled`, and `blocked` maps to `active`. Only `completed`
 * and `cancelled` are terminal. A blocked workflow can resume, so it stays in the
 * default listing.
 */
export type WorkflowLifecycleStatus = 'active' | 'completed' | 'cancelled' | 'blocked';

/** The terminal lifecycle statuses excluded from the default `ps` listing. */
export const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<WorkflowLifecycleStatus> = new Set<WorkflowLifecycleStatus>([
  'completed',
  'cancelled',
]);

/**
 * Map a workflow `phase` string to its coarse {@link WorkflowLifecycleStatus}.
 * Both backends use it, so SQLite and memory derive `status` the same way. Every
 * workflow type uses the phase names `completed`, `cancelled`, and `blocked`.
 */
export function deriveWorkflowStatus(phase: string): WorkflowLifecycleStatus {
  switch (phase) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'blocked':
      return 'blocked';
    default:
      return 'active';
  }
}

/** Whether a lifecycle status is terminal (hidden from the default listing). */
export function isTerminalWorkflowStatus(status: WorkflowLifecycleStatus): boolean {
  return TERMINAL_WORKFLOW_STATUSES.has(status);
}

/**
 * Filter for {@link StorageBackend.listWorkflowSummaries}. An omitted field adds
 * no constraint. SQLite filters `workflowType` on the indexed
 * `streams.workflow_type` column. {@link matchesWorkflowSummaryFilter} applies
 * `status`, `phase`, and `includeTerminal` the same way on both backends.
 */
export interface WorkflowSummaryFilter {
  /** Exact `workflow_type` match — pushed down to the indexed column in SQLite. */
  workflowType?: string | undefined;
  /** Exact derived-{@link WorkflowLifecycleStatus} match. Authoritative over the terminal default. */
  status?: WorkflowLifecycleStatus;
  /** Exact `phase` match. */
  phase?: string;
  /**
   * Include terminal (`completed`/`cancelled`) workflows. Defaults to `false`
   * — the default listing shows only live/blocked workflows. Ignored when an
   * explicit `status` is supplied (that status is then authoritative).
   */
  includeTerminal?: boolean;
}

/**
 * One row of the workflow-summary read model: the minimal projection a
 * `ps`-style listing folds. `createdAt` is the earliest event-envelope
 * timestamp for the stream (ISO-8601), or `null` when the stream carries no
 * events — the consuming view computes `ageMs` from it.
 */
export interface WorkflowSummary {
  readonly featureId: string;
  readonly workflowType: string;
  readonly phase: string;
  readonly status: WorkflowLifecycleStatus;
  readonly createdAt: string | null;
}

/**
 * Lifecycle predicate that both backends apply, so they return the same rows. It
 * does not check `workflowType`. SQLite filters that axis in SQL, so a broken
 * pushdown shows foreign rows and a second filter here does not hide them.
 *
 * An explicit `status` wins, terminal or not. Without `status`, terminal
 * workflows show only when `includeTerminal` is set.
 */
export function matchesWorkflowSummaryFilter(
  summary: WorkflowSummary,
  filter: WorkflowSummaryFilter,
): boolean {
  if (filter.phase !== undefined && summary.phase !== filter.phase) return false;
  if (filter.status !== undefined) {
    return summary.status === filter.status;
  }
  if (!filter.includeTerminal && isTerminalWorkflowStatus(summary.status)) return false;
  return true;
}

/**
 * Decouples storage consumers from the backing implementation.
 *
 * Provides operations for:
 * - Event append and query (event sourcing)
 * - Workflow state get/set with CAS versioning
 * - Outbox for reliable event replication
 * - View cache for materialized view snapshots
 * - Cleanup for lifecycle compaction and rotation
 * - Lifecycle management (initialize/close)
 */
export interface StorageBackend {
  appendEvent(streamId: string, event: WorkflowEvent): void;
  queryEvents(streamId: string, filters?: QueryFilters): WorkflowEvent[];
  getSequence(streamId: string): number;
  listStreams(): string[];

  /**
   * Change token for the Tier-2 cross-process poll floor (`events/subscriptions.ts`).
   * The floor loop drains its cursor only when the value changes between two reads
   * on the same backend instance. The absolute value has no meaning.
   *
   * SQLite returns `PRAGMA data_version`, which changes only on commits from other
   * connections. The Tier-1 hook already covers commits of this process. The memory
   * backend returns a count of appends, so its own appends also change it. The extra drain
   * is cursor-guarded and never delivers an event twice.
   */
  dataVersion(): number;

  /**
   * Cross-stream query (optional). Returns each event of `eventType` whose stream
   * equals `streamPrefix` or starts with `streamPrefix + '/'`. When a backend omits
   * it, `EventStore.queryByType` enumerates `listStreams()` and filters locally.
   */
  queryEventsByType?(
    eventType: string,
    streamPrefix: string,
    filters?: QueryFilters,
  ): WorkflowEvent[];

  getState(featureId: string): WorkflowState | null;
  setState(featureId: string, state: WorkflowState, expectedVersion?: number): void;
  listStates(): Array<{ featureId: string; state: WorkflowState }>;

  /**
   * Cross-workflow summary read for the `ps` workflows fold. Returns one
   * {@link WorkflowSummary} per tracked workflow.
   *
   * SQLite joins `workflow_state` and `streams` and filters `workflow_type` in SQL
   * through the `idx_streams_workflow_type` index, never in JS. The memory backend
   * derives the same fields and filters in JS. Both apply {@link matchesWorkflowSummaryFilter}
   * for the lifecycle axes, so they return the same rows.
   */
  listWorkflowSummaries(filter?: WorkflowSummaryFilter): WorkflowSummary[];

  addOutboxEntry(streamId: string, event: WorkflowEvent): string;
  /**
   * Async because `sender.appendEvents` returns a Promise. The backend must await
   * it before it confirms a row. Otherwise a rejected send strands the event in
   * the outbox with no retry.
   */
  drainOutbox(
    streamId: string,
    sender: EventSender,
    batchSize?: number,
  ): Promise<DrainResult>;

  getViewCache(streamId: string, viewName: string): ViewCacheEntry | null;
  setViewCache(streamId: string, viewName: string, state: unknown, hwm: number): void;

  deleteStream(streamId: string): void;
  deleteState(featureId: string): void;
  pruneEvents(streamId: string, beforeTimestamp: string): number;

  initialize(): void;
  close(): void;

  /**
   * Run a narrow integrity probe (optional). Only backends with on-disk integrity,
   * such as SQLite, implement it. When it is absent, the caller treats the check
   * as not applicable. `EventStore.runIntegrityCheck` treats any verdict other than
   * `ok` as corruption and enforces the timeout. The backend must honor `signal`.
   */
  runIntegrityPragma?(signal?: AbortSignal): Promise<string>;

  /**
   * Register a stream with its workflow type in the `streams` table (optional).
   * When it is absent, `EventStore.registerStream` does nothing. A second call for
   * the same `streamId` keeps the original row (`INSERT OR IGNORE`). The
   * `workflow_type` column is immutable. A grep-gate test forbids an `UPDATE` of
   * it outside the migration recovery path.
   */
  registerStream?(streamId: string, workflowType: string): void;

  /**
   * Return the snapshot record with the highest sequence for the given
   * (streamId, projectionId, projectionVersion) coordinate, or `undefined`
   * when no record exists.
   *
   * Required by both SqliteBackend and InMemoryBackend so the projection
   * store can read the latest cached state without a full event replay.
   */
  readLatestProjectionSnapshot(
    streamId: string,
    projectionId: string,
    projectionVersion: string,
  ): SnapshotRecord | undefined;

  /**
   * Append a snapshot record for the given stream. When `opts.maxRecords` is
   * provided (or resolved from the environment via `resolveMaxRecords`), the
   * oldest records for that (streamId, projectionId, projectionVersion)
   * coordinate are pruned so the total count does not exceed the cap.
   */
  appendProjectionSnapshot(
    streamId: string,
    record: SnapshotRecord,
    opts?: {
      maxRecords?: number;
      /**
       * Hook that runs when the size cap removes the oldest rows. `prunedCount` is
       * the number of rows removed. It runs synchronously inside the append
       * transaction, so it must not throw.
       */
      onPrune?: (prunedCount: number) => void;
    },
  ): void;
}
