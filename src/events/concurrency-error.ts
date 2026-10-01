/** Fields of a {@link ConcurrencyError}. */
export interface ConcurrencyErrorOptions {
  readonly streamId: string;
  readonly reducerId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
  /** The `opts.operationId` of `decide` or `withSession`, so observers can link a retry to its command. */
  readonly operationId?: string | undefined;
}

/**
 * Thrown by `decide` and `withSession` when another writer advanced the stream
 * tail between the fold and the commit. The caller must re-fetch state and decide again.
 *
 * `VersionConflictError` guards `.state.json` writes, and this error guards event
 * appends. `StorageBusyError` is transient contention that needs no new fold.
 * `wrapError` maps this error to `CONCURRENCY_CONFLICT` with `validTargets: ['retry']`.
 */
export class ConcurrencyError extends Error {
  readonly streamId: string;
  readonly reducerId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
  readonly operationId?: string | undefined;

  constructor(opts: ConcurrencyErrorOptions) {
    super(
      `Stream ${JSON.stringify(opts.streamId)} tail advanced from version ${opts.expectedVersion} to ${opts.actualVersion} (reducer ${JSON.stringify(opts.reducerId)})`,
    );
    this.name = 'ConcurrencyError';
    this.streamId = opts.streamId;
    this.reducerId = opts.reducerId;
    this.expectedVersion = opts.expectedVersion;
    this.actualVersion = opts.actualVersion;
    this.operationId = opts.operationId;
  }
}
