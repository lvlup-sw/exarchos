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
// Contract (post stream-version-gate, DR-2): this retry is reserved for
// GENUINE optimistic-concurrency callers — state-store CAS writes and
// event-stream handlers that pass `expectedSequence` (directly or via
// `decide`/`withSession`). A PLAIN append (no `expectedSequence`) can no
// longer surface a conflict: the gate assigns its sequence under the write
// lock, so the loser serializes transparently instead of racing. Plain-append
// paths are therefore NOT wrapped here — wrapping one would be dead code.
// (The MCP `exarchos_event append` surface is intentionally un-wrapped.)
//
// Designed to be small and dependency-free — only `VersionConflictError`
// from `state-store.ts` and the standard `setTimeout`. Callers wrap any
// closure that ends in a `writeStateFile` call.

import { VersionConflictError } from './state-store.js';
import { ConcurrencyError } from '../events/concurrency-error.js';
import { StorageBusyError } from '../events/storage-busy-error.js';
import { SequenceConflictError } from '../events/store.js';

/** Maximum number of attempts (initial + retries) before bubbling out. */
export const MAX_STATE_RETRIES = 3;

/** Base delay in ms for exponential backoff with jitter. */
export const STATE_BASE_DELAY_MS = 50;

/**
 * Predicate: should `withStateRetry` treat `err` as a retryable transient
 * signal? Wave 4 / Task 4.1 (audit §F2.1) widens the recognizer beyond the
 * legacy `VersionConflictError` (state-store CAS) to also accept the R-2
 * primitive layer's typed errors:
 *
 *   - `ConcurrencyError` — OCC loss on the event-stream tail. Caller must
 *     re-fetch state and re-decide; the retry loop handles that because the
 *     wrapped closure routes through `decide`/`withSession` which read+fold
 *     on every invocation.
 *   - `StorageBusyError` — substrate `BEGIN IMMEDIATE` retry budget
 *     exhausted. The other writer commits on its own; the same closure
 *     succeeds on the next attempt.
 *   - `SequenceConflictError` — legacy OCC signal raised by
 *     `EventStore.append()` (separate from the R-2 primitive layer's
 *     `ConcurrencyError`). Wave-B `*.requested` Phase-A appends route
 *     through this surface; without recognizing the legacy class the
 *     retry loop never fires under real OCC, so the requested-event
 *     write surfaces immediately as a terminal failure.
 *     (CodeRabbit review #4278133032 on PR #1344.)
 *
 * Without this widening, a `decide`-based migration target (merge-orchestrate,
 * execute-merge) or a Wave-B two-event-split handler (create-pr, create-issue,
 * add-pr-comment, branch.delete, worktree.remove) would surface a transient
 * substrate or OCC signal as a terminal failure to the operator. Four classes,
 * one retry policy — the recovery posture (back off, re-decide) is identical.
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
 * Retry `fn` on any retryable transient signal up to `MAX_STATE_RETRIES`
 * times with exponential backoff + jitter. Other errors propagate
 * immediately.
 *
 * After exhaustion the underlying error (whichever retryable class
 * triggered the loop) is re-thrown so top-level handlers can map it to a
 * structured `ToolResult` (`STATE_CONFLICT`, `CONCURRENCY_CONFLICT`, or
 * `STORAGE_BUSY` per `format.ts:wrapError`) rather than a raw exception.
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
  // Unreachable: the loop either returns or throws on every iteration.
  throw new Error('withStateRetry: unreachable');
}
