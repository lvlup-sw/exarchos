/**
 * AtomicAppender: the append primitive with one writer for each stream.
 *
 * Every append runs in one SQLite `BEGIN IMMEDIATE` transaction that holds the
 * idempotency claim, the sequence update, and the event rows. A per-stream
 * Promise mutex is the first guard, and the SQLite transaction is the second.
 * Each claim persists in `idempotency_claims` and survives a process restart.
 */
import * as fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { validateStreamId } from '../contract/shared/validation.js';
import { STORE_DB_FILENAME } from '../utils/paths.js';
import {
  SqliteBackend,
  SqliteBusyExhaustedError,
  SequenceGateConflictError,
  OperationDigestConflictError,
  type AtomicAppendEvent as SqliteAtomicAppendEvent,
} from '../storage/sqlite-backend.js';
import { ConcurrencyError } from './concurrency-error.js';
import { StorageBusyError } from './storage-busy-error.js';
import {
  InvalidSessionOptionsError,
  SessionClosedError,
} from './session-errors.js';
import {
  defaultRegistry,
  type ProjectionRegistry,
} from '../projections/registry.js';
import type { ProjectionReducer } from '../projections/types.js';
import { UnknownProjectionIdError } from '../projections/rebuild.js';

/**
 * The stored event that a cache-hit returns. The caller gets the persisted
 * shape and not a copy of its own request body.
 */
export interface PublicPersistedEvent {
  streamId: string;
  sequence: number;
  type: string;
  timestamp: string;
  eventId: string;
  idempotencyKey?: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

export type AppendResult =
  | {
      ok: true;
      /**
       * A fresh commit. A `cache-hit` replays an earlier commit instead, so
       * its side effects already ran.
       */
      kind: 'committed';
      sequences: number[];
      eventIds: string[];
      /** The timestamp of each persisted event, in the order of `sequences`. */
      timestamps: string[];
    }
  | {
      ok: true;
      kind: 'cache-hit';
      sequences: number[];
      eventIds: string[];
      timestamps: string[];
      /**
       * The events that the first commit stored under this idempotency key.
       * The caller returns these and not its current request payload.
       */
      persistedEvents: PublicPersistedEvent[];
    }
  | {
      ok: false;
      /**
       * `storage_busy`: SQLITE_BUSY persisted through every `BEGIN IMMEDIATE`
       * attempt (5 attempts, exponential backoff capped at 100 ms). The caller
       * can retry or report the contention.
       */
      reason: 'idempotency-claimed' | 'sequence-conflict' | 'io-error' | 'storage_busy';
      cause?: Error;
      /** Populated on `sequence-conflict` so callers can translate to typed errors. */
      expected?: number;
      actual?: number;
    };

export interface EventInput {
  type: string;
  data?: Record<string, unknown> | undefined;
  timestamp?: string | undefined;
  correlationId?: string | undefined;
  causationId?: string | undefined;
  /**
   * The dispatch-boundary operation id. `EventStore.append*` stamps it from
   * the active dispatch context, and the appender persists it unchanged.
   */
  operationId?: string | undefined;
  agentId?: string | undefined;
  agentRole?: string | undefined;
  source?: string | undefined;
  schemaVersion?: string | undefined;
  [k: string]: unknown;
}

/**
 * Per-call append options. Only the outermost append call carries
 * `expectedSequence`, because an `appendComputed` callback already holds the
 * stream lock.
 */
export interface AppendOptions {
  /**
   * The stream sequence that the caller saw before this append. The
   * transaction compares it with the durable high-water mark. A mismatch
   * returns `sequence-conflict` with `expected` and `actual`.
   */
  expectedSequence?: number | undefined;
}

/**
 * Options for {@link AtomicAppender.decide}.
 *
 * `registry` defaults to {@link defaultRegistry}. `operationId` gives the call
 * one idempotency key, `${streamId}:${reducerId}:${operationId}`, so a retry
 * returns the stored events and does not commit again.
 *
 * `alwaysEnforceConsistency` defaults to `true`. Then an empty decision
 * re-reads the tail and throws {@link ConcurrencyError} if the tail moved.
 * Set it to `false` only for a read-only flow.
 */
export interface DecideOptions {
  readonly registry?: ProjectionRegistry;
  readonly operationId?: string;
  readonly alwaysEnforceConsistency?: boolean;
}

/** The context that a decide closure receives. */
export interface DecideContext {
  readonly streamId: string;
  /** The tail sequence that the fold read, before the closure runs. */
  readonly version: number;
  /** Returns the current time as an ISO-8601 timestamp. */
  readonly now: () => string;
}

/**
 * The result of `decide` and `withSession`. It mirrors the success branch of
 * {@link AppendResult}. A failure throws a typed error, such as
 * `ConcurrencyError` or `StorageBusyError`.
 */
export type DecideResult =
  | {
      readonly ok: true;
      readonly kind: 'committed' | 'cache-hit' | 'no-op';
      readonly sequences: readonly number[];
      readonly eventIds: readonly string[];
      readonly timestamps: readonly string[];
    };

export interface DecideOnceStoredEvent {
  readonly streamId: string;
  readonly sequence: number;
  readonly type: string;
  readonly timestamp: string;
  readonly data?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface DecideOnceStreamSnapshot {
  readonly events: readonly DecideOnceStoredEvent[];
  readonly version: number;
}

/**
 * Transaction-scoped reads available to a decideOnce closure. Every read uses
 * the same SQLite connection after BEGIN IMMEDIATE has acquired the write lock.
 */
export interface DecideOnceContext {
  readStream(streamId: string): DecideOnceStreamSnapshot;
}

export interface DecideOnceDecision<TResult> {
  readonly streamId: string;
  readonly events: readonly EventInput[];
  readonly result: TResult;
  readonly expectedSequence?: number;
}

export class OperationDigestMismatchError extends Error {
  readonly code = 'OPERATION_DIGEST_MISMATCH' as const;

  constructor(
    public readonly operationId: string,
    public readonly expectedDigest: string,
    public readonly actualDigest: string,
  ) {
    super(
      `OPERATION_DIGEST_MISMATCH: operation ${JSON.stringify(operationId)} was already committed with a different request digest`,
    );
    this.name = 'OperationDigestMismatchError';
  }
}

/**
 * The `BEGIN IMMEDIATE` attempt budget against SQLITE_BUSY. It mirrors
 * `SQLITE_BUSY_RETRY_POLICY.maxAttempts` in the SQLite backend, so a
 * `StorageBusyError` reports the budget that the backend used.
 */
const STORAGE_BUSY_MAX_ATTEMPTS = 5;

/**
 * Options for {@link AtomicAppender.withSession}. The caller must supply
 * `operationId` or set `allowNonIdempotent: true`. This gate stops an OCC
 * retry from repeating the side effects of a closure without the consent of
 * the caller.
 */
export interface WithSessionOptions extends DecideOptions {
  /**
   * The caller states that the side effects of the closure are idempotent,
   * or that it accepts at-least-once retries. It does not make the closure
   * safe. When it is `false` and `operationId` is absent, `withSession`
   * throws {@link InvalidSessionOptionsError}. Defaults to `false`.
   */
  readonly allowNonIdempotent?: boolean;
}

/**
 * The session that a `withSession` closure receives. The closure reads
 * `aggregate` and `version`, and queues events with `append`. The queued
 * events commit atomically after the closure resolves. A later `append`
 * throws {@link SessionClosedError}.
 */
export interface Session<TState> {
  readonly aggregate: TState;
  readonly version: number;
  append(event: EventInput): void;
}

export interface AtomicAppenderOptions {
  /** Directory under which the SQLite database file lives. */
  stateDir: string;
  /**
   * A shared backend, so reads and writes use one handle. The appender never
   * closes it. Without it, the appender opens its own backend on first use.
   */
  sqliteBackend?: SqliteBackend;
  /**
   * The database file name in `stateDir`. Defaults to
   * {@link STORE_DB_FILENAME}, the constant that `index.ts:initializeBackend`
   * also uses, so both backends open the same file. Tests override it to
   * isolate their databases.
   */
  sqliteDbFilename?: string;
  /**
   * The `PRAGMA synchronous` value for a backend that the appender opens. It
   * comes from `storage.synchronous` in `.exarchos.yml`. Defaults to
   * `'normal'`.
   */
  synchronous?: 'normal' | 'full';
}

interface PersistedEvent {
  streamId: string;
  sequence: number;
  type: string;
  timestamp: string;
  eventId: string;
  idempotencyKey?: string | undefined;
  data?: Record<string, unknown> | undefined;
  [k: string]: unknown;
}

/**
 * Per-stream Promise-chain mutex. Each `runExclusive` call waits for the prior
 * tail before its critical section runs. The release never throws, so an error
 * in one critical section does not block the next caller. The map entry goes
 * away when no caller waits.
 */
class StreamLockManager {
  private tails = new Map<string, Promise<unknown>>();

  async runExclusive<T>(streamId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(streamId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => {
      release = resolve;
    });
    this.tails.set(streamId, next);
    try {
      await prior;
      return await fn();
    } finally {
      release();
      if (this.tails.get(streamId) === next) {
        this.tails.delete(streamId);
      }
    }
  }
}

export class AtomicAppender {
  private readonly stateDir: string;
  private readonly locks = new StreamLockManager();
  private readonly sqliteDbFilename: string;
  /**
   * The SQLite backend. The appender never closes an injected backend.
   *
   * Assign this field only through the `sqliteBackendPromise` cache.
   * `runExclusive` serializes each stream on its own, so two first writes to
   * different streams can race. Without the cache, each opens a handle and
   * one handle leaks.
   */
  private sqliteBackend?: SqliteBackend | undefined;
  /**
   * The in-flight backend construction. The first caller assigns it before
   * any await, and later callers await the same Promise.
   */
  private sqliteBackendPromise?: Promise<SqliteBackend> | undefined;
  /**
   * Set by {@link close} and never cleared. A closed appender never opens a
   * SQLite handle again. An operation that was still in flight when the
   * appender closed fails with {@link AppenderClosedError}. It does not
   * reopen `exarchos.db` behind the owner's back (#2026).
   */
  private closed = false;
  private readonly sqliteBackendInjected: boolean;
  /** The `PRAGMA synchronous` value for a backend that the appender opens. */
  private readonly synchronous?: 'normal' | 'full' | undefined;

  /**
   * The post-commit hook. It fires with the stream id after the transaction
   * commits and after the stream lock releases. A listener can then append to
   * the same stream without a deadlock on the non-reentrant mutex.
   *
   * Only a fresh commit fires it. A cache-hit and a failure do not.
   * `EventStore` sets it when the first subscription registers.
   */
  private commitHook?: ((streamId: string) => void) | undefined;

  constructor(options: AtomicAppenderOptions) {
    this.stateDir = options.stateDir;
    this.sqliteDbFilename = options.sqliteDbFilename ?? STORE_DB_FILENAME;
    this.synchronous = options.synchronous;
    if (options.sqliteBackend) {
      this.sqliteBackend = options.sqliteBackend;
      this.sqliteBackendPromise = Promise.resolve(options.sqliteBackend);
      this.sqliteBackendInjected = true;
    } else {
      this.sqliteBackendInjected = false;
    }
  }

  /** Sets the post-commit hook. `undefined` detaches it. See {@link commitHook}. */
  setCommitHook(hook: ((streamId: string) => void) | undefined): void {
    this.commitHook = hook;
  }

  /**
   * Fires the post-commit hook for a fresh commit only. Each append entry point
   * calls it after `runExclusive` resolves, so the hook runs outside the
   * stream lock. With no hook, the cost is one `undefined` check.
   */
  private notifyCommit(streamId: string, result: AppendResult): void {
    const hook = this.commitHook;
    if (hook === undefined) return;
    if (result.ok && result.kind === 'committed') hook(streamId);
  }

  async append(
    streamId: string,
    events: EventInput[],
    idempotencyKey: string,
    options?: AppendOptions,
  ): Promise<AppendResult> {
    const result = await this.locks.runExclusive(streamId, () =>
      this.appendSqliteLocked(streamId, events, { idempotencyKey }, options),
    );
    this.notifyCommit(streamId, result);
    return result;
  }

  /**
   * Appends without an idempotency claim. The stored event has a null
   * `idempotencyKey`, so it cannot collide with a retry chain.
   */
  async appendUnkeyed(
    streamId: string,
    events: EventInput[],
    options?: AppendOptions,
  ): Promise<AppendResult> {
    const result = await this.locks.runExclusive(streamId, () =>
      this.appendSqliteLocked(streamId, events, null, options),
    );
    this.notifyCommit(streamId, result);
    return result;
  }

  /**
   * Runs `compute` and appends its events under one stream lock, so a
   * read-then-append caller does not read stale state.
   *
   * `compute` must not call `append` or `appendComputed` for the same stream.
   * The mutex is not reentrant, so that call deadlocks. Other reads are safe.
   */
  async appendComputed(
    streamId: string,
    idempotencyKey: string,
    compute: () => Promise<EventInput[]>,
    options?: AppendOptions,
  ): Promise<AppendResult> {
    const result = await this.locks.runExclusive(streamId, async () => {
      const events = await compute();
      return this.appendSqliteLocked(
        streamId,
        events,
        { idempotencyKey },
        options,
      );
    });
    this.notifyCommit(streamId, result);
    return result;
  }

  /**
   * Runs a decision once per operation. A stored claim for `operationId`
   * returns its result without the write lock, and the closure does not run.
   * A different digest throws {@link OperationDigestMismatchError}.
   *
   * On a miss, the closure, the sequence allocation, the claim, and the events
   * run in one `BEGIN IMMEDIATE` transaction. The closure is synchronous,
   * because a SQLite transaction callback cannot span an await.
   */
  async decideOnce<TResult>(
    operationId: string,
    requestDigest: string,
    closure: (ctx: DecideOnceContext) => DecideOnceDecision<TResult>,
  ): Promise<TResult> {
    if (!operationId) {
      throw new Error('decideOnce requires operationId');
    }
    if (!requestDigest) {
      throw new Error('decideOnce requires requestDigest');
    }

    await fs.mkdir(this.stateDir, { recursive: true });
    const backend = await this.ensureSqliteBackend();

    const existing = backend.lookupOperationClaim<TResult>(operationId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new OperationDigestMismatchError(
          operationId,
          existing.requestDigest,
          requestDigest,
        );
      }
      return existing.result;
    }

    let decidedStreamId: string | undefined;
    try {
      const outcome = await backend.atomicDecideOnce<TResult>({
        operationId,
        requestDigest,
        decide: () => {
          const ctx: DecideOnceContext = {
            readStream: (streamId): DecideOnceStreamSnapshot => {
              const events = backend.queryEvents(streamId) as DecideOnceStoredEvent[];
              const version =
                events.length === 0
                  ? 0
                  : (events[events.length - 1]?.sequence ?? 0);
              return { events, version };
            },
          };
          const decision = closure(ctx);
          decidedStreamId = decision.streamId;
          const inputEvents = [...decision.events];
          let persisted: PersistedEvent[] = [];

          return {
            streamId: decision.streamId,
            n: inputEvents.length,
            result: decision.result,
            ...(decision.expectedSequence !== undefined
              ? { expectedSequence: decision.expectedSequence }
              : {}),
            finalize: (base: number) => {
              persisted = inputEvents.map((input, index) => ({
                ...input,
                streamId: decision.streamId,
                sequence: base + index + 1,
                timestamp: input.timestamp ?? new Date().toISOString(),
                type: input.type,
                eventId: randomUUID(),
              }));
              const events: SqliteAtomicAppendEvent[] = persisted.map((event) => ({
                sequence: event.sequence,
                type: event.type,
                timestamp: event.timestamp,
                data: event.data,
                payload: JSON.stringify(event),
                ...(typeof event.operationId === 'string'
                  ? { operationId: event.operationId }
                  : {}),
                ...(typeof event.correlationId === 'string'
                  ? { correlationId: event.correlationId }
                  : {}),
                ...(typeof event.causationId === 'string'
                  ? { causationId: event.causationId }
                  : {}),
              }));
              return {
                events,
                eventIds: persisted.map((event) => event.eventId),
                timestamps: persisted.map((event) => event.timestamp),
                events_json: JSON.stringify(persisted),
              };
            },
          };
        },
      });

      if (outcome.kind === 'committed') {
        this.notifyCommit(outcome.streamId, {
          ok: true,
          kind: 'committed',
          sequences: outcome.sequences,
          eventIds: outcome.eventIds,
          timestamps: outcome.timestamps,
        });
      }
      return outcome.result;
    } catch (error) {
      if (error instanceof OperationDigestConflictError) {
        throw new OperationDigestMismatchError(
          error.operationId,
          error.expectedDigest,
          error.actualDigest,
        );
      }
      if (error instanceof SequenceGateConflictError) {
        throw new ConcurrencyError({
          streamId: decidedStreamId ?? '<unknown>',
          reducerId: 'decideOnce',
          expectedVersion: error.expected,
          actualVersion: error.actual,
          operationId,
        });
      }
      if (error instanceof SqliteBusyExhaustedError) {
        throw new StorageBusyError({
          streamId: decidedStreamId ?? '<unknown>',
          attempts: error.attempts,
          cause: error,
        });
      }
      throw error;
    }
  }

  /**
   * Loads and folds the stream, runs `fn`, and appends its events with
   * `expectedSequence` set to the folded tail. The reducer must own the
   * consistency boundary of the aggregate.
   *
   * A lost race throws {@link ConcurrencyError}, and the caller must decide
   * again on fresh state. Exhausted SQLITE_BUSY retries throw
   * {@link StorageBusyError}, and the caller can retry the same decision.
   */
  async decide<TState>(
    streamId: string,
    reducerId: string,
    fn: (
      state: TState,
      ctx: DecideContext,
    ) => EventInput[] | Promise<EventInput[]>,
    opts?: DecideOptions,
  ): Promise<DecideResult> {
    const reducer = this.resolveStreamReducer(reducerId, opts?.registry);

    const backend = await this.ensureSqliteBackend();
    const events = backend.queryEvents(streamId);

    let state: unknown = reducer.initial;
    for (const ev of events) {
      state = (reducer as ProjectionReducer<unknown, unknown>).apply(state, ev);
    }
    const tailVersion =
      events.length === 0 ? 0 : ((events[events.length - 1]?.sequence ?? 0) as number);

    const ctx: DecideContext = {
      streamId,
      version: tailVersion,
      now: () => new Date().toISOString(),
    };
    const produced = await fn(state as TState, ctx);

    if (produced.length === 0) {
      const alwaysEnforce = opts?.alwaysEnforceConsistency ?? true;
      if (alwaysEnforce) {
        const currentTail = backend.readSequenceHighWaterMark(streamId);
        if (currentTail !== tailVersion) {
          throw new ConcurrencyError({
            streamId,
            reducerId,
            expectedVersion: tailVersion,
            actualVersion: currentTail,
            operationId: opts?.operationId,
          });
        }
      }
      return {
        ok: true,
        kind: 'no-op',
        sequences: [],
        eventIds: [],
        timestamps: [],
      };
    }

    const idemKey =
      opts?.operationId !== undefined
        ? `${streamId}:${reducerId}:${opts.operationId}`
        : `decide:${streamId}:${reducerId}:${randomUUID()}`;
    const result = await this.appendComputed(
      streamId,
      idemKey,
      async () => produced,
      { expectedSequence: tailVersion },
    );

    return this.translateDecideResult({
      result,
      streamId,
      reducerId,
      expectedVersion: tailVersion,
      operationId: opts?.operationId,
    });
  }

  /**
   * Like {@link decide}, but the closure gets a {@link Session} and can call
   * services before it resolves. Events queued with `session.append` commit
   * atomically with `expectedSequence` set to the tail.
   *
   * The session closes before the commit, or when the closure throws, so a
   * captured session cannot append later. Without `operationId` or
   * `allowNonIdempotent: true`, the call throws
   * {@link InvalidSessionOptionsError}.
   */
  async withSession<TState>(
    streamId: string,
    reducerId: string,
    fn: (session: Session<TState>, ctx: DecideContext) => Promise<void>,
    opts?: WithSessionOptions,
  ): Promise<DecideResult> {
    if (
      opts?.operationId === undefined &&
      opts?.allowNonIdempotent !== true
    ) {
      throw new InvalidSessionOptionsError();
    }

    const reducer = this.resolveStreamReducer(reducerId, opts?.registry);

    const backend = await this.ensureSqliteBackend();
    const events = backend.queryEvents(streamId);
    let state: unknown = reducer.initial;
    for (const ev of events) {
      state = (reducer as ProjectionReducer<unknown, unknown>).apply(state, ev);
    }
    const tailVersion =
      events.length === 0 ? 0 : ((events[events.length - 1]?.sequence ?? 0) as number);

    const pending: EventInput[] = [];
    let closed = false;
    const session: Session<TState> = {
      aggregate: state as TState,
      version: tailVersion,
      append(event: EventInput) {
        if (closed) {
          throw new SessionClosedError(streamId);
        }
        pending.push(event);
      },
    };

    const ctx: DecideContext = {
      streamId,
      version: tailVersion,
      now: () => new Date().toISOString(),
    };

    try {
      await fn(session, ctx);
    } catch (err) {
      closed = true;
      throw err;
    }

    closed = true;

    if (pending.length === 0) {
      const alwaysEnforce = opts?.alwaysEnforceConsistency ?? true;
      if (alwaysEnforce) {
        const currentTail = backend.readSequenceHighWaterMark(streamId);
        if (currentTail !== tailVersion) {
          throw new ConcurrencyError({
            streamId,
            reducerId,
            expectedVersion: tailVersion,
            actualVersion: currentTail,
            operationId: opts?.operationId,
          });
        }
      }
      return {
        ok: true,
        kind: 'no-op',
        sequences: [],
        eventIds: [],
        timestamps: [],
      };
    }

    const idemKey =
      opts?.operationId !== undefined
        ? `${streamId}:${reducerId}:${opts.operationId}`
        : `with-session:${streamId}:${reducerId}:${randomUUID()}`;
    const result = await this.appendComputed(
      streamId,
      idemKey,
      async () => pending,
      { expectedSequence: tailVersion },
    );

    return this.translateDecideResult({
      result,
      streamId,
      reducerId,
      expectedVersion: tailVersion,
      operationId: opts?.operationId,
    });
  }

  /**
   * Folds the stream through a registered reducer and returns the aggregate
   * and the tail version. It does not write. A caller that reads, decides,
   * and writes must use `decide` or `withSession`.
   *
   * The one `queryEvents` SELECT reads one WAL snapshot. A second read added
   * here must share a `db.transaction(fn)` with the first. Two implicit
   * transactions can see different commits, and the fold then mixes two
   * snapshots.
   */
  async aggregateStream<TState>(
    streamId: string,
    reducerId: string,
    opts?: Pick<DecideOptions, 'registry'>,
  ): Promise<{ aggregate: TState; version: number }> {
    const reducer = this.resolveStreamReducer(reducerId, opts?.registry);
    const backend = await this.ensureSqliteBackend();
    const events = backend.queryEvents(streamId);
    let state: unknown = reducer.initial;
    for (const ev of events) {
      state = (reducer as ProjectionReducer<unknown, unknown>).apply(state, ev);
    }
    const tailVersion =
      events.length === 0 ? 0 : ((events[events.length - 1]?.sequence ?? 0) as number);
    return { aggregate: state as TState, version: tailVersion };
  }

  /**
   * Maps an {@link AppendResult} to a {@link DecideResult}. `sequence-conflict`
   * throws `ConcurrencyError`, and `storage_busy` throws `StorageBusyError`.
   * Any other failure is a misused idempotency key or a storage fault, and it
   * throws its cause.
   */
  private translateDecideResult(args: {
    result: AppendResult;
    streamId: string;
    reducerId: string;
    expectedVersion: number;
    operationId?: string | undefined;
  }): DecideResult {
    const { result, streamId, reducerId, expectedVersion, operationId } = args;
    if (result.ok) {
      return {
        ok: true,
        kind: result.kind,
        sequences: result.sequences,
        eventIds: result.eventIds,
        timestamps: result.timestamps,
      };
    }
    if (result.reason === 'sequence-conflict') {
      throw new ConcurrencyError({
        streamId,
        reducerId,
        expectedVersion: result.expected ?? expectedVersion,
        actualVersion: result.actual ?? expectedVersion,
        operationId,
      });
    }
    if (result.reason === 'storage_busy') {
      throw new StorageBusyError({
        streamId,
        attempts: STORAGE_BUSY_MAX_ATTEMPTS,
        cause: result.cause ?? new Error('SQLITE_BUSY'),
      });
    }
    if (result.cause) throw result.cause;
    throw new Error(`decide failed: ${result.reason}`);
  }

  /**
   * Resolves a reducer id against the given registry, or the default registry.
   * There is no runtime scope check. The `scope` docstring on
   * `ProjectionReducer` in `projections/types.ts` states why that is safe.
   */
  private resolveStreamReducer(
    reducerId: string,
    registry?: ProjectionRegistry,
  ): ProjectionReducer<unknown, unknown> {
    const reg = registry ?? defaultRegistry;
    const reducer = reg.get(reducerId);
    if (!reducer) {
      throw new UnknownProjectionIdError(reducerId);
    }
    return reducer;
  }

  /**
   * Returns the backend. On first use, it opens and initializes an owned
   * backend at `stateDir/sqliteDbFilename`. An injected backend returns as it
   * is.
   *
   * The in-flight Promise is cached before any await, so concurrent first
   * writes to different streams share one handle. A failed init clears the
   * cache, so the next call retries and one transient error does not break
   * the appender.
   */
  private async ensureSqliteBackend(): Promise<SqliteBackend> {
    if (this.sqliteBackendPromise) {
      return this.sqliteBackendPromise;
    }
    this.assertOpen();
    const inflight = (async (): Promise<SqliteBackend> => {
      const dbPath = path.join(this.stateDir, this.sqliteDbFilename);
      const backend = new SqliteBackend(
        dbPath,
        this.synchronous ? { synchronous: this.synchronous } : {},
      );
      backend.initialize();
      this.sqliteBackend = backend;
      return backend;
    })();
    this.sqliteBackendPromise = inflight;
    try {
      return await inflight;
    } catch (err) {
      this.sqliteBackendPromise = undefined;
      throw err;
    }
  }

  /**
   * The append body. The caller holds the stream lock.
   *
   * The idempotency lookup runs before `BEGIN IMMEDIATE`, so a retry does not
   * take the write lock. The backend allocates the sequence and checks
   * `expectedSequence` inside the transaction, so no read happens outside it.
   * `finalize` builds the rows there from the allocated base. It has no side
   * effects, because a busy retry runs it again. The payload JSON is the
   * record, and the id columns only index it.
   */
  private async appendSqliteLocked(
    streamId: string,
    events: EventInput[],
    keyed: { idempotencyKey: string } | null,
    options?: AppendOptions,
  ): Promise<AppendResult> {
    if (!streamId || streamId.length === 0) {
      return { ok: false, reason: 'io-error', cause: new Error('streamId required') };
    }
    try {
      validateStreamId(streamId);
    } catch (err) {
      return { ok: false, reason: 'io-error', cause: toError(err) };
    }
    if (!Array.isArray(events) || events.length === 0) {
      return { ok: false, reason: 'io-error', cause: new Error('events must be non-empty array') };
    }
    if (keyed !== null && (!keyed.idempotencyKey || keyed.idempotencyKey.length === 0)) {
      return { ok: false, reason: 'io-error', cause: new Error('idempotencyKey required') };
    }

    let backend: SqliteBackend;
    try {
      await fs.mkdir(this.stateDir, { recursive: true });
      backend = await this.ensureSqliteBackend();
    } catch (err) {
      return { ok: false, reason: 'io-error', cause: toError(err) };
    }

    if (keyed !== null) {
      try {
        const claim = backend.lookupIdempotencyClaim(streamId, keyed.idempotencyKey);
        if (claim) {
          return {
            ok: true,
            kind: 'cache-hit',
            sequences: claim.sequences,
            eventIds: claim.eventIds,
            timestamps: claim.timestamps,
            persistedEvents: claim.events.map(e => ({ ...e } as PublicPersistedEvent)),
          };
        }
      } catch (err) {
        return { ok: false, reason: 'io-error', cause: toError(err) };
      }
    }

    let persisted: PersistedEvent[] = [];
    const finalize = (base: number): {
      events: SqliteAtomicAppendEvent[];
      claim?: {
        eventIds: string[];
        sequences: number[];
        timestamps: string[];
        events_json: string;
      };
    } => {
      persisted = events.map((evt, i) => {
        const event: PersistedEvent = {
          ...evt,
          streamId,
          sequence: base + i + 1,
          timestamp: evt.timestamp ?? new Date().toISOString(),
          type: evt.type,
          eventId: randomUUID(),
        };
        if (keyed !== null) {
          event.idempotencyKey = keyed.idempotencyKey;
        }
        return event;
      });

      const wireEvents: SqliteAtomicAppendEvent[] = persisted.map(e => ({
        sequence: e.sequence,
        type: e.type,
        timestamp: e.timestamp,
        data: e.data,
        payload: JSON.stringify(e),
        ...(typeof e.operationId === 'string' ? { operationId: e.operationId } : {}),
        ...(typeof e.correlationId === 'string' ? { correlationId: e.correlationId } : {}),
        ...(typeof e.causationId === 'string' ? { causationId: e.causationId } : {}),
      }));

      const claim =
        keyed !== null
          ? {
              eventIds: persisted.map(e => e.eventId),
              sequences: persisted.map(e => e.sequence),
              timestamps: persisted.map(e => e.timestamp),
              events_json: JSON.stringify(persisted),
            }
          : undefined;

      return { events: wireEvents, ...(claim ? { claim } : {}) };
    };

    try {
      await backend.atomicAppend({
        streamId,
        idempotencyKey: keyed?.idempotencyKey ?? null,
        n: events.length,
        ...(options?.expectedSequence !== undefined
          ? { expectedSequence: options.expectedSequence }
          : {}),
        finalize,
      });
    } catch (err) {
      if (err instanceof SqliteBusyExhaustedError) {
        return { ok: false, reason: 'storage_busy', cause: err };
      }
      if (err instanceof SequenceGateConflictError) {
        return {
          ok: false,
          reason: 'sequence-conflict',
          expected: err.expected,
          actual: err.actual,
        };
      }
      const e = toError(err);
      return this.translateAtomicAppendError({
        error: e,
        backend,
        streamId,
        keyed,
      });
    }

    return {
      ok: true,
      kind: 'committed',
      sequences: persisted.map(e => e.sequence),
      eventIds: persisted.map(e => e.eventId),
      timestamps: persisted.map(e => e.timestamp),
    };
  }

  /**
   * Maps an `atomicAppend` error that is not a gate conflict or a busy
   * exhaustion.
   *
   * A UNIQUE failure on `idempotency_claims` means that another appender won
   * the race for the key. The claim of the winner returns as a cache-hit. If
   * the re-read fails or finds no claim, the result is `idempotency-claimed`.
   *
   * Any other error returns `io-error`. The gate always gives a free slot, so
   * an `events` primary-key violation is corruption, not a retryable conflict.
   */
  private translateAtomicAppendError(args: {
    error: Error;
    backend: SqliteBackend;
    streamId: string;
    keyed: { idempotencyKey: string } | null;
  }): AppendResult {
    const { error, backend, streamId, keyed } = args;
    const msg = error.message;
    const isIdempotencyConflict =
      /UNIQUE constraint failed: idempotency_claims/.test(msg) ||
      /idempotency_claims.streamId, idempotency_claims.idempotencyKey/.test(msg);

    if (isIdempotencyConflict && keyed !== null) {
      try {
        const claim = backend.lookupIdempotencyClaim(streamId, keyed.idempotencyKey);
        if (claim) {
          return {
            ok: true,
            kind: 'cache-hit',
            sequences: claim.sequences,
            eventIds: claim.eventIds,
            timestamps: claim.timestamps,
            persistedEvents: claim.events.map(e => ({ ...e } as PublicPersistedEvent)),
          };
        }
      } catch {
      }
      return { ok: false, reason: 'idempotency-claimed', cause: error };
    }

    return { ok: false, reason: 'io-error', cause: error };
  }

  /**
   * Returns the backend, or `undefined` before the first append or
   * `ensureSqliteBackendSync()` call. Read paths use it to share the handle
   * of the writer. Tests patch driver methods on it to inject faults.
   */
  getSqliteBackend(): SqliteBackend | undefined {
    return this.sqliteBackend;
  }

  /**
   * Opens the owned backend now, for a read that comes before any write. It
   * does nothing when the backend exists. It passes the configured
   * `synchronous` value, because later writes reuse this handle. It also
   * fills the Promise cache, so the async path shares the handle.
   */
  ensureSqliteBackendSync(): SqliteBackend {
    if (this.sqliteBackend) return this.sqliteBackend;
    this.assertOpen();
    mkdirSync(this.stateDir, { recursive: true });
    const dbPath = path.join(this.stateDir, this.sqliteDbFilename);
    const backend = new SqliteBackend(
      dbPath,
      this.synchronous ? { synchronous: this.synchronous } : {},
    );
    backend.initialize();
    this.sqliteBackend = backend;
    this.sqliteBackendPromise = Promise.resolve(backend);
    return backend;
  }

  /**
   * Releases the owned SQLite backend handle. It is idempotent, synchronous and final.
   * After close, this appender never opens a handle again, so an operation still in flight cannot
   * reopen `exarchos.db` after the owner released it. On Windows such a handle makes `fs.rm` of the
   * directory fail with EBUSY. The owner makes a new appender for later work. An injected backend
   * stays open, because its injector owns it.
   */
  close(): void {
    this.closed = true;
    if (!this.sqliteBackendInjected) {
      this.sqliteBackend?.close();
    }
    this.sqliteBackend = undefined;
    this.sqliteBackendPromise = undefined;
  }

  /** Throw {@link AppenderClosedError} when {@link close} has run. */
  private assertOpen(): void {
    if (this.closed) throw new AppenderClosedError(this.stateDir);
  }
}

/**
 * Raised when work reaches an {@link AtomicAppender} after its `close()`.
 * The append paths report it as an `io-error` result.
 */
export class AppenderClosedError extends Error {
  override readonly name = 'AppenderClosedError';
  readonly code = 'APPENDER_CLOSED';

  constructor(readonly stateDir: string) {
    super(`event appender for ${stateDir} is closed; it does not open the store again`);
  }
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}
