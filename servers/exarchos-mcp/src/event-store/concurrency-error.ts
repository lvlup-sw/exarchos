/**
 * Typed error raised by the R-2 primitive layer (`decide`, `withSession`)
 * when a stream's tail advanced between the read+fold phase and the commit
 * phase — i.e. another writer claimed sequences in the window between when
 * the decision was made and when its events would be appended.
 *
 * **Distinct from `VersionConflictError`** (state-store CAS): that one
 * guards `${featureId}.state.json` writes; this one guards event-store
 * appends. Wave 4 updates `withStateRetry` to catch both shapes during
 * the migration window.
 *
 * **Distinct from `StorageBusyError`** (substrate contention): that one
 * is a transient signal — the other writer commits on its own, no re-fold
 * required. `ConcurrencyError` semantically requires the caller to
 * re-fetch state and re-decide, because the input the decision was based
 * on is stale.
 *
 * The `name` field is set to `'ConcurrencyError'` so middleware can
 * pattern-match by `err.name` without importing the class — useful for
 * loose-coupling at the retry boundary.
 *
 * Per design `docs/designs/archive/2026-05-10-v2-10-0-preview-2-marten-primitives.md`
 * §"ConcurrencyError envelope" — the `wrap()` boundary maps this to
 * `CONCURRENCY_CONFLICT` with `validTargets: ['retry']` (INV-5b).
 */
export interface ConcurrencyErrorOptions {
  readonly streamId: string;
  readonly reducerId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
  /**
   * Optional caller-supplied operation correlator. When `decide`/`withSession`
   * was invoked with `opts.operationId`, that value flows through here so
   * downstream observers can correlate retries back to the originating
   * command id.
   */
  readonly operationId?: string;
}

export class ConcurrencyError extends Error {
  readonly streamId: string;
  readonly reducerId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
  readonly operationId?: string;

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
