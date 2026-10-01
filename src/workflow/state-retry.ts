/**
 * Optimistic-concurrency retry for workflow state writes, and the one home of its constants.
 * When a concurrent writer wins, the write throws a conflict error and the payload of the caller is stale.
 * The caller then reads again, applies its mutation again, and writes again.
 *
 * Use this retry only for state-store CAS writes and for appends that pass `expectedSequence`.
 * A plain append cannot get a conflict, because the store assigns its sequence under the write lock.
 */

import { VersionConflictError } from './state-store.js';
import { ConcurrencyError } from '../events/concurrency-error.js';
import { StorageBusyError } from '../events/storage-busy-error.js';
import { SequenceConflictError } from '../events/store.js';

/** Maximum number of attempts (initial + retries) before bubbling out. */
export const MAX_STATE_RETRIES = 3;

/** Base delay in ms for exponential backoff with jitter. */
export const STATE_BASE_DELAY_MS = 50;

/**
 * True when `withStateRetry` must retry after `err`.
 * Four error classes share one recovery: back off, then read and decide again.
 * `VersionConflictError` is a state-store CAS loss. `ConcurrencyError` and `SequenceConflictError` are event-stream OCC losses.
 * `StorageBusyError` means the `BEGIN IMMEDIATE` budget is spent while another writer commits.
 */
function isRetryable(err: unknown): boolean {
  return (
    err instanceof VersionConflictError ||
    err instanceof ConcurrencyError ||
    err instanceof StorageBusyError ||
    err instanceof SequenceConflictError
  );
}

/**
 * Retry `fn` on a retryable error, at most `MAX_STATE_RETRIES` attempts, with exponential backoff and jitter.
 * Other errors propagate immediately. `fn` must read the state again on each call, or a retry writes the same stale payload.
 * After the last attempt, the original error propagates, so `wrapError` in `format.ts` can map it to a structured `ToolResult`.
 */
export async function withStateRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_STATE_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err)) throw err;
      if (attempt === MAX_STATE_RETRIES - 1) throw err;
      const delay =
        STATE_BASE_DELAY_MS * Math.pow(2, attempt) +
        Math.random() * STATE_BASE_DELAY_MS;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('withStateRetry: unreachable');
}
