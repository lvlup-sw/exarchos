import type { Statement } from 'bun:sqlite';

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
  /** This statement and the two statements below serve the SQLite-backed body of `AtomicAppender`. */
  selectIdempotencyClaim: Statement;
  insertIdempotencyClaim: Statement;
  insertEventStrict: Statement;
}
