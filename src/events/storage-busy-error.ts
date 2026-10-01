/** Fields of a {@link StorageBusyError}. */
export interface StorageBusyErrorOptions {
  readonly streamId: string;
  /** Attempts that the substrate used before it threw. SQLite caps it at `SQLITE_BUSY_RETRY_POLICY.maxAttempts`. */
  readonly attempts: number;
  /** The substrate error, for example `SqliteBusyExhaustedError`, so observers can read the SQLITE_BUSY chain. */
  readonly cause: Error;
}

/**
 * Thrown by `decide` and `withSession` when the bounded `BEGIN IMMEDIATE` retry
 * budget of the substrate runs out. The caller can retry the same decision after
 * a back-off, because the other writer commits on its own.
 *
 * A {@link ConcurrencyError} differs: the caller must re-fetch state first.
 * `wrapError` maps this error to `STORAGE_BUSY` with `validTargets: ['retry']`.
 * The fixed `code` lets middleware match the error without an import of the class.
 */
export class StorageBusyError extends Error {
  readonly code = 'STORAGE_BUSY' as const;
  readonly streamId: string;
  readonly attempts: number;
  /** An own field, so `cause` is enumerable on the typed instance. `super` also gets it through the options bag. */
  readonly cause: Error;

  constructor(opts: StorageBusyErrorOptions) {
    super(
      `SQLite write lock contention persisted after ${opts.attempts} attempts on stream ${JSON.stringify(opts.streamId)}`,
      { cause: opts.cause },
    );
    this.name = 'StorageBusyError';
    this.streamId = opts.streamId;
    this.attempts = opts.attempts;
    this.cause = opts.cause;
  }
}
