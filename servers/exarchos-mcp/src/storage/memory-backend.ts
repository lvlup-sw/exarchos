import type { WorkflowEvent } from '../event-store/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import type { QueryFilters } from '../event-store/store.js';
import type { StorageBackend, EventSender, ViewCacheEntry, DrainResult } from './backend.js';
import type { SnapshotRecord } from '../projections/snapshot-schema.js';
import { resolveMaxRecords } from './snapshot-retention.js';

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

  /**
   * `${streamId}:${projectionId}:${projectionVersion}` -> SnapshotRecord[]
   * Stores snapshot records in insertion order; readLatest scans for max sequence.
   */
  private readonly projectionSnapshots = new Map<string, SnapshotRecord[]>();

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

    // #1437 (Wave 4) — post-fetch correlation-tuple filter. The
    // capability-equivalent counterpart to SqliteBackend's indexed-WHERE
    // fast path (capability-equivalent, performance-different — InMemory
    // has no index to consult). In-memory events carry the correlation
    // fields directly on the WorkflowEvent object, so we filter the field
    // off the object rather than re-parsing a payload column. Same
    // INV-1 contract: the column/field is the filter handle, the value
    // is whatever the event already carries.
    if (filters?.operationId !== undefined) {
      result = result.filter((e) => e.operationId === filters.operationId);
    }
    if (filters?.correlationId !== undefined) {
      result = result.filter((e) => e.correlationId === filters.correlationId);
    }
    if (filters?.causationId !== undefined) {
      result = result.filter((e) => e.causationId === filters.causationId);
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

  listStreams(): string[] {
    return Array.from(this.events.keys());
  }

  /**
   * Cross-stream query reducer (DR-3). Mirrors `SqliteBackend.queryEventsByType`'s
   * structural prefix filter:
   *
   *   streamId === streamPrefix OR streamId.startsWith(streamPrefix + '/')
   *
   * Substring lookalikes (`<streamPrefix>-extra`) are excluded — the descendant
   * relation requires a literal `/` separator.
   */
  queryEventsByType(
    eventType: string,
    streamPrefix: string,
    filters?: QueryFilters,
  ): WorkflowEvent[] {
    const collected: WorkflowEvent[] = [];
    for (const [streamId, stream] of this.events.entries()) {
      const isExact = streamId === streamPrefix;
      const isDescendant = streamId.startsWith(`${streamPrefix}/`);
      if (!isExact && !isDescendant) continue;
      for (const event of stream) {
        if (event.type !== eventType) continue;
        if (filters?.sinceSequence !== undefined && event.sequence <= filters.sinceSequence) continue;
        if (filters?.since && event.timestamp < filters.since) continue;
        if (filters?.until && event.timestamp > filters.until) continue;
        collected.push(event);
      }
    }
    // Stable global ordering: timestamp first, sequence as tie-break.
    collected.sort((a, b) => {
      const byTs = a.timestamp.localeCompare(b.timestamp);
      if (byTs !== 0) return byTs;
      return a.sequence - b.sequence;
    });
    const offset = filters?.offset ?? 0;
    const sliced = offset > 0 ? collected.slice(offset) : collected;
    return filters?.limit !== undefined ? sliced.slice(0, filters.limit) : sliced;
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

    // When seeding from disk (no existing entry, no expectedVersion),
    // initialize backend version from state._version to stay in sync
    // with the persisted version counter. (#948)
    let newVersion: number;
    if (!entry && expectedVersion === undefined) {
      const stateVersion = (state as Record<string, unknown>)._version;
      newVersion = typeof stateVersion === 'number' ? stateVersion : currentVersion + 1;
    } else {
      newVersion = currentVersion + 1;
    }

    this.states.set(featureId, {
      state,
      version: newVersion,
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

  async drainOutbox(
    streamId: string,
    sender: EventSender,
    batchSize?: number,
  ): Promise<DrainResult> {
    const items = this.outbox.get(streamId);
    if (!items || items.length === 0) {
      return { sent: 0, failed: 0 };
    }

    // Take a non-mutating snapshot of the batch and only remove items
    // after `appendEvents` resolves successfully. The earlier
    // splice-then-send variant dropped failed entries permanently — even
    // after switching to `await`, an async rejection would leave the
    // entry already gone from `items` with no retry path. Aligning with
    // SqliteBackend's "keep on failure" semantics keeps both backends
    // behaviourally consistent for code under test.
    const batch = batchSize !== undefined ? items.slice(0, batchSize) : items.slice();
    let sent = 0;
    let failed = 0;

    for (const item of batch) {
      try {
        await sender.appendEvents(streamId, [
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
        const idx = items.findIndex((queued) => queued.id === item.id);
        if (idx >= 0) items.splice(idx, 1);
        sent++;
      } catch {
        // Stop on first failure to preserve FIFO — letting later entries
        // succeed past a stranded earlier event would surface them out of
        // order at the consumer (events carry monotonic `sequence`).
        // Remaining queued items wait for the next drain cycle.
        failed++;
        break;
      }
    }

    if (items.length === 0) this.outbox.delete(streamId);

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

  // ─── Cleanup Operations ─────────────────────────────────────────────────

  deleteStream(streamId: string): void {
    this.events.delete(streamId);
    this.outbox.delete(streamId);
    // viewCache + projectionSnapshots use composite keys prefixed with
    // `${streamId}:`. Iterate and drop matching entries so a delete /
    // recreate cycle of the same streamId does not surface stale view
    // state or fold against pre-delete projection history. Mirrors the
    // SqliteBackend.deleteStream cleanup contract; CodeRabbit review
    // #4278133032 on PR #1344.
    const streamPrefix = `${streamId}:`;
    for (const key of this.viewCache.keys()) {
      if (key.startsWith(streamPrefix)) this.viewCache.delete(key);
    }
    for (const key of this.projectionSnapshots.keys()) {
      if (key.startsWith(streamPrefix)) this.projectionSnapshots.delete(key);
    }
  }

  deleteState(featureId: string): void {
    this.states.delete(featureId);
  }

  pruneEvents(streamId: string, beforeTimestamp: string): number {
    const stream = this.events.get(streamId);
    if (!stream) return 0;

    const kept = stream.filter((e) => e.timestamp >= beforeTimestamp);
    const pruned = stream.length - kept.length;

    if (kept.length === 0) {
      this.events.delete(streamId);
    } else {
      this.events.set(streamId, kept);
    }

    return pruned;
  }

  // ─── Projection Snapshot Accessors (Wave A, #1343) ──────────────────────

  /**
   * Return the snapshot record with the highest sequence for the given
   * (streamId, projectionId, projectionVersion) coordinate, or `undefined`
   * when no record exists.
   */
  readLatestProjectionSnapshot(
    streamId: string,
    projectionId: string,
    projectionVersion: string,
  ): SnapshotRecord | undefined {
    const key = `${streamId}:${projectionId}:${projectionVersion}`;
    const records = this.projectionSnapshots.get(key);
    if (!records || records.length === 0) return undefined;

    // Find the record with the highest sequence.
    let latest = records[0];
    for (let i = 1; i < records.length; i++) {
      if (records[i].sequence > latest.sequence) {
        latest = records[i];
      }
    }
    // Defensive copy so callers cannot mutate the in-map record. SqliteBackend
    // returns a freshly deserialized row per read; this branch must match
    // that semantic for INV-2 (facade equivalence) and to prevent state
    // corruption from downstream consumers that treat the record as mutable.
    return {
      ...latest,
      state: structuredClone(latest.state),
    };
  }

  /**
   * Append a snapshot record. When `opts.maxRecords` is provided, prune the
   * oldest records (by sequence) so the total does not exceed the cap.
   */
  appendProjectionSnapshot(
    streamId: string,
    record: SnapshotRecord,
    opts?: {
      maxRecords?: number;
      onPrune?: (prunedCount: number) => void;
    },
  ): void {
    const key = `${streamId}:${record.projectionId}:${record.projectionVersion}`;
    let records = this.projectionSnapshots.get(key);
    if (!records) {
      records = [];
      this.projectionSnapshots.set(key, records);
    }

    // Idempotent append: a snapshot at a given sequence is deterministic
    // from the events fold, so a re-write at the same `(coordinate,
    // sequence)` is a no-op rather than a duplicate (matches SqliteBackend's
    // INSERT OR IGNORE semantics).
    if (records.some((existing) => existing.sequence === record.sequence)) {
      return;
    }

    // Defensive copy so a later caller mutation of `record.state` cannot
    // corrupt the stored entry. Matches SqliteBackend's serialize-on-write
    // semantic (INV-2 facade equivalence).
    records.push({ ...record, state: structuredClone(record.state) });

    // Apply size cap: resolve maxRecords and trim oldest (lowest sequence).
    const max =
      opts?.maxRecords !== undefined && Number.isInteger(opts.maxRecords) && opts.maxRecords > 0
        ? opts.maxRecords
        : resolveMaxRecords();

    if (records.length > max) {
      // Sort by sequence ascending, remove the excess oldest records.
      records.sort((a, b) => a.sequence - b.sequence);
      const prunedCount = records.length - max;
      records.splice(0, prunedCount);
      opts?.onPrune?.(prunedCount);
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  initialize(): void {
    // No-op for in-memory backend
  }

  close(): void {
    // No-op for in-memory backend
  }
}
