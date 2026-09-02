/**
 * Projection snapshot store — backend-delegated reader + writer (DR-2, §5.2).
 *
 * Snapshots are persisted to the active {@link StorageBackend}'s
 * `projection_snapshots` table (SQLite in production, in-memory for tests).
 * The legacy `<stateDir>/<streamId>.projections.jsonl` sidecar substrate was
 * removed in #1343 (Wave A); the backend's `(stream_id, projection_id,
 * projection_version, sequence)` PRIMARY KEY now provides the same per-stream
 * ordering and size-cap pruning that the JSONL sidecar provided previously.
 *
 * Read semantics ({@link readLatestSnapshot}): delegates to
 * `backend.readLatestProjectionSnapshot`, which returns the highest-sequence
 * row matching `(streamId, projectionId, projectionVersion)`, or `undefined`.
 *
 * Write semantics ({@link appendSnapshot}): delegates to
 * `backend.appendProjectionSnapshot`. Cap enforcement (oldest-row eviction
 * to retain exactly `maxRecords`) lives in the backend implementation; the
 * WARN-on-prune log emission stays at this wrapper boundary so consumers see
 * a stable structured-log surface regardless of substrate.
 *
 * Concurrency: serialization is the substrate's responsibility (SQLite WAL +
 * `BEGIN IMMEDIATE`); this layer is a thin wrapper.
 */

import { storeLogger } from '../logger.js';
import { SnapshotRecord } from './snapshot-schema.js';
import type { StorageBackend } from '../storage/backend.js';
import {
  DEFAULT_SNAPSHOT_MAX_RECORDS,
  resolveMaxRecords,
} from '../storage/snapshot-retention.js';

// Re-export retention config so existing consumers of `projections/store`
// continue to resolve these symbols. The canonical home is now
// `storage/snapshot-retention.ts` (see #1346 / CodeRabbit layering fix);
// storage backends import from there directly, and `projections/store`
// re-exports for backward compatibility.
export {
  DEFAULT_SNAPSHOT_MAX_RECORDS,
  resolveMaxRecords,
};

/**
 * Reject stream identifiers that could traverse out of the substrate's
 * coordinate space. Pre-Wave-A this guard prevented JSONL filename
 * traversal; post-substrate-cut it still applies because the streamId
 * is a primary-key column on `projection_snapshots` and must be a
 * stable, opaque token (no path separators, no embedded NULs, no
 * relative-path escape sequences).
 *
 * Workflow streams use feature ids that are already constrained upstream
 * (slugified `feature/<id>` form), but this helper enforces the invariant
 * locally so a future caller can't trip it inadvertently.
 */
function assertStreamIdSafe(streamId: string): void {
  if (
    streamId.length === 0 ||
    streamId.includes('..') ||
    streamId.includes('/') ||
    streamId.includes('\\') ||
    streamId.includes('\0')
  ) {
    throw new Error(
      `Invalid streamId for projection snapshot: ${JSON.stringify(streamId)}`,
    );
  }
}

/** Optional per-call overrides for {@link appendSnapshot}. */
export interface AppendSnapshotOptions {
  /**
   * Maximum retained records after append. When the post-append count for
   * this `(streamId, projectionId, projectionVersion)` coordinate would
   * exceed this value, the backend evicts the oldest rows in one
   * transaction so the coordinate retains exactly `maxRecords` rows, and
   * one WARN is emitted via the structured logger with the count pruned.
   * Defaults to the value from {@link resolveMaxRecords} (i.e., the
   * `SNAPSHOT_MAX_RECORDS` env var or {@link DEFAULT_SNAPSHOT_MAX_RECORDS}).
   */
  maxRecords?: number;
}

/**
 * Read the highest-sequence snapshot for `(streamId, projectionId,
 * projectionVersion)` from the backend, or `undefined` when no row matches.
 *
 * Defensive parse: if the backend's row payload fails {@link SnapshotRecord}
 * schema validation, returns `undefined` rather than throwing — the caller
 * treats schema-invalid snapshots the same as a missing snapshot and
 * proceeds to a cold rebuild from the event log.
 */
export function readLatestSnapshot(
  backend: StorageBackend,
  streamId: string,
  projectionId: string,
  projectionVersion: string,
): SnapshotRecord | undefined {
  assertStreamIdSafe(streamId);
  const raw = backend.readLatestProjectionSnapshot(
    streamId,
    projectionId,
    projectionVersion,
  );
  if (raw === undefined) return undefined;
  const result = SnapshotRecord.safeParse(raw);
  return result.success ? result.data : undefined;
}

/**
 * Append a {@link SnapshotRecord} for the given stream via the backend.
 *
 * Enforces a per-coordinate size cap (DR-18 resilience): once the row count
 * for `(streamId, record.projectionId, record.projectionVersion)` would
 * exceed `options.maxRecords`, the backend deletes the oldest rows in one
 * transaction so the coordinate retains exactly `maxRecords` rows. The
 * cap defaults to the value resolved by {@link resolveMaxRecords} at call
 * time.
 *
 * Emits one WARN per prune event via {@link storeLogger} (forwarded from
 * the backend's atomic count). The wrapper queries the backend's row
 * count for the coordinate before and after the append to compute the
 * prune count exactly.
 */
export function appendSnapshot(
  backend: StorageBackend,
  streamId: string,
  record: SnapshotRecord,
  options: AppendSnapshotOptions = {},
): void {
  assertStreamIdSafe(streamId);

  const maxRecords =
    options.maxRecords !== undefined &&
    Number.isInteger(options.maxRecords) &&
    options.maxRecords > 0
      ? options.maxRecords
      : resolveMaxRecords();

  backend.appendProjectionSnapshot(streamId, record, {
    maxRecords,
    onPrune: (prunedCount) => {
      storeLogger.warn(
        {
          streamId,
          prunedCount,
          maxRecords,
        },
        'Snapshot store exceeded size cap — pruned oldest records',
      );
    },
  });
}
