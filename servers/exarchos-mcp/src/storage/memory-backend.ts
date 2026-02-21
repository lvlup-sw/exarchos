import type { WorkflowEvent } from '../event-store/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import type { QueryFilters } from '../event-store/store.js';
import type { StorageBackend, EventSender, ViewCacheEntry, DrainResult } from './backend.js';

// ─── CAS Version Conflict Error ─────────────────────────────────────────────

export class VersionConflictError extends Error {
  constructor(
    public readonly featureId: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `Version conflict for '${featureId}': expected ${expected}, actual ${actual}`,
    );
    this.name = 'VersionConflictError';
  }
}

// ─── Internal State Entry ───────────────────────────────────────────────────

interface StateEntry {
  state: WorkflowState;
  version: number;
}

// ─── Internal Outbox Entry ──────────────────────────────────────────────────

interface OutboxItem {
  id: string;
  event: WorkflowEvent;
}

// ─── InMemoryBackend ────────────────────────────────────────────────────────

/**
 * Map-based in-memory implementation of StorageBackend.
 * Used as a test double and for lightweight in-process scenarios.
 */
export class InMemoryBackend implements StorageBackend {
  /** streamId -> events (append-only) */
  private readonly events = new Map<string, WorkflowEvent[]>();

  /** featureId -> { state, version } with CAS versioning */
  private readonly states = new Map<string, StateEntry>();

  /** streamId -> outbox items (FIFO) */
  private readonly outbox = new Map<string, OutboxItem[]>();

  /** `${streamId}:${viewName}` -> ViewCacheEntry */
  private readonly viewCache = new Map<string, ViewCacheEntry>();

  /** Counter for generating unique outbox entry IDs */
  private outboxIdCounter = 0;

  // ─── Event Operations ───────────────────────────────────────────────────

  appendEvent(streamId: string, event: WorkflowEvent): void {
    let stream = this.events.get(streamId);
    if (!stream) {
      stream = [];
      this.events.set(streamId, stream);
    }
    stream.push(event);
  }

  queryEvents(streamId: string, filters?: QueryFilters): WorkflowEvent[] {
    const stream = this.events.get(streamId);
    if (!stream) return [];

    let result = stream;

    if (filters?.sinceSequence !== undefined) {
      result = result.filter((e) => e.sequence > filters.sinceSequence!);
    }

    if (filters?.type) {
      result = result.filter((e) => e.type === filters.type);
    }

    if (filters?.since) {
      result = result.filter((e) => e.timestamp >= filters.since!);
    }

    if (filters?.until) {
      result = result.filter((e) => e.timestamp <= filters.until!);
    }

    if (filters?.offset) {
      result = result.slice(filters.offset);
    }

    if (filters?.limit !== undefined) {
      result = result.slice(0, filters.limit);
    }

    return result;
  }

  getSequence(streamId: string): number {
    const stream = this.events.get(streamId);
    if (!stream || stream.length === 0) return 0;
    return stream[stream.length - 1].sequence;
  }

  // ─── State Operations ───────────────────────────────────────────────────

  getState(featureId: string): WorkflowState | null {
    const entry = this.states.get(featureId);
    return entry ? entry.state : null;
  }

  setState(featureId: string, state: WorkflowState, expectedVersion?: number): void {
    const entry = this.states.get(featureId);
    const currentVersion = entry ? entry.version : 0;

    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw new VersionConflictError(featureId, expectedVersion, currentVersion);
    }

    this.states.set(featureId, {
      state,
      version: currentVersion + 1,
    });
  }

  listStates(): Array<{ featureId: string; state: WorkflowState }> {
    const result: Array<{ featureId: string; state: WorkflowState }> = [];
    for (const [featureId, entry] of this.states) {
      result.push({ featureId, state: entry.state });
    }
    return result;
  }

  // ─── Outbox Operations ──────────────────────────────────────────────────

  addOutboxEntry(streamId: string, event: WorkflowEvent): string {
    let items = this.outbox.get(streamId);
    if (!items) {
      items = [];
      this.outbox.set(streamId, items);
    }

    this.outboxIdCounter++;
    const id = `outbox-${this.outboxIdCounter}`;
    items.push({ id, event });
    return id;
  }

  drainOutbox(streamId: string, sender: EventSender, batchSize?: number): DrainResult {
    const items = this.outbox.get(streamId);
    if (!items || items.length === 0) {
      return { sent: 0, failed: 0 };
    }

    const batch = batchSize !== undefined ? items.splice(0, batchSize) : items.splice(0);
    let sent = 0;
    let failed = 0;

    for (const item of batch) {
      try {
        // Synchronous call - InMemoryBackend is a simple test double
        // The sender interface is async but we invoke it fire-and-forget
        sender.appendEvents(streamId, [
          {
            streamId: item.event.streamId,
            sequence: item.event.sequence,
            timestamp: item.event.timestamp,
            type: item.event.type,
            correlationId: item.event.correlationId,
            causationId: item.event.causationId,
            agentId: item.event.agentId,
            agentRole: item.event.agentRole,
            source: item.event.source,
            schemaVersion: item.event.schemaVersion,
            data: item.event.data,
            ...(item.event.idempotencyKey ? { idempotencyKey: item.event.idempotencyKey } : {}),
          },
        ]);
        sent++;
      } catch {
        failed++;
      }
    }

    return { sent, failed };
  }

  // ─── View Cache Operations ──────────────────────────────────────────────

  getViewCache(streamId: string, viewName: string): ViewCacheEntry | null {
    const key = `${streamId}:${viewName}`;
    return this.viewCache.get(key) ?? null;
  }

  setViewCache(streamId: string, viewName: string, state: unknown, hwm: number): void {
    const key = `${streamId}:${viewName}`;
    this.viewCache.set(key, { state, highWaterMark: hwm });
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  initialize(): void {
    // No-op for in-memory backend
  }

  close(): void {
    // No-op for in-memory backend
  }
}
