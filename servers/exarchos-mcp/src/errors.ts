// ─── Centralized Error Taxonomy ─────────────────────────────────────────────
//
// Re-exports from original locations (additive, no breaking changes).
// Adds structured error metadata: categories, recovery strategies, retryability.

// Re-export from original locations
export { ErrorCode } from './workflow/schemas.js';
export { SequenceConflictError, PidLockError } from './event-store/store.js';
export { StateStoreError, VersionConflictError } from './workflow/state-store.js';

// ─── Error Categories ───────────────────────────────────────────────────────

export type ErrorCategory = 'state-lifecycle' | 'state-mutation' | 'workflow-logic' | 'compensation' | 'io';

const categoryMap: Record<string, ErrorCategory> = {
  STATE_NOT_FOUND: 'state-lifecycle',
  STATE_ALREADY_EXISTS: 'state-lifecycle',
  STATE_CORRUPT: 'state-lifecycle',
  MIGRATION_FAILED: 'state-lifecycle',
  INVALID_INPUT: 'state-mutation',
  RESERVED_FIELD: 'state-mutation',
  VERSION_CONFLICT: 'state-mutation',
  INVALID_TRANSITION: 'workflow-logic',
  GUARD_FAILED: 'workflow-logic',
  CIRCUIT_OPEN: 'workflow-logic',
  ALREADY_CANCELLED: 'compensation',
  ALREADY_COMPLETED: 'compensation',
  COMPENSATION_PARTIAL: 'compensation',
  FILE_IO_ERROR: 'io',
  EVENT_APPEND_FAILED: 'io',
};

// ─── Recovery Strategies ────────────────────────────────────────────────────

const recoveryMap: Record<string, string> = {
  STATE_NOT_FOUND: 'Initialize a new workflow with exarchos_workflow action: "init"',
  STATE_ALREADY_EXISTS: 'Use action: "get" to retrieve existing state, or choose a different featureId',
  STATE_CORRUPT: 'Delete the corrupted state file and re-initialize the workflow',
  MIGRATION_FAILED: 'Check state file version and ensure migration path exists',
  INVALID_TRANSITION: 'Check current phase and valid transitions for this workflow type',
  GUARD_FAILED: 'Satisfy the guard condition before attempting this transition',
  CIRCUIT_OPEN: 'Wait for circuit breaker timeout, then retry',
  INVALID_INPUT: 'Check input against the expected schema and fix validation errors',
  RESERVED_FIELD: 'Use a different field name — this field is managed by the system',
  ALREADY_CANCELLED: 'Workflow is already cancelled — start a new workflow if needed',
  ALREADY_COMPLETED: 'Workflow is already completed — start a new workflow if needed',
  COMPENSATION_PARTIAL: 'Some rollback steps failed — check logs and manually verify state',
  FILE_IO_ERROR: 'Check file permissions and disk space, then retry',
  EVENT_APPEND_FAILED: 'Check event store integrity and retry the operation',
  VERSION_CONFLICT: 'Re-read current state and retry the operation with updated version',
};

// ─── Retryable Codes ────────────────────────────────────────────────────────

const retryableCodes = new Set(['VERSION_CONFLICT', 'EVENT_APPEND_FAILED', 'FILE_IO_ERROR', 'CIRCUIT_OPEN']);

// ─── Public API ─────────────────────────────────────────────────────────────

export function getErrorCategory(code: string): ErrorCategory | 'unknown' {
  return categoryMap[code] ?? 'unknown';
}

export function getRecoveryStrategy(code: string): string {
  return recoveryMap[code] ?? 'Check the error details and retry the operation';
}

export function isRetryable(code: string): boolean {
  return retryableCodes.has(code);
}
