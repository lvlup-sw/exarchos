/**
 * Typed error raised by the R-2 primitive layer (`decide`, `withSession`)
 * when the substrate's bounded `BEGIN IMMEDIATE` retry budget exhausts
 * (audit §F2.1). Sibling to `ConcurrencyError` — distinct semantic shape
 * because the recovery posture is different:
 *
 *   - `ConcurrencyError` — OCC lost. Caller MUST re-fetch state and
 *     re-decide before retrying.
 *   - `StorageBusyError` — substrate contention. Caller may retry the
 *     SAME decision after backing off; the other writer commits on its
 *     own.
 *
 * The fixed `code: 'STORAGE_BUSY'` field lets middleware match on the
 * code without importing the class.
 *
 * Per design `docs/designs/archive/2026-05-10-v2-10-0-preview-2-marten-primitives.md`
 * §"StorageBusyError envelope" — the `wrap()` boundary maps this to
 * `STORAGE_BUSY` with `validTargets: ['retry']` and a back-off
 * suggestedFix.
 */
export interface StorageBusyErrorOptions {
  readonly streamId: string;
  /**
   * Number of attempts the substrate exhausted before raising. For the
   * current SQLite substrate this is bounded by
   * `SQLITE_BUSY_RETRY_POLICY.maxAttempts` (5).
   */
  readonly attempts: number;
  /**
   * The underlying substrate error (e.g. the typed
   * `SqliteBusyExhaustedError` from the substrate body). Carried so
   * observers can inspect the original SQLITE_BUSY chain.
   */
  readonly cause: Error;
}

export class StorageBusyError extends Error {
  readonly code = 'STORAGE_BUSY' as const;
  readonly streamId: string;
  readonly attempts: number;
  // Property is declared so it is enumerable and accessible on the
  // typed instance; Node's `Error` accepts `cause` via the options bag
  // (ES2022), but we also retain it as our own readable field.
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
