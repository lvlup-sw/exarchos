/**
 * Shared eval provenance and fail-honest helpers. The experiments write their raw-data artifacts
 * through this module, so a reader can reproduce or reject a published number.
 *
 * - {@link stampProvenance} attaches `{ binaryTag, gitSha, modelIds, date }` to a record. It
 *   throws when a field is missing or empty.
 * - {@link assertMeasured} rejects a record that is not flagged `measured`.
 *
 * Limit: this is a convention backstop, not a proof of authenticity. It cannot detect a
 * pure-function result with a false `measured` flag. The experiments that drive the real binary,
 * headless Claude Code, and the real harness grader are the structural defense. A green
 * `assertMeasured` is not evidence that a number was measured.
 */

/**
 * Where a metric came from. Only `measured` is admissible as a published result. The other two
 * values let a record declare that it is a stand-in.
 */
export type MeasurementSource = 'measured' | 'modeled' | 'assumed';

/**
 * The reproducibility pin on a raw-data artifact. The caller supplies every field, so the same
 * inputs give the same stamp.
 */
export interface Provenance {
  /** The binary version or tag that produced the artifact, for example `v2.12.0-preview.2`. */
  readonly binaryTag: string;
  /** Git SHA of the measured binary. */
  readonly gitSha: string;
  /** Model IDs involved in the run (at least one). */
  readonly modelIds: readonly string[];
  /** A caller-supplied date string, for example ISO-8601. No clock is read, so runs reproduce. */
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

/** The required keys of {@link Provenance}, in stamp order. */
export const REQUIRED_PROVENANCE_KEYS = ['binaryTag', 'gitSha', 'modelIds', 'date'] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates a {@link Provenance} and returns a fresh copy. The copy of `modelIds` does not alias
 * the caller's array.
 *
 * @throws ProvenanceError that names the first invalid key.
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
 * Attaches a reproducibility pin to a raw-data record as a pure function. It keeps the fields of
 * the record and adds or replaces its `provenance` field.
 *
 * @throws ProvenanceError when a required provenance field is missing or empty.
 */
export function stampProvenance<T extends object>(record: T, provenance: Provenance): ProvenanceStamped<T> {
  const validated = validateProvenance(provenance);
  return { ...record, provenance: validated };
}

/** Returns true when the record is an admissible `measured` result. */
export function isMeasured<T extends SourcedRecord>(record: T): boolean {
  return record.source === 'measured';
}

/**
 * Fail-honest guard: throws unless `record.source === 'measured'`, so a modeled stand-in cannot
 * pass as a measured result. On success, it narrows the record to the measured variant.
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
