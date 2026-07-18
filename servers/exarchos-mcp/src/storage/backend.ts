import type { WorkflowEvent } from '../event-store/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import type { QueryFilters } from '../event-store/store.js';
import type { SnapshotRecord } from '../projections/snapshot-schema.js';

// Re-export QueryFilters for consumers of the StorageBackend
export type { QueryFilters } from '../event-store/store.js';

// ─── Event Sender ───────────────────────────────────────────────────────────

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

// ─── View Cache Entry ───────────────────────────────────────────────────────

/** Cached view state with its high-water mark for incremental materialization. */
export interface ViewCacheEntry {
  readonly state: unknown;
  readonly highWaterMark: number;
}

// ─── Drain Result ───────────────────────────────────────────────────────────

/** Result of draining the outbox for a given stream. */
export interface DrainResult {
  readonly sent: number;
  readonly failed: number;
}

// ─── Workflow Summary (DR-3, `ps` fold) ──────────────────────────────────────

/**
 * Coarse lifecycle status derived from a workflow's phase. Distinct from the
 * fine-grained `phase` (`plan`, `delegate`, `triage`, …): `status` collapses
 * every non-terminal phase to `active` and surfaces only the three states a
 * `ps`-style listing cares about — is this workflow still running, did it
 * finish, was it cancelled, or is it wedged (`blocked`)?
 *
 * `completed` and `cancelled` are the terminal states (see
 * {@link isTerminalWorkflowStatus}); `blocked` is NOT terminal (a blocked
 * workflow can be resumed), so it stays visible in the default listing.
 */
export type WorkflowLifecycleStatus = 'active' | 'completed' | 'cancelled' | 'blocked';

/** The terminal lifecycle statuses excluded from the default `ps` listing. */
export const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<WorkflowLifecycleStatus> = new Set<WorkflowLifecycleStatus>([
  'completed',
  'cancelled',
]);

/**
 * Map a workflow `phase` string to its coarse {@link WorkflowLifecycleStatus}.
 *
 * Shared by both backends so the SQLite (join + json_extract) and in-memory
 * (state-object) read paths derive `status` identically — the linchpin of the
 * `ListWorkflowSummaries_BackendContract_SharedAcrossSqliteAndInMemory`
 * parity contract. The terminal phases (`completed`, `cancelled`) and the
 * resumable `blocked` phase are recognised by name across every workflow type
 * (feature/debug/refactor/oneshot/discovery all share those three terminal
 * phase labels); any other phase is `active`.
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
 * Filter passed to {@link StorageBackend.listWorkflowSummaries}.
 *
 * All fields are optional; an omitted field means "no constraint on that
 * axis". `workflowType` is the indexed pushdown axis (SQLite filters it in SQL
 * against `streams.workflow_type`); `status`/`phase`/`includeTerminal` are the
 * lifecycle axes applied by {@link matchesWorkflowSummaryFilter} identically on
 * both backends.
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
 * Shared lifecycle predicate applied by BOTH backends so SQLite and in-memory
 * agree row-for-row (INV-2 facade equivalence). Deliberately does NOT re-check
 * `workflowType`: SQLite owns that axis via the indexed SQL WHERE and the
 * in-memory backend applies it in JS separately, so leaving it out here keeps
 * the SQLite pushdown behaviourally load-bearing (a broken pushdown leaks
 * foreign-type rows rather than being silently re-filtered here).
 *
 * Terminal handling: an explicit `status` is authoritative — filtering for
 * `completed` returns completed workflows even without `includeTerminal`.
 * With no explicit `status`, terminal workflows are hidden unless
 * `includeTerminal` is set.
 */
export function matchesWorkflowSummaryFilter(
  summary: WorkflowSummary,
  filter: WorkflowSummaryFilter,
): boolean {
  if (filter.phase !== undefined && summary.phase !== filter.phase) return false;
  if (filter.status !== undefined) {
    // Explicit status is authoritative, terminal or not.
    return summary.status === filter.status;
  }
  if (!filter.includeTerminal && isTerminalWorkflowStatus(summary.status)) return false;
  return true;
}

// ─── Storage Backend Interface ──────────────────────────────────────────────

/**
 * Decouples storage consumers from the backing implementation.
 *
 * Provides operations for:
 * - Event append and query (event sourcing)
 * - Workflow state get/set with CAS versioning
 * - Outbox for reliable event replication
 * - View cache for materialized view snapshots
 * - Lifecycle management (initialize/close)
 */
export interface StorageBackend {
  // Event operations
  appendEvent(streamId: string, event: WorkflowEvent): void;

  /**
   * Filtered event read. Applies the window filters
   * (`type`/`types`/`sinceSequence`/`since`/`until`/correlation tuple), then
   * `order` (DR-11 `'desc'` = newest-first), then pagination.
   *
   * Pagination contract (INV-2 backend parity — both backends MUST agree):
   * `limit` and `offset` are honored INDEPENDENTLY, not only when supplied
   * together. A limit-only call bounds the window (it does NOT return the full
   * stream); an offset-only call skips `offset` rows from the ordered window
   * start and returns the remainder; both compose with `order`. The
   * shared-contract parity suite
   * (`storage/__tests__/backend-contract.test.ts`) pins limit-only and
   * offset-only equivalence across {@link SqliteBackend} and
   * {@link InMemoryBackend}.
   */
  queryEvents(streamId: string, filters?: QueryFilters): WorkflowEvent[];

  /**
   * Filtered event count (DR-11, #1685). Returns how many events on
   * `streamId` match the window filters (`type`/`types`/`sinceSequence`/
   * `since`/`until`/correlation tuple). Pagination fields (`limit`/`offset`)
   * and `order` are ignored — the count is always over the full matching
   * set, which is what pagination metadata (`total`, `hasMore`) needs.
   *
   * Required (not optional): both production backends implement it and the
   * bounded default-query path (`EventStore.queryPage`) relies on it.
   * Backend obligations (INV-2 facade equivalence, INV-17 economy):
   *  - {@link SqliteBackend}: `SELECT COUNT(*)` sharing the exact WHERE
   *    builder `queryEvents` uses — no row materialization, and the count
   *    and the row query can never disagree about which events match.
   *  - {@link InMemoryBackend}: capability-equivalent JS count over the
   *    same window-filter predicate.
   */
  countEvents(streamId: string, filters?: QueryFilters): number;

  getSequence(streamId: string): number;
  listStreams(): string[];

  /**
   * Change token consumed by the Tier-2 cross-process poll floor
   * (`event-store/subscriptions.ts`). The floor loop re-reads this on every
   * tick and drains its cursor ONLY when the value changed since the last
   * read — so a foreign writer's commit is delivered without re-scanning the
   * event log every tick.
   *
   * The absolute value is meaningless; only equality between two successive
   * reads on the SAME backend instance is load-bearing. Semantics differ
   * per backend, but both satisfy the floor-loop contract — "the token
   * differs from its previous value whenever an event this observer has not
   * yet drained may have been committed by a party the Tier-1 in-process
   * hook does NOT cover":
   *
   *  - {@link SqliteBackend}: `PRAGMA data_version`. SQLite guarantees the
   *    value is UNCHANGED for commits on the observer's own connection and
   *    differs only when some OTHER connection (a foreign process) committed
   *    since the pragma last ran. That is exactly the Tier-2 signal: the
   *    Tier-1 hook already wakes on this process's own commits, so the floor
   *    must fire only on foreign ones. Near-free: a single-row pragma read
   *    that retains no open statement across ticks.
   *
   *  - {@link InMemoryBackend}: a monotonic counter bumped on every
   *    {@link StorageBackend.appendEvent}. In-memory has no cross-process
   *    notion, so "foreign" collapses to "any append" — the observer's own
   *    appends bump it. A single-process in-memory subscriber is already
   *    served by the Tier-1 hook, so a floor tick that fires on an own
   *    append merely triggers a redundant, cursor-guarded drain; it never
   *    double-delivers.
   *
   * Required (not optional): both production backends implement it, and the
   * subscription registry relies on its presence for the Tier-2 floor.
   */
  dataVersion(): number;

  /**
   * Cross-stream query reducer (DR-3, optional).
   *
   * Returns every event of `eventType` whose `streamId` matches `streamPrefix`
   * — either as an exact match or as a namespaced descendant
   * (`streamId === streamPrefix` OR `streamId LIKE streamPrefix || '/%'`).
   *
   * Optional: backends without a meaningful cross-stream index can omit this
   * method; `EventStore.queryByType` falls back to enumerating streams via
   * `listStreams()` and applying the structural filter locally.
   */
  queryEventsByType?(
    eventType: string,
    streamPrefix: string,
    filters?: QueryFilters,
  ): WorkflowEvent[];

  // State operations
  getState(featureId: string): WorkflowState | null;
  setState(featureId: string, state: WorkflowState, expectedVersion?: number): void;
  listStates(): Array<{ featureId: string; state: WorkflowState }>;

  /**
   * Cross-workflow summary read (DR-3) — the backend half of the `ps`
   * workflows fold. Returns one {@link WorkflowSummary} per tracked workflow,
   * filtered by {@link WorkflowSummaryFilter}.
   *
   * Required (not optional): both production backends implement it, and the
   * `workflow-fold` view relies on its presence.
   *
   * Backend obligations:
   *  - {@link SqliteBackend}: real pushdown — join `workflow_state × streams`
   *    and constrain `streams.workflow_type = ?` in SQL against the
   *    `idx_streams_workflow_type` index (never a post-fetch JS scan). Phase
   *    comes from `json_extract(state, '$.phase')`; `createdAt` from
   *    `MIN(events.timestamp)` per stream.
   *  - {@link InMemoryBackend}: capability-equivalent — derives the same fields
   *    from the in-memory state object and event arrays and applies the
   *    filter in JS (no index to consult).
   *
   * Both apply {@link matchesWorkflowSummaryFilter} for the lifecycle axes so
   * the two paths return the same rows for the same inputs.
   */
  listWorkflowSummaries(filter?: WorkflowSummaryFilter): WorkflowSummary[];

  // Outbox operations
  addOutboxEntry(streamId: string, event: WorkflowEvent): string;
  // `drainOutbox` is async because the sender's `appendEvents` returns a
  // Promise — the backend must await it before marking the row confirmed
  // or a network/remote rejection silently strands the event in the
  // outbox without a retry path. (CodeRabbit #1176, sqlite-backend:398.)
  drainOutbox(
    streamId: string,
    sender: EventSender,
    batchSize?: number,
  ): Promise<DrainResult>;

  // View cache operations
  getViewCache(streamId: string, viewName: string): ViewCacheEntry | null;
  setViewCache(streamId: string, viewName: string, state: unknown, hwm: number): void;

  // Cleanup operations (used by lifecycle compaction/rotation)
  deleteStream(streamId: string): void;
  deleteState(featureId: string): void;
  pruneEvents(streamId: string, beforeTimestamp: string): number;

  // Lifecycle
  initialize(): void;
  close(): void;

  /**
   * Run a narrow backend-integrity probe. Optional — only implementations
   * with a meaningful notion of on-disk integrity (e.g. sqlite) provide
   * this method; others (in-memory, remote) omit it and the caller
   * treats that as "integrity check not applicable".
   *
   * The returned string is the backend's verdict (e.g. "ok" for a healthy
   * sqlite database). Any other value is treated as corruption by
   * EventStore.runIntegrityCheck.
   *
   * Must honour `signal` for cooperative cancellation. Timeouts are
   * enforced by the caller (EventStore.runIntegrityCheck) so backends
   * only need to observe abort.
   */
  runIntegrityPragma?(signal?: AbortSignal): Promise<string>;

  /**
   * Register a stream in the typed-stream registry (Marten R-1, #1313).
   * Inserts one row into the `streams` table carrying the workflow type.
   * Optional — only backends with a typed-stream registry implement this;
   * in-memory and other backends omit it and the caller (EventStore.registerStream)
   * treats absence as a no-op.
   *
   * Idempotent: calling twice for the same streamId leaves the original row
   * untouched (INSERT OR IGNORE). The workflow_type column is immutable
   * post-insert — a CI grep gate (task 1.7) forbids workflow-type
   * UPDATE statements against the streams table outside of the
   * migration's recovery path.
   */
  registerStream?(streamId: string, workflowType: string): void;

  // ─── Projection Snapshot Accessors (Wave A, #1343) ────────────────────────

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
       * Optional observability hook fired when the size cap binds and the
       * backend evicts oldest rows. `prunedCount` is the exact number of
       * rows deleted. Synchronous; runs inside the backend's append
       * transaction (do not throw — log only).
       */
      onPrune?: (prunedCount: number) => void;
    },
  ): void;
}
