/**
 * One stream whose version gate disagreed with its durable event tail.
 * `gate` is the recorded high-water mark, and `tail` is `MAX(events.sequence)`.
 */
export interface SequenceRepair {
  readonly streamId: string;
  readonly gate: number;
  readonly tail: number;
}

/**
 * Outcome of the startup reconciliation of sequence gates.
 *
 * `repaired`: gates raised to the durable tail. A trailing gate re-issues a used sequence.
 * `gaps`: gates that lead the tail. They stay unchanged to keep sequences
 * monotonic, and the report names them.
 */
export interface SequenceRepairReport {
  readonly repaired: readonly SequenceRepair[];
  readonly gaps: readonly SequenceRepair[];
}

/** Counts-not-transcripts cap on the per-stream detail carried in repair logs. */
export const SEQUENCE_REPAIR_LOG_CAP = 20;
