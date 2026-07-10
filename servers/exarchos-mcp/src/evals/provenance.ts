/**
 * Shared eval provenance + fail-honest helper (DR-7).
 *
 * A small module every experiment writes its raw-data artifacts through, so a
 * reader can reproduce or invalidate any published number:
 *
 *   - {@link stampProvenance} pins `{ binaryTag, gitSha, modelIds, date }` onto a
 *     record. All four are REQUIRED — it throws if any is missing. `date`,
 *     `gitSha`, and `binaryTag` are supplied BY THE CALLER (no ambient clock, no
 *     `new Date()`, no reading git here) so the stamp core is a pure function and
 *     runs reproduce byte-for-byte.
 *   - {@link assertMeasured} rejects any record self-flagged `modeled` or
 *     `assumed`, admitting only `measured` results.
 *
 * ── Honest limit (read before trusting this) ────────────────────────────────
 * This is a CONVENTION BACKSTOP, not a proof of authenticity. It enforces that
 * provenance is present and rejects a record that *declares itself* modeled — but
 * it CANNOT structurally detect a pure-function result that has been mislabeled
 * as `measured`. That was the #1669 sin, and the structural defense against it
 * lives elsewhere: the experiments (Exp 1/2/3) that drive the real binary, real
 * headless Claude Code, and the real harness grader. This helper is the belt;
 * those experiments are the mechanism. Do not mistake a green `assertMeasured`
 * for evidence that a number was actually measured.
 */

/**
 * Where a metric came from — the honest-provenance discriminant every raw-data
 * record carries. Only `measured` is admissible as a published result; the other
 * two exist so a record can be honest about being a stand-in.
 */
export type MeasurementSource = 'measured' | 'modeled' | 'assumed';

/**
 * Reproducibility pin attached to every raw-data artifact. All fields are
 * caller-supplied — nothing here is read from the ambient environment — so the
 * same inputs always produce the same stamp.
 */
export interface Provenance {
  /** Exact binary version/tag the artifact was produced with (e.g. `v2.12.0-preview.2`). */
  readonly binaryTag: string;
  /** Git SHA of the measured binary. */
  readonly gitSha: string;
  /** Model IDs involved in the run (at least one). */
  readonly modelIds: readonly string[];
  /** Caller-supplied date string (e.g. ISO-8601) — NO ambient clock, so runs reproduce. */
  readonly date: string;
}

/** A raw-data record that declares where its numbers came from. */
export interface SourcedRecord {
  readonly source: MeasurementSource;
}

/** A record with a reproducibility pin attached under `provenance`. */
export type ProvenanceStamped<T> = T & { readonly provenance: Provenance };

/** Thrown when provenance is incomplete or an un-measured record is asserted measured. */
export class ProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvenanceError';
  }
}

/** The required keys of {@link Provenance}, in stamp order — the single source of truth for "what must be present". */
export const REQUIRED_PROVENANCE_KEYS = ['binaryTag', 'gitSha', 'modelIds', 'date'] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate and normalize a {@link Provenance} without touching the environment.
 * Throws a {@link ProvenanceError} naming the first offending key. Pure: returns
 * a fresh object with `modelIds` copied so the result never aliases the caller's
 * array.
 */
function validateProvenance(provenance: Provenance): Provenance {
  if (provenance === null || typeof provenance !== 'object') {
    throw new ProvenanceError('provenance must be an object with binaryTag, gitSha, modelIds, date');
  }

  if (!isNonEmptyString(provenance.binaryTag)) {
    throw new ProvenanceError('provenance.binaryTag is required (non-empty string)');
  }
  if (!isNonEmptyString(provenance.gitSha)) {
    throw new ProvenanceError('provenance.gitSha is required (non-empty string)');
  }
  if (!isNonEmptyString(provenance.date)) {
    throw new ProvenanceError('provenance.date is required (non-empty string)');
  }
  if (!Array.isArray(provenance.modelIds) || provenance.modelIds.length === 0) {
    throw new ProvenanceError('provenance.modelIds is required (non-empty array of model IDs)');
  }
  if (!provenance.modelIds.every(isNonEmptyString)) {
    throw new ProvenanceError('provenance.modelIds must contain only non-empty strings');
  }

  return {
    binaryTag: provenance.binaryTag,
    gitSha: provenance.gitSha,
    modelIds: [...provenance.modelIds],
    date: provenance.date,
  };
}

/**
 * Attach a reproducibility pin to a raw-data record. Pure and side-effect-free:
 * the same `record`/`provenance` inputs always yield the same output, and the
 * required provenance keys round-trip intact. Throws {@link ProvenanceError} if
 * any required provenance field is missing or empty.
 *
 * The record's own fields are preserved; a `provenance` field is added (or
 * overwritten). Callers pass `binaryTag`, `gitSha`, and `date` in explicitly —
 * this function never reads the clock, git, or the filesystem.
 */
export function stampProvenance<T extends object>(record: T, provenance: Provenance): ProvenanceStamped<T> {
  const validated = validateProvenance(provenance);
  return { ...record, provenance: validated };
}

/** Non-throwing predicate: is this record an admissible `measured` result? */
export function isMeasured<T extends SourcedRecord>(record: T): boolean {
  return record.source === 'measured';
}

/**
 * Fail-honest guard: throw unless `record.source === 'measured'`. Rejects any
 * record self-flagged `modeled` or `assumed` (and any other non-`measured`
 * value), so a modeled stand-in can never be published as a measured result.
 * Narrows the record to the measured variant on success.
 */
export function assertMeasured<T extends SourcedRecord>(
  record: T
): asserts record is T & { source: 'measured' } {
  if (record === null || typeof record !== 'object' || !('source' in record)) {
    throw new ProvenanceError('record must carry a `source` flag (measured | modeled | assumed)');
  }
  if (record.source !== 'measured') {
    throw new ProvenanceError(
      `refusing to admit a '${String(record.source)}' record as a measured result — ` +
        'only mechanically measured numbers may be published (DR-7)'
    );
  }
}
