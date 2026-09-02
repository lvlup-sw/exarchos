import type { Statement } from 'bun:sqlite';

// ─── Prepared Statements ────────────────────────────────────────────────────

export interface Statements {
  insertEvent: Statement;
  upsertSequence: Statement;
  upsertSequenceMonotonic: Statement;
  selectSequence: Statement;
  selectEvents: Statement;
  getState: Statement;
  upsertState: Statement;
  selectAllStates: Statement;
  getStateVersion: Statement;
  insertOutbox: Statement;
  selectPendingOutbox: Statement;
  updateOutboxConfirmed: Statement;
  updateOutboxFailed: Statement;
  updateOutboxDeadLetter: Statement;
  getViewCache: Statement;
  upsertViewCache: Statement;
  insertSchemaVersion: Statement;
  // AtomicAppender SQLite-backed body (#1259, T06/T07)
  selectIdempotencyClaim: Statement;
  insertIdempotencyClaim: Statement;
  insertEventStrict: Statement;
}
