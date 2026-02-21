import type { WorkflowEvent } from '../event-store/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import type { QueryFilters } from '../event-store/store.js';

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
      correlationId?: string;
      causationId?: string;
      agentId?: string;
      agentRole?: string;
      source?: string;
      schemaVersion?: string;
      data?: Record<string, unknown>;
      idempotencyKey?: string;
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
  queryEvents(streamId: string, filters?: QueryFilters): WorkflowEvent[];
  getSequence(streamId: string): number;

  // State operations
  getState(featureId: string): WorkflowState | null;
  setState(featureId: string, state: WorkflowState, expectedVersion?: number): void;
  listStates(): Array<{ featureId: string; state: WorkflowState }>;

  // Outbox operations
  addOutboxEntry(streamId: string, event: WorkflowEvent): string;
  drainOutbox(streamId: string, sender: EventSender, batchSize?: number): DrainResult;

  // View cache operations
  getViewCache(streamId: string, viewName: string): ViewCacheEntry | null;
  setViewCache(streamId: string, viewName: string, state: unknown, hwm: number): void;

  // Lifecycle
  initialize(): void;
  close(): void;
}
