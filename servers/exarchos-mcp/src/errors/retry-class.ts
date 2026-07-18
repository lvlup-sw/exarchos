// ─── DR-10 (#1693): Retry-class contract — transient vs conflict errors ─────
//
// Single source of truth for HOW a caller should respond to a structured
// Exarchos error code. Before this module, `STORAGE_BUSY` (transient
// substrate contention — retry the SAME intent after backing off) and
// `CONCURRENCY_CONFLICT` (OCC loss — re-read state and re-derive intent
// before retrying) were indistinguishable to a scripted consumer, and each
// discrimination site re-derived its own retry posture locally.
//
// Contract properties (bundle spec DR-10 acceptance):
//
//   - Exhaustive at the TYPE level over the registered `ErrorCode` taxonomy:
//     `ERROR_CODE_RETRY_CLASS` is a `Record<ErrorCodeValue, RetryClassValue>`,
//     so adding a new ErrorCode without a retry class fails `npm run
//     typecheck` — no grep, no runtime enumeration.
//   - Total and FAIL-OPEN over the string domain: `toRetryClass` resolves
//     ANY code — taxonomy codes via the exhaustive map, well-known
//     boundary-minted codes via the supplementary map, and everything else
//     to the documented `fatal` default. "Do not auto-retry" is the safe
//     default direction: skipping a retry merely surfaces the failure, while
//     retrying a non-idempotent operation can duplicate side effects.
//   - Consumed at the seven server-side discrimination sites (`format.ts`,
//     `workflow/state-retry.ts`, `orchestrate/execute-merge.ts`,
//     `orchestrate/merge-orchestrate.ts`, and the three `orchestrate/vcs/`
//     write actions) — no local re-derivation of the retry posture.
//
// Sibling map: `adapters/mcp.ts:ERROR_CODE_TO_JSON_RPC` (DR-9) classifies
// the same taxonomy on an orthogonal axis (JSON-RPC `-32xxx` protocol
// codes). Both are type-exhaustive Records so the two axes cannot drift
// from the taxonomy independently.

import { ErrorCode } from '../workflow/schemas.js';
import type { ErrorCodeValue } from '../workflow/types.js';
import { ConcurrencyError } from '../event-store/concurrency-error.js';
import { StorageBusyError } from '../event-store/storage-busy-error.js';

// ─── Retry classes ──────────────────────────────────────────────────────────

/**
 * The four retry postures a structured error code can carry:
 *
 * - `backoff` — transient contention. Retry the SAME intent after a brief
 *   delay; the interfering writer completes on its own (STORAGE_BUSY).
 * - `re-read` — concurrency conflict. The caller's read is stale: re-read
 *   state, re-derive intent, then retry (CONCURRENCY_CONFLICT,
 *   VERSION_CONFLICT). Also covers stale-view domain refusals whose remedy
 *   is a fresh read (INVALID_TRANSITION, ALREADY_*).
 * - `invalid-input` — caller-fixable. An unchanged retry fails identically;
 *   fix the parameters first.
 * - `fatal` — not mechanically retryable. Escalate or inspect the
 *   substrate; an automated retry loop must stop.
 */
export const RetryClass = {
  BACKOFF: 'backoff',
  RE_READ: 're-read',
  INVALID_INPUT: 'invalid-input',
  FATAL: 'fatal',
} as const;

export type RetryClassValue = (typeof RetryClass)[keyof typeof RetryClass];

/**
 * Canonical per-class guidance prose. Surfaced verbatim through
 * `format.ts:wrapError` (`suggestedFix.params.reason`) and the seven
 * discrimination sites' `error.guidance` field, so the two classes'
 * recovery instructions have exactly one authoring point.
 */
export const RETRY_CLASS_GUIDANCE: Record<RetryClassValue, string> = {
  [RetryClass.BACKOFF]:
    'Transient contention: back off briefly, then retry the same operation unchanged — the other writer completes on its own.',
  [RetryClass.RE_READ]:
    'Concurrency conflict: re-read state and re-derive intent before retrying — the original read is stale.',
  [RetryClass.INVALID_INPUT]:
    'Caller-fixable input: correct the parameters before retrying — an unchanged retry fails identically.',
  [RetryClass.FATAL]:
    'Do not retry: the failure is not transient — escalate or inspect the substrate.',
};

// ─── Taxonomy classification (compile-time exhaustive) ──────────────────────

// Exhaustive over the registered taxonomy (workflow/schemas.ts:ErrorCode).
// The Record type makes exhaustiveness a COMPILE-TIME guarantee: a new
// ErrorCode entry without a row here fails `npm run typecheck`.
export const ERROR_CODE_RETRY_CLASS: Record<ErrorCodeValue, RetryClassValue> = {
  // invalid-input — caller-fixable addressing/params problems.
  [ErrorCode.INVALID_INPUT]: RetryClass.INVALID_INPUT,
  [ErrorCode.RESERVED_FIELD]: RetryClass.INVALID_INPUT,
  [ErrorCode.STATE_NOT_FOUND]: RetryClass.INVALID_INPUT,
  [ErrorCode.STATE_ALREADY_EXISTS]: RetryClass.INVALID_INPUT,
  // re-read — the caller's view of workflow state is stale; a fresh read
  // (and re-derived intent) is the remedy. VERSION_CONFLICT is the
  // state-store CAS OCC loss — the canonical conflict signal.
  [ErrorCode.VERSION_CONFLICT]: RetryClass.RE_READ,
  [ErrorCode.INVALID_TRANSITION]: RetryClass.RE_READ,
  [ErrorCode.ALREADY_CANCELLED]: RetryClass.RE_READ,
  [ErrorCode.ALREADY_COMPLETED]: RetryClass.RE_READ,
  // backoff — clears on its own with time; same intent may be retried.
  // CIRCUIT_OPEN follows the standard breaker contract (cooldown then
  // half-open); SNAPSHOT_WRITE_FAILED is documented retryable — the next
  // checkpoint call repeats the fold and write.
  [ErrorCode.CIRCUIT_OPEN]: RetryClass.BACKOFF,
  [ErrorCode.SNAPSHOT_WRITE_FAILED]: RetryClass.BACKOFF,
  // fatal — not resolvable by retrying or re-reading: the state genuinely
  // refuses (GUARD_FAILED needs the obligation fulfilled, PHASE_BLOCKED is
  // fail-closed substrate integrity), or the substrate itself is faulted /
  // misconfigured. Undifferentiated I/O and append faults classify fatal
  // deliberately: their transient cases surface as their own codes
  // (STORAGE_BUSY / CONCURRENCY_CONFLICT), so what remains must not spin
  // an automated retry loop.
  [ErrorCode.GUARD_FAILED]: RetryClass.FATAL,
  [ErrorCode.PHASE_BLOCKED]: RetryClass.FATAL,
  [ErrorCode.STATE_CORRUPT]: RetryClass.FATAL,
  [ErrorCode.MIGRATION_FAILED]: RetryClass.FATAL,
  [ErrorCode.COMPENSATION_PARTIAL]: RetryClass.FATAL,
  [ErrorCode.FILE_IO_ERROR]: RetryClass.FATAL,
  [ErrorCode.EVENT_APPEND_FAILED]: RetryClass.FATAL,
  [ErrorCode.EVENT_MIGRATION_FAILED]: RetryClass.FATAL,
  [ErrorCode.EVENT_STORE_NOT_CONFIGURED]: RetryClass.FATAL,
  [ErrorCode.PROJECTION_REPLAY_FAILED]: RetryClass.FATAL,
};

// ─── Boundary-minted codes (string domain) ──────────────────────────────────

/**
 * The two transient/conflict codes minted at the wrap boundary rather than
 * in the workflow taxonomy. Exported so discrimination sites and tests name
 * them symbolically instead of re-typing string literals.
 */
export const TRANSIENT_ERROR_CODES = {
  CONCURRENCY_CONFLICT: 'CONCURRENCY_CONFLICT',
  STORAGE_BUSY: 'STORAGE_BUSY',
} as const;

// Well-known codes minted outside the workflow taxonomy: the wrap-boundary
// envelope codes (format.ts), the dispatch core's own rejections
// (core/dispatch.ts), the schema-to-flags validation code, and the
// merge-path OCC-exhaustion code. Explicit rows so their class is
// deterministic-by-contract rather than falling through the default.
const BOUNDARY_CODE_RETRY_CLASS: Record<string, RetryClassValue> = {
  [TRANSIENT_ERROR_CODES.CONCURRENCY_CONFLICT]: RetryClass.RE_READ,
  [TRANSIENT_ERROR_CODES.STORAGE_BUSY]: RetryClass.BACKOFF,
  // Merge-path OCC exhaustion (`VersionConflictError` → STATE_CONFLICT in
  // execute-merge / merge-orchestrate) — same posture as VERSION_CONFLICT.
  STATE_CONFLICT: RetryClass.RE_READ,
  // Dispatch-core rejections — caller addressed a nonexistent surface.
  MISSING_ACTION: RetryClass.INVALID_INPUT,
  UNKNOWN_ACTION: RetryClass.INVALID_INPUT,
  UNKNOWN_TOOL: RetryClass.INVALID_INPUT,
  // `VALIDATION_ERROR` (adapters/schema-to-flags.ts) duplicates
  // INVALID_INPUT semantics on the CLI flag-parsing surface.
  VALIDATION_ERROR: RetryClass.INVALID_INPUT,
  CAPABILITY_DENIED: RetryClass.FATAL,
  COMPOSITE_LOAD_FAILED: RetryClass.FATAL,
  INTERNAL_ERROR: RetryClass.FATAL,
};

function isErrorCodeValue(code: string): code is ErrorCodeValue {
  return Object.prototype.hasOwnProperty.call(ERROR_CODE_RETRY_CLASS, code);
}

// ─── Resolvers ──────────────────────────────────────────────────────────────

/**
 * Resolve any structured error code to its retry class.
 *
 * Total and fail-open: taxonomy codes resolve via the type-exhaustive map,
 * well-known boundary codes via the supplementary map, and any other code
 * defaults to `fatal` — unclassified codes must never spin an automated
 * retry loop, but they remain fully reportable (never a throw).
 */
export function toRetryClass(code: string): RetryClassValue {
  if (isErrorCodeValue(code)) {
    return ERROR_CODE_RETRY_CLASS[code];
  }
  return BOUNDARY_CODE_RETRY_CLASS[code] ?? RetryClass.FATAL;
}

/** Is this class one an automated retry loop may act on? */
export function isRetryableClass(cls: RetryClassValue): boolean {
  return cls === RetryClass.BACKOFF || cls === RetryClass.RE_READ;
}

/**
 * Convenience composition for retry loops (`workflow/state-retry.ts`):
 * should an automated retry fire for this code? `backoff` and `re-read`
 * retry (the loop's closure re-reads + re-derives on each attempt);
 * `invalid-input` and `fatal` propagate immediately.
 */
export function isRetryableErrorCode(code: string): boolean {
  return isRetryableClass(toRetryClass(code));
}

// ─── Typed-error discrimination (shared by the catch-site consumers) ────────

/**
 * Structured description of a caught transient/conflict typed error,
 * consumed by the orchestrate catch sites (execute-merge,
 * merge-orchestrate, create-pr, create-issue, add-pr-comment) so the
 * class-to-code translation and retry posture live here, not per-site.
 */
export interface TransientErrorDescriptor {
  readonly code:
    | typeof TRANSIENT_ERROR_CODES.CONCURRENCY_CONFLICT
    | typeof TRANSIENT_ERROR_CODES.STORAGE_BUSY;
  readonly retryClass: RetryClassValue;
  /** Message fragment for site-level context strings (byte-stable with the pre-DR-10 prose). */
  readonly summary: 'lost OCC race' | 'hit storage contention';
  /** Canonical class guidance (`RETRY_CLASS_GUIDANCE[retryClass]`). */
  readonly guidance: string;
  /** The underlying typed error's message. */
  readonly causeMessage: string;
}

/**
 * Discriminate the two transient/conflict typed errors raised by the R-2
 * primitive layer. Returns `undefined` for anything else so catch sites
 * rethrow unrecognized errors unchanged.
 */
export function describeTransientError(
  err: unknown,
): TransientErrorDescriptor | undefined {
  if (err instanceof ConcurrencyError) {
    const retryClass = toRetryClass(TRANSIENT_ERROR_CODES.CONCURRENCY_CONFLICT);
    return {
      code: TRANSIENT_ERROR_CODES.CONCURRENCY_CONFLICT,
      retryClass,
      summary: 'lost OCC race',
      guidance: RETRY_CLASS_GUIDANCE[retryClass],
      causeMessage: err.message,
    };
  }
  if (err instanceof StorageBusyError) {
    const retryClass = toRetryClass(TRANSIENT_ERROR_CODES.STORAGE_BUSY);
    return {
      code: TRANSIENT_ERROR_CODES.STORAGE_BUSY,
      retryClass,
      summary: 'hit storage contention',
      guidance: RETRY_CLASS_GUIDANCE[retryClass],
      causeMessage: err.message,
    };
  }
  return undefined;
}
