// ─── Optimistic-concurrency retry for workflow state writes ─────────────
//
// Workflow state files are read-mutate-written via `state-store.ts`. The
// store's CAS (compare-and-swap) check throws `VersionConflictError` when a
// concurrent writer raced ahead, leaving the caller's payload stale.
// Handlers respond by re-reading, re-applying their mutation, and retrying
// the write — exactly the optimistic-concurrency pattern `handleTaskClaim`
// established in `tasks/tools.ts`.
//
// This module is the single source of truth for the retry constants and
// the retry helper. Inline copies should NOT exist; if a third call site
// appears, import from here.
//
// Designed to be small and dependency-free — only `VersionConflictError`
// from `state-store.ts` and the standard `setTimeout`. Callers wrap any
// closure that ends in a `writeStateFile` call.

import { VersionConflictError } from './state-store.js';

/** Maximum number of attempts (initial + retries) before bubbling out. */
export const MAX_STATE_RETRIES = 3;

/** Base delay in ms for exponential backoff with jitter. */
export const STATE_BASE_DELAY_MS = 50;

/**
 * Retry `fn` on `VersionConflictError` up to `MAX_STATE_RETRIES` times with
 * exponential backoff + jitter. Other errors propagate immediately.
 *
 * After exhaustion the underlying `VersionConflictError` is re-thrown so
 * top-level handlers can map it to a structured `STATE_CONFLICT`
 * `ToolResult` (rather than a raw exception).
 */
export async function withStateRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_STATE_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof VersionConflictError)) throw err;
      if (attempt === MAX_STATE_RETRIES - 1) throw err;
      const delay =
        STATE_BASE_DELAY_MS * Math.pow(2, attempt) +
        Math.random() * STATE_BASE_DELAY_MS;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Unreachable: the loop either returns or throws on every iteration.
  throw new Error('withStateRetry: unreachable');
}
