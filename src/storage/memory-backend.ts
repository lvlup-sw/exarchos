import type { WorkflowEvent } from '../events/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import type { QueryFilters } from '../events/store.js';
import type {
  StorageBackend,
  EventSender,
  ViewCacheEntry,
  DrainResult,
  WorkflowSummary,
  WorkflowSummaryFilter,
} from './backend.js';
import { deriveWorkflowStatus, matchesWorkflowSummaryFilter } from './backend.js';
import type { SnapshotRecord } from '../projections/snapshot-schema.js';
import { resolveMaxRecords } from './snapshot-retention.js';

/** A compare-and-set version conflict on workflow state. */
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

interface StateEntry {
  state: WorkflowState;
  version: number;
}

interface OutboxItem {
  id: string;
  event: WorkflowEvent;
}

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
   * `${streamId}:${projectionId}:${projectionVersion}` -> SnapshotRecord[], in
   * insertion order. `readLatestProjectionSnapshot` scans for the highest sequence.
   */
  private readonly projectionSnapshots = new Map<string, SnapshotRecord[]>();

  /** Counter for generating unique outbox entry IDs */
  private outboxIdCounter = 0;

  /**
   * Change token for {@link StorageBackend.dataVersion}, bumped on each
   * {@link appendEvent}. Memory has no other process, so each append counts as a
   * change, also an append by the observer. The cursor guard of the floor loop
   * makes the extra drains harmless.
   */
  private appendVersion = 0;

  /**
   * Append an event, then bump the change token. This order makes sure that a
   * `dataVersion()` reader never sees a new token before the event is visible.
   */
  appendEvent(streamId: string, event: WorkflowEvent): void {
    let stream = this.events.get(streamId);
    if (!stream) {
      stream = [];
      this.events.set(streamId, stream);
    }
    stream.push(event);
    this.appendVersion++;
  }

  /**
   * Tier-2 poll-floor change token: a monotonic count of appends. Own
   * appends bump it (there is no foreign connection in memory). See
   * {@link StorageBackend.dataVersion} for the cross-backend contract.
   */
  dataVersion(): number {
    return this.appendVersion;
  }

  /**
   * Query one stream. All filters run in JS after the fetch, because memory has
   * no index. The correlation filters match the fields on the event object, so the
   * rows are the same as on the indexed SQLite path.
   */
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
    return stream[stream.length - 1]?.sequence ?? 0;
  }

  listStreams(): string[] {
    return Array.from(this.events.keys());
  }

  /**
   * Cross-stream query, with the same prefix rule as `SqliteBackend.queryEventsByType`.
   * A stream matches when it equals `streamPrefix` or starts with `streamPrefix + '/'`,
   * so `<streamPrefix>-extra` does not match. The filters match as in
   * {@link queryEvents}. Results sort by timestamp, then by sequence.
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
        if (filters?.operationId !== undefined && event.operationId !== filters.operationId) continue;
        if (filters?.correlationId !== undefined && event.correlationId !== filters.correlationId) continue;
        if (filters?.causationId !== undefined && event.causationId !== filters.causationId) continue;
        collected.push(event);
      }
    }
    collected.sort((a, b) => {
      const byTs = a.timestamp.localeCompare(b.timestamp);
      if (byTs !== 0) return byTs;
      return a.sequence - b.sequence;
    });
    const offset = filters?.offset ?? 0;
    const sliced = offset > 0 ? collected.slice(offset) : collected;
    return filters?.limit !== undefined ? sliced.slice(0, filters.limit) : sliced;
  }

  getState(featureId: string): WorkflowState | null {
    const entry = this.states.get(featureId);
    return entry ? entry.state : null;
  }

  /**
   * Set state, with a compare-and-set check when `expectedVersion` is given. A
   * first write without `expectedVersion` takes its version from `state._version`,
   * so state seeded from disk keeps the persisted version counter.
   */
  setState(featureId: string, state: WorkflowState, expectedVersion?: number): void {
    const entry = this.states.get(featureId);
    const currentVersion = entry ? entry.version : 0;

    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw new VersionConflictError(featureId, expectedVersion, currentVersion);
    }

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

  /**
   * Cross-workflow summary read, with the same rows as
   * {@link SqliteBackend.listWorkflowSummaries}. `workflowType` and `phase` come
   * from the stored state, and `status` from {@link deriveWorkflowStatus}.
   * `createdAt` is the earliest event timestamp of the stream. ISO-8601 strings
   * sort like SQLite `MIN(timestamp)`. Rows sort by `featureId`. This method
   * filters `workflowType`, and {@link matchesWorkflowSummaryFilter} applies the
   * lifecycle axes.
   */
  listWorkflowSummaries(filter: WorkflowSummaryFilter = {}): WorkflowSummary[] {
    const summaries: WorkflowSummary[] = [];

    for (const [featureId, entry] of this.states) {
      const state = entry.state as { phase?: unknown; workflowType?: unknown };
      const phase = typeof state.phase === 'string' ? state.phase : '';
      const workflowType = typeof state.workflowType === 'string' ? state.workflowType : '';

      let createdAt: string | null = null;
      const events = this.events.get(featureId);
      if (events && events.length > 0) {
        createdAt = events[0]?.timestamp ?? null;
        for (const event of events) {
          if (createdAt === null || event.timestamp < createdAt) createdAt = event.timestamp;
        }
      }

      summaries.push({
        featureId,
        workflowType,
        phase,
        status: deriveWorkflowStatus(phase),
        createdAt,
      });
    }

    summaries.sort((a, b) => a.featureId.localeCompare(b.featureId));

    return summaries.filter((summary) => {
      if (filter.workflowType !== undefined && summary.workflowType !== filter.workflowType) {
        return false;
      }
      return matchesWorkflowSummaryFilter(summary, filter);
    });
  }

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

  /**
   * Send queued events in FIFO order. An entry leaves the queue only after
   * `appendEvents` resolves, so a failed send keeps it for the next drain, as in
   * `SqliteBackend`. The drain stops at the first failure, because events sent
   * past a stuck event reach the consumer out of `sequence` order.
   */
  async drainOutbox(
    streamId: string,
    sender: EventSender,
    batchSize?: number,
  ): Promise<DrainResult> {
    const items = this.outbox.get(streamId);
    if (!items || items.length === 0) {
      return { sent: 0, failed: 0 };
    }

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
        failed++;
        break;
      }
    }

    if (items.length === 0) this.outbox.delete(streamId);

    return { sent, failed };
  }

  getViewCache(streamId: string, viewName: string): ViewCacheEntry | null {
    const key = `${streamId}:${viewName}`;
    return this.viewCache.get(key) ?? null;
  }

  setViewCache(streamId: string, viewName: string, state: unknown, hwm: number): void {
    const key = `${streamId}:${viewName}`;
    this.viewCache.set(key, { state, highWaterMark: hwm });
  }

  /**
   * Delete a stream with its outbox, view-cache, and snapshot entries, as
   * `SqliteBackend.deleteStream` does. Without the cache cleanup, a new stream
   * with the same id gets stale views and folds against old snapshots.
   */
  deleteStream(streamId: string): void {
    this.events.delete(streamId);
    this.outbox.delete(streamId);
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

  /**
   * Return the snapshot record with the highest sequence for the given
   * (streamId, projectionId, projectionVersion) coordinate, or `undefined`
   * when no record exists. The state is a copy, so a caller cannot change the
   * stored record. `SqliteBackend` also returns a new object on each read.
   */
  readLatestProjectionSnapshot(
    streamId: string,
    projectionId: string,
    projectionVersion: string,
  ): SnapshotRecord | undefined {
    const key = `${streamId}:${projectionId}:${projectionVersion}`;
    const records = this.projectionSnapshots.get(key);
    if (!records || records.length === 0) return undefined;

    let latest = records[0];
    if (latest === undefined) return undefined;
    for (let i = 1; i < records.length; i++) {
      const rec = records[i];
      if (rec !== undefined && rec.sequence > latest.sequence) {
        latest = rec;
      }
    }
    return {
      ...latest,
      state: structuredClone(latest.state),
    };
  }

  /**
   * Append a copy of a snapshot record, then remove the oldest records (lowest
   * sequence) above the cap. The cap is `opts.maxRecords` when it is a positive
   * integer, else {@link resolveMaxRecords}. A record at an existing sequence is
   * a no-op, as with the SQLite `INSERT OR IGNORE`.
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

    if (records.some((existing) => existing.sequence === record.sequence)) {
      return;
    }

    records.push({ ...record, state: structuredClone(record.state) });

    const max =
      opts?.maxRecords !== undefined && Number.isInteger(opts.maxRecords) && opts.maxRecords > 0
        ? opts.maxRecords
        : resolveMaxRecords();

    if (records.length > max) {
      records.sort((a, b) => a.sequence - b.sequence);
      const prunedCount = records.length - max;
      records.splice(0, prunedCount);
      opts?.onPrune?.(prunedCount);
    }
  }

  /** No-op for the in-memory backend. */
  initialize(): void {
  }

  /** No-op for the in-memory backend. */
  close(): void {
  }
}
