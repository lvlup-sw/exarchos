import { createHash, randomUUID as randomUUIDFn } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { WorkflowEventBase } from './schemas.js';
import type { WorkflowEvent } from './schemas.js';
import type { StorageBackend } from '../storage/backend.js';
import { validateStreamId } from '../contract/shared/validation.js';
import { AtomicAppender } from './atomic-appender.js';
import { migrateEvents } from './event-migration.js';
import { getDispatchContext } from '../dispatch/dispatch-context.js';
import { notifyAppendObserved } from './observation/append-observation.js';
import { checkRunBundleIntegrity } from './bundle/integrity.js';
import type { BundleIntegrityResult } from './bundle/integrity.js';
import { RunBundleStore } from './bundle/run-bundle-store.js';
import {
  SubscriptionRegistry,
  type SubscribeOptions,
  type SubscriptionEventReader,
  type SubscriptionFilter,
  type SubscriptionHandle,
  type SubscriptionListener,
  type SubscriptionRegistryOptions,
} from './subscriptions.js';

/**
 * Adds the correlation IDs of the active dispatch to an event input.
 * A field that the caller supplies wins, so recovery code can reuse the IDs of an earlier dispatch.
 * The merge does not mutate the input, and it returns the same object when no field changes.
 */
function stampWithDispatchContext<T extends {
  correlationId?: string | undefined;
  causationId?: string | undefined;
  operationId?: string | undefined;
}>(event: T): T {
  const ctx = getDispatchContext();
  if (ctx === undefined) return event;
  const needsOperation = event.operationId === undefined;
  const needsCorrelation = event.correlationId === undefined;
  const needsCausation = event.causationId === undefined && ctx.causationId !== undefined;
  if (!needsOperation && !needsCorrelation && !needsCausation) return event;
  return {
    ...event,
    ...(needsOperation ? { operationId: ctx.operationId } : {}),
    ...(needsCorrelation ? { correlationId: ctx.correlationId } : {}),
    ...(needsCausation ? { causationId: ctx.causationId } : {}),
  };
}

export class SequenceConflictError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `Sequence conflict: expected ${expected}, actual ${actual}`,
    );
    this.name = 'SequenceConflictError';
  }
}

export interface AppendOptions {
  expectedSequence?: number | undefined;
  idempotencyKey?: string | undefined;
}

export interface QueryFilters {
  type?: string | undefined;
  sinceSequence?: number | undefined;
  since?: string | undefined;
  until?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  /**
   * Cross-stream prefix filter. It matches a `streamId` equal to the prefix or under `<prefix>/`,
   * but not `<prefix>-extra`. `SqliteBackend.queryEventsByType` applies it.
   */
  streamPrefix?: string;
  /** Filter to events stamped with this operationId (single dispatch boundary). */
  operationId?: string;
  /** Filter to events stamped with this correlationId (workflow/wave). */
  correlationId?: string;
  /** Filter to events stamped with this causationId (causal predecessor). */
  causationId?: string;
}

export interface EventStoreOptions {
  backend?: StorageBackend | undefined;
  /**
   * Value for the SQLite `PRAGMA synchronous`. The lifecycle reads it from `storage.synchronous`
   * in `.exarchos.yml`. When it is absent, the backend uses `'normal'`.
   */
  synchronous?: 'normal' | 'full' | undefined;
}

/**
 * Result of `EventStore.runIntegrityCheck`. The `ok` tag separates the cases:
 *   - `true`: the backend reports a healthy database.
 *   - `'skipped'`: the backend has no `runIntegrityPragma`, for example `InMemoryBackend`.
 *   - `false`: the backend reports corruption, or the probe went past its timeout.
 */
export type IntegrityResult =
  | { ok: true }
  | { ok: false; details: string }
  | { ok: 'skipped'; reason: string };

/** Default upper bound on `runIntegrityCheck` wall time. */
const DEFAULT_INTEGRITY_TIMEOUT_MS = 2000;

/**
 * Default upper bound on `runBundleIntegrityCheck` wall time. It is larger than the pragma
 * budget because the sweep reads every stream and hashes every referenced blob again.
 */
const DEFAULT_BUNDLE_INTEGRITY_TIMEOUT_MS = 10_000;

/**
 * Returns a promise that rejects with `AbortError` when `signal` fires, and a `dispose` that
 * removes the listener. `{ once: true }` removes it only on abort. The caller must call
 * `dispose()` in a `finally`, or a long-lived signal keeps one listener for each call.
 */
function abortRejection(signal: AbortSignal): {
  readonly promise: Promise<never>;
  readonly dispose: () => void;
} {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Append-only event store on SQLite. Reads and writes use the `SqliteBackend` that the appender
 * owns. The `backend` option exists only for tests that inject an `InMemoryBackend`.
 *
 * The SQLite WAL serializes writers across processes, so many stores can attach to one
 * `stateDir`. `BEGIN IMMEDIATE` takes write ownership. The `(stream_id, sequence)` primary key
 * keeps the order of each stream and rejects a duplicate sequence. In one process, the
 * appender's `StreamLockManager` serializes the appends to a stream.
 */
export class EventStore {
  /** True after `initialize()` and until `close()`. */
  private initialized = false;

  /** Read backend that a test injects. Production code leaves it unset. */
  private readonly backend?: StorageBackend | undefined;

  /** Created on the first call to `getAppender()`. */
  private atomicAppender?: AtomicAppender | undefined;
  private runBundleStore: RunBundleStore | undefined;

  /** Durability posture for the appender that `getAppender()` creates. */
  private synchronous?: 'normal' | 'full' | undefined;

  /**
   * Created on the first `subscribe()` call, together with the appender commit hook.
   * Until then, an append pays only one `undefined` check.
   */
  private subscriptions?: SubscriptionRegistry | undefined;

  constructor(private readonly stateDir: string, options?: EventStoreOptions) {
    this.backend = options?.backend;
    this.synchronous = options?.synchronous;
  }

  /**
   * Sets the durability posture after construction, because the lifecycle builds the store
   * before it loads `.exarchos.yml`. A call after `getAppender()` creates the appender has
   * no effect on the open connection.
   */
  setStorageDurability(synchronous: 'normal' | 'full'): void {
    this.synchronous = synchronous;
  }

  /** Returns the state directory path used by this event store. */
  get dir(): string {
    return this.stateDir;
  }

  /**
   * The run-bundle store for this state directory. Producers and the integrity sweep both get
   * the store here, so they always use the same root.
   */
  get bundleStore(): RunBundleStore {
    this.runBundleStore ??= RunBundleStore.forStateDir(this.stateDir);
    return this.runBundleStore;
  }

  /**
   * Returns the `AtomicAppender` for this state directory and creates it on the first call.
   * Every append path uses this one instance, so the per-stream locks, the sequence counters
   * and the idempotency cache are shared.
   */
  getAppender(): AtomicAppender {
    if (!this.atomicAppender) {
      this.atomicAppender = new AtomicAppender({
        stateDir: this.stateDir,
        ...(this.synchronous ? { synchronous: this.synchronous } : {}),
      });
    }
    return this.atomicAppender;
  }

  /**
   * Returns the injected test backend, or else the `SqliteBackend` of the appender. The SQLite
   * backend opens at once, so a read before the first write still sees the stored events.
   */
  getReadBackend(): StorageBackend {
    if (this.backend) return this.backend;
    return this.getAppender().ensureSqliteBackendSync();
  }

  /**
   * Creates `stateDir` and marks the store ready. A repeat call returns at once.
   * It takes no process lock, because the SQLite WAL serializes writers from all processes.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.stateDir, { recursive: true });
    this.initialized = true;
  }

  /**
   * Disposes every subscription, removes the commit hook, and then closes the SQLite handles.
   * It is idempotent. A test must call it before it removes a temporary `stateDir`, because on
   * Windows an open handle makes `fs.rm` fail with EPERM or EBUSY. Each append commits before
   * its promise resolves, so `close()` does not affect durability.
   */
  close(): void {
    this.subscriptions?.disposeAll();
    this.atomicAppender?.setCommitHook(undefined);
    this.subscriptions = undefined;
    this.atomicAppender?.close();
    this.atomicAppender = undefined;
    this.backend?.close();
    this.initialized = false;
  }

  /**
   * Adds the dispatch IDs, validates the event with Zod, and then appends it. A schema error
   * rejects before the appender runs. The parse uses the placeholder sequence 1, and the
   * appender assigns the real sequence.
   */
  async append(
    streamId: string,
    event: Partial<Omit<WorkflowEvent, 'sequence' | 'streamId'>> & { type: string },
    options?: AppendOptions,
  ): Promise<WorkflowEvent> {
    const idempotencyKey = options?.idempotencyKey ?? event.idempotencyKey;
    const timestamp = event.timestamp || new Date().toISOString();
    const stamped = stampWithDispatchContext(event);
    const candidate = WorkflowEventBase.parse({
      ...stamped,
      streamId,
      sequence: 1,
      timestamp,
      idempotencyKey,
    });
    return this.delegateAppend(streamId, candidate, idempotencyKey, options);
  }

  /**
   * Appends an event that `buildValidatedEvent()` already validated, with no second Zod parse.
   * It adds the dispatch IDs as `append` does. These fields are optional, so the event stays valid.
   */
  async appendValidated(
    streamId: string,
    event: WorkflowEvent,
    options?: AppendOptions,
  ): Promise<WorkflowEvent> {
    const idempotencyKey = options?.idempotencyKey ?? event.idempotencyKey;
    const timestamp = event.timestamp || new Date().toISOString();
    const stamped = stampWithDispatchContext(event) as WorkflowEvent;
    const prepared: WorkflowEvent = {
      ...stamped,
      streamId,
      timestamp,
      idempotencyKey,
    } as WorkflowEvent;
    return this.delegateAppend(streamId, prepared, idempotencyKey, options);
  }

  /**
   * Sends a validated event to the `AtomicAppender` and maps the result to a `WorkflowEvent`.
   * On an idempotency cache hit, it returns the stored event, not the request payload.
   * Observers hear only about an event that this call wrote, never about a cache hit.
   */
  private async delegateAppend(
    streamId: string,
    event: WorkflowEvent,
    idempotencyKey: string | undefined,
    options?: AppendOptions,
  ): Promise<WorkflowEvent> {
    const appender = this.getAppender();
    const appendOptions =
      options?.expectedSequence !== undefined
        ? { expectedSequence: options.expectedSequence }
        : undefined;
    const { sequence: _ignoredSeq, ...eventInputBase } = event as WorkflowEvent & { sequence?: number };
    const result = idempotencyKey
      ? await appender.append(streamId, [eventInputBase], idempotencyKey, appendOptions)
      : await appender.appendUnkeyed(streamId, [eventInputBase], appendOptions);

    if (!result.ok) {
      if (result.reason === 'sequence-conflict') {
        throw new SequenceConflictError(
          result.expected ?? options?.expectedSequence ?? -1,
          result.actual ?? -1,
        );
      }
      throw result.cause ?? new Error(`Append failed: ${result.reason}`);
    }

    if (result.kind === 'cache-hit') {
      const cached = result.persistedEvents[0];
      if (cached === undefined) {
        throw new Error('Append cache-hit reported no persisted event');
      }
      return {
        streamId: cached.streamId,
        sequence: cached.sequence,
        type: cached.type,
        timestamp: cached.timestamp,
        ...(cached.idempotencyKey !== undefined ? { idempotencyKey: cached.idempotencyKey } : {}),
        ...(cached.data !== undefined ? { data: cached.data } : {}),
        ...(cached.correlationId !== undefined ? { correlationId: cached.correlationId } : {}),
        ...(cached.causationId !== undefined ? { causationId: cached.causationId } : {}),
        ...((cached as { operationId?: string }).operationId !== undefined
          ? { operationId: (cached as { operationId?: string }).operationId }
          : {}),
        ...(cached.agentId !== undefined ? { agentId: cached.agentId } : {}),
        ...(cached.agentRole !== undefined ? { agentRole: cached.agentRole } : {}),
        ...(cached.source !== undefined ? { source: cached.source } : {}),
        ...(cached.schemaVersion !== undefined ? { schemaVersion: cached.schemaVersion } : {}),
      } as WorkflowEvent;
    }

    const fullEvent: WorkflowEvent = {
      ...event,
      streamId,
      sequence: result.sequences[0],
      timestamp: result.timestamps[0],
    } as WorkflowEvent;

    notifyAppendObserved({
      type: fullEvent.type,
      streamId,
      sequence: fullEvent.sequence,
    });

    return fullEvent;
  }

  /**
   * Validates every event, then appends the batch. A malformed event fails the batch before the
   * appender assigns a sequence. Of the events that repeat an idempotency key, only the first stays.
   *
   * The batch uses the shared key when every event carries the same key, and no key when no
   * event carries one. In all other cases it uses a new `batch:<uuid>` key, so a retry does not
   * match a partial overlap. A cache hit returns the stored events and notifies no observer.
   */
  async batchAppend(
    streamId: string,
    events: Array<Partial<Omit<WorkflowEvent, 'sequence' | 'streamId'>> & { type: string; idempotencyKey?: string }>,
  ): Promise<WorkflowEvent[]> {
    if (events.length === 0) return [];

    const validated: WorkflowEvent[] = events.map((event) => {
      const timestamp = event.timestamp || new Date().toISOString();
      const stamped = stampWithDispatchContext(event);
      return WorkflowEventBase.parse({
        ...stamped,
        streamId,
        sequence: 1,
        timestamp,
        idempotencyKey: stamped.idempotencyKey,
      });
    });

    const seenBatchKeys = new Set<string>();
    const deduped: WorkflowEvent[] = [];
    for (const event of validated) {
      if (event.idempotencyKey && seenBatchKeys.has(event.idempotencyKey)) continue;
      if (event.idempotencyKey) seenBatchKeys.add(event.idempotencyKey);
      deduped.push(event);
    }
    if (deduped.length === 0) return [];

    const eventKeys = deduped.map((e) => e.idempotencyKey).filter((k): k is string => !!k);
    const firstKey = eventKeys[0];
    const allHaveKeys = eventKeys.length === deduped.length;
    const allSameKey = allHaveKeys && eventKeys.every((k) => k === firstKey);

    const appender = this.getAppender();
    const eventInputs = deduped.map((e) => {
      const { sequence: _ignored, ...input } = e as WorkflowEvent & { sequence?: number };
      return input;
    });

    let result: import('./atomic-appender.js').AppendResult;
    if (eventKeys.length === 0) {
      result = await appender.appendUnkeyed(streamId, eventInputs);
    } else {
      const batchKey =
        allSameKey && firstKey !== undefined ? firstKey : `batch:${randomUUIDFn()}`;
      result = await appender.append(streamId, eventInputs, batchKey);
    }

    if (!result.ok) {
      if (result.reason === 'idempotency-claimed') {
        throw new Error(`Batch append failed: ${result.reason}`);
      }
      throw result.cause ?? new Error(`Batch append failed: ${result.reason}`);
    }

    if (result.kind === 'cache-hit') {
      return result.persistedEvents.map(
        (e) => ({
          streamId: e.streamId,
          sequence: e.sequence,
          type: e.type,
          timestamp: e.timestamp,
          ...(e.idempotencyKey !== undefined ? { idempotencyKey: e.idempotencyKey } : {}),
          ...(e.data !== undefined ? { data: e.data } : {}),
          ...(e.correlationId !== undefined ? { correlationId: e.correlationId } : {}),
          ...(e.causationId !== undefined ? { causationId: e.causationId } : {}),
          ...((e as { operationId?: string }).operationId !== undefined
            ? { operationId: (e as { operationId?: string }).operationId }
            : {}),
          ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
          ...(e.agentRole !== undefined ? { agentRole: e.agentRole } : {}),
          ...(e.source !== undefined ? { source: e.source } : {}),
          ...(e.schemaVersion !== undefined ? { schemaVersion: e.schemaVersion } : {}),
        } as WorkflowEvent),
      );
    }

    const fullEvents: WorkflowEvent[] = deduped.map((event, i) => {
      const sequence = result.sequences[i];
      const timestamp = result.timestamps[i];
      if (sequence === undefined || timestamp === undefined) {
        throw new Error(
          `Batch append result missing sequence/timestamp for event ${i}`,
        );
      }
      return { ...event, sequence, timestamp };
    });

    for (const landed of fullEvents) {
      notifyAppendObserved({
        type: landed.type,
        streamId,
        sequence: landed.sequence,
      });
    }

    return fullEvents;
  }

  /**
   * Appends an event trail in one transaction through `AtomicAppender.decideOnce`, so the stream
   * gets the complete trail or nothing. A loop of `append` calls can stop part way. `batchAppend`
   * is not a substitute, because it collapses the batch onto one idempotency key. Here
   * `operationId` keys the retry, and each event keeps its own `idempotencyKey`.
   *
   * The request digest covers only `(type, data, idempotencyKey)`, so a new timestamp does not
   * make a retry look like a new request. `decideOnce` calls the decision only when it commits,
   * so observers hear only about a trail that this call wrote. Their sequences come from the
   * committed claim, not from the stream tail, which another writer can move.
   */
  async appendTrailAtomically(
    streamId: string,
    events: ReadonlyArray<
      Partial<Omit<WorkflowEvent, 'sequence' | 'streamId'>> & { type: string }
    >,
    operationId: string,
  ): Promise<void> {
    if (events.length === 0) return;
    if (!operationId) {
      throw new Error('appendTrailAtomically requires an operationId');
    }

    const prepared: WorkflowEvent[] = events.map((event) => {
      const timestamp = event.timestamp || new Date().toISOString();
      const stamped = stampWithDispatchContext(event);
      return WorkflowEventBase.parse({
        ...stamped,
        streamId,
        sequence: 1,
        timestamp,
        ...(event.idempotencyKey !== undefined
          ? { idempotencyKey: event.idempotencyKey }
          : {}),
      });
    });

    const requestDigest = `sha256:${createHash('sha256')
      .update(
        JSON.stringify(
          prepared.map((event) => ({
            type: event.type,
            data: event.data ?? null,
            idempotencyKey: event.idempotencyKey ?? null,
          })),
        ),
      )
      .digest('hex')}`;

    const inputs = prepared.map((event) => {
      const { sequence: _ignoredSeq, ...input } = event as WorkflowEvent & {
        sequence?: number;
      };
      return input;
    });

    let landed = false;
    await this.getAppender().decideOnce<number>(
      operationId,
      requestDigest,
      () => {
        landed = true;
        return { streamId, events: inputs, result: inputs.length };
      },
    );
    if (!landed) return;

    const claim = this.getAppender()
      .ensureSqliteBackendSync()
      .lookupOperationClaim(operationId);
    prepared.forEach((event, index) => {
      const sequence = claim?.sequences[index];
      if (sequence === undefined) {
        throw new Error(
          `Trail append claim missing sequence for event ${index} of operation ${operationId}`,
        );
      }
      notifyAppendObserved({ type: event.type, streamId, sequence });
    });
  }

  /**
   * Reads one stream from the read backend. Every row goes through `migrateEvents`, so each
   * registered schema migration applies to every reader.
   */
  async query(streamId: string, filters?: QueryFilters): Promise<WorkflowEvent[]> {
    const events = this.getReadBackend().queryEvents(streamId, filters);
    return migrateEvents(events);
  }

  /**
   * Returns the events of `eventType` in every stream that equals `filters.streamPrefix` or
   * sits under `<prefix>/`. The stream `feat-1-extra` does not match `feat-1`. The prefix must
   * be a valid stream id. `offset` and `limit` apply after the merge, which sorts by timestamp
   * and then by sequence.
   *
   * The SQLite backend answers with one query. A backend without `queryEventsByType` falls back
   * to one `query` call for each matching stream. Both paths apply `migrateEvents` once.
   */
  async queryByType(
    eventType: string,
    filters?: QueryFilters & { streamPrefix?: string },
  ): Promise<WorkflowEvent[]> {
    const prefix = filters?.streamPrefix;
    if (!prefix) {
      throw new Error(
        'EventStore.queryByType requires filters.streamPrefix — use EventStore.query() for single-stream queries',
      );
    }
    validateStreamId(prefix);

    const perStream: QueryFilters = { type: eventType };
    if (filters?.sinceSequence !== undefined) perStream.sinceSequence = filters.sinceSequence;
    if (filters?.since !== undefined) perStream.since = filters.since;
    if (filters?.until !== undefined) perStream.until = filters.until;
    if (filters?.operationId !== undefined) perStream.operationId = filters.operationId;
    if (filters?.correlationId !== undefined) perStream.correlationId = filters.correlationId;
    if (filters?.causationId !== undefined) perStream.causationId = filters.causationId;

    const readBackend = this.getReadBackend();
    if (typeof readBackend.queryEventsByType === 'function') {
      const backendEvents = readBackend.queryEventsByType(eventType, prefix, perStream);
      const sortedBackend = backendEvents.slice().sort((a, b) => {
        const byTs = a.timestamp.localeCompare(b.timestamp);
        return byTs !== 0 ? byTs : a.sequence - b.sequence;
      });
      const offset = filters?.offset ?? 0;
      const limit = filters?.limit;
      const slicedBackend = offset > 0 ? sortedBackend.slice(offset) : sortedBackend;
      return migrateEvents(limit !== undefined ? slicedBackend.slice(0, limit) : slicedBackend);
    }

    const matchingStreams: string[] = [];
    {
      const seen = new Set<string>();
      for (const streamId of readBackend.listStreams()) {
        if (seen.has(streamId)) continue;
        const isExact = streamId === prefix;
        const isDescendant = streamId.startsWith(`${prefix}/`);
        if (isExact || isDescendant) {
          matchingStreams.push(streamId);
          seen.add(streamId);
        }
      }
    }

    const merged: WorkflowEvent[] = [];
    for (const streamId of matchingStreams) {
      const events = await this.query(streamId, perStream);
      for (const event of events) {
        if (event.type === eventType) merged.push(event);
      }
    }

    merged.sort((a, b) => {
      const byTs = a.timestamp.localeCompare(b.timestamp);
      return byTs !== 0 ? byTs : a.sequence - b.sequence;
    });

    const offset = filters?.offset ?? 0;
    const limit = filters?.limit;
    const sliced = offset > 0 ? merged.slice(offset) : merged;
    return limit !== undefined ? sliced.slice(0, limit) : sliced;
  }

  /** Lists every stream id in the read backend. */
  listStreams(): string[] {
    return this.getReadBackend().listStreams();
  }

  /**
   * Returns the highest sequence on `streamId`, or 0 for an empty stream. A cache, such as
   * `EventSourcedTaskStore.loadTask`, uses it to compare its last sequence with the live tail.
   */
  async tailSequence(streamId: string): Promise<number> {
    return this.getReadBackend().getSequence(streamId);
  }

  /**
   * Registers a subscription that delivers each committed event that matches `filter` to
   * `onEvent` exactly once, in global sequence order. Registration captures the cursor and
   * schedules a first drain, so an event that commits during registration is not lost.
   *
   * A commit in this process wakes the drain through the appender hook. The hook fires after
   * the stream lock releases, so an `onEvent` that appends does not deadlock. A poll loop reads
   * `dataVersion()` every `floorMs` and drains only after another process commits.
   *
   * The dispatch that registers a subscription must dispose the handle. `close()` disposes leaks.
   */
  subscribe(
    filter: SubscriptionFilter,
    onEvent: SubscriptionListener,
    options?: SubscribeOptions,
    registryOptions?: SubscriptionRegistryOptions,
  ): SubscriptionHandle {
    return this.ensureSubscriptions(registryOptions).subscribe(filter, onEvent, options);
  }

  /**
   * Creates the subscription registry and installs the appender commit hook on the first call.
   * The registry reads the same SQLite handle that the appender writes, so a woken drain sees
   * the commit. On that handle, `PRAGMA data_version` changes only after a commit by another
   * process. Reads go through `migrateEvents`, as in `query()`.
   */
  private ensureSubscriptions(
    registryOptions?: SubscriptionRegistryOptions,
  ): SubscriptionRegistry {
    if (!this.subscriptions) {
      const reader: SubscriptionEventReader = {
        headSequence: (streamId) => this.getReadBackend().getSequence(streamId),
        readStreamAfter: (streamId, afterSequence) =>
          migrateEvents(
            this.getReadBackend().queryEvents(streamId, { sinceSequence: afterSequence }),
          ),
        listStreams: () => this.getReadBackend().listStreams(),
        dataVersion: () => this.getReadBackend().dataVersion(),
      };
      this.subscriptions = new SubscriptionRegistry(reader, registryOptions);
      const registry = this.subscriptions;
      this.getAppender().setCommitHook((streamId) => registry.wake(streamId));
    }
    return this.subscriptions;
  }

  /** Disposes every live subscription at dispatch teardown. It is idempotent. */
  disposeSubscriptions(): void {
    this.subscriptions?.disposeAll();
  }

  /**
   * Registers a stream and its workflow type. A repeat call leaves the row unchanged.
   * The `workflow_type` column never changes after insert, and a grep test rejects any `UPDATE`
   * of it. With a backend that has no `registerStream`, the call does nothing.
   */
  registerStream(streamId: string, workflowType: string): void {
    const backend = this.getReadBackend();
    if (typeof backend.registerStream !== 'function') return;
    backend.registerStream(streamId, workflowType);
  }

  /**
   * Runs the backend integrity pragma within `timeoutMs`. The doctor `storage-sqlite-health`
   * check uses this method, so no raw SQLite handle leaves the store.
   *   - A backend without `runIntegrityPragma` gives `{ ok: 'skipped' }`.
   *   - The verdict `ok` gives `{ ok: true }`. Any other verdict gives `{ ok: false }`.
   *   - A timeout gives `{ ok: false }` with a timeout message.
   *   - An abort of the caller's signal rejects with `AbortError`.
   */
  async runIntegrityCheck(opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<IntegrityResult> {
    const probeBackend = this.getReadBackend();
    if (typeof probeBackend.runIntegrityPragma !== 'function') {
      return {
        ok: 'skipped',
        reason: 'backend does not support integrity_check (non-sqlite)',
      };
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_INTEGRITY_TIMEOUT_MS;
    const externalSignal = opts?.signal;

    if (externalSignal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let timer: NodeJS.Timeout | undefined;
    let didTimeout = false;
    const timeoutDetails = `integrity_check timed out after ${timeoutMs}ms`;
    const timeoutPromise = new Promise<IntegrityResult>((resolve) => {
      timer = setTimeout(() => {
        didTimeout = true;
        controller.abort();
        resolve({
          ok: false,
          details: timeoutDetails,
        });
      }, timeoutMs);
    });

    const probePromise = (async (): Promise<IntegrityResult> => {
      const probe = probeBackend.runIntegrityPragma!.bind(probeBackend);
      try {
        const verdict = await probe(controller.signal);
        if (verdict.trim().toLowerCase() === 'ok') {
          return { ok: true };
        }
        return { ok: false, details: verdict };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          if (didTimeout && !externalSignal?.aborted) {
            return { ok: false, details: timeoutDetails };
          }
          throw err;
        }
        return {
          ok: false,
          details: err instanceof Error ? err.message : String(err),
        };
      }
    })();

    const externalAbort = externalSignal ? abortRejection(externalSignal) : undefined;
    try {
      if (externalAbort) {
        return await Promise.race([probePromise, timeoutPromise, externalAbort.promise]);
      }
      return await Promise.race([probePromise, timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      externalAbort?.dispose();
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  /**
   * Checks that each blob the ledger references still exists and still has its recorded hash.
   * It has the same bounds as {@link runIntegrityCheck}: a timeout, the caller's signal, no raw handle.
   *   - A backend that cannot list streams gives `{ ok: 'skipped' }`.
   *   - No reference and no settlement gives `{ ok: 'empty' }`, which means nothing was checked.
   *   - All references resolve: `{ ok: true }` with the count it checked.
   *   - A bad reference, or a custodial settlement with no reference, gives `{ ok: false }`.
   *   - A timeout or a throw gives `{ ok: false, incomplete: true }` with no counts.
   *   - An abort of the caller's signal rejects with `AbortError`.
   * The sweep reads every stream, so no append or replay path calls it. The doctor calls it on demand.
   */
  async runBundleIntegrityCheck(opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    bundleStore?: RunBundleStore;
  }): Promise<BundleIntegrityResult> {
    const probeBackend = this.getReadBackend();
    if (typeof probeBackend.listStreams !== 'function') {
      return {
        ok: 'skipped',
        reason: 'backend does not enumerate streams',
      };
    }
    const listStreams = probeBackend.listStreams.bind(probeBackend);

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_BUNDLE_INTEGRITY_TIMEOUT_MS;
    const externalSignal = opts?.signal;

    if (externalSignal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    const bundleStore = opts?.bundleStore ?? this.bundleStore;

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let timer: NodeJS.Timeout | undefined;
    let didTimeout = false;
    const timeoutDetails = `run-bundle integrity check timed out after ${timeoutMs}ms`;
    const timedOut: BundleIntegrityResult = {
      ok: false,
      incomplete: true,
      details: timeoutDetails,
      violations: [],
    };
    const timeoutPromise = new Promise<BundleIntegrityResult>((resolve) => {
      timer = setTimeout(() => {
        didTimeout = true;
        controller.abort();
        resolve(timedOut);
      }, timeoutMs);
    });

    const sweepPromise = (async (): Promise<BundleIntegrityResult> => {
      try {
        return await checkRunBundleIntegrity(
          {
            listStreams,
            query: (streamId) => this.query(streamId),
          },
          bundleStore,
          controller.signal,
        );
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          if (didTimeout && !externalSignal?.aborted) return timedOut;
          throw err;
        }
        return {
          ok: false,
          incomplete: true,
          details: `run-bundle integrity sweep threw before finishing: ${err instanceof Error ? err.message : String(err)}`,
          violations: [],
        };
      }
    })();

    const externalAbort = externalSignal ? abortRejection(externalSignal) : undefined;
    try {
      if (externalAbort) {
        return await Promise.race([sweepPromise, timeoutPromise, externalAbort.promise]);
      }
      return await Promise.race([sweepPromise, timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      externalAbort?.dispose();
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  /**
   * Validates `streamId` and does nothing else. It stays so that callers that call it after a
   * `SequenceConflictError` still compile. The appender reads each sequence from SQLite.
   */
  async refreshSequence(streamId: string): Promise<void> {
    validateStreamId(streamId);
  }
}
