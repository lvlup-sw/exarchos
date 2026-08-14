/**
 * One stream whose version gate disagreed with its durable event tail.
 * `gate` is the recorded high-water mark; `tail` is `MAX(events.sequence)`.
 */
export interface SequenceRepair {
  readonly streamId: string;
  readonly gate: number;
  readonly tail: number;
}

/**
 * Outcome of the EFF-001 startup reconciliation.
 *
 * `repaired` — gates raised to the durable tail (they trailed it, so the next
 * allocation would have re-issued a used sequence).
 * `gaps` — gates that LEAD the tail; left untouched to keep sequences
 * monotonic, reported so the divergence is never silent.
 */
export interface SequenceRepairReport {
  readonly repaired: readonly SequenceRepair[];
  readonly gaps: readonly SequenceRepair[];
}

/** Counts-not-transcripts cap on the per-stream detail carried in repair logs. */
export const SEQUENCE_REPAIR_LOG_CAP = 20;
