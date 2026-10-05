/**
 * The projection snapshot store. It reads and writes snapshots in the `projection_snapshots` table of
 * the active {@link StorageBackend}. The primary key `(stream_id, projection_id, projection_version,
 * sequence)` orders the snapshots of each stream.
 *
 * The backend serializes writes and enforces the size cap. This wrapper logs one warning for each prune.
 * It also re-exports the retention settings from `storage/snapshot-retention.ts` for its consumers.
 */

import { storeLogger } from '../logger.js';
import { SnapshotRecord } from './snapshot-schema.js';
import type { StorageBackend } from '../storage/backend.js';
import {
  DEFAULT_SNAPSHOT_MAX_RECORDS,
  resolveMaxRecords,
} from '../storage/snapshot-retention.js';

export {
  DEFAULT_SNAPSHOT_MAX_RECORDS,
  resolveMaxRecords,
};

/**
 * Throws for a stream id that is empty or holds `..`, a slash, a backslash, or a NUL character.
 * The id is a primary-key column, so it must be an opaque token. Each read and append runs this check.
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
   * The maximum count of rows kept for the `(streamId, projectionId, projectionVersion)` coordinate.
   * A value that is not a positive integer gives way to {@link resolveMaxRecords}, which reads
   * `SNAPSHOT_MAX_RECORDS` or falls back to {@link DEFAULT_SNAPSHOT_MAX_RECORDS}.
   */
  maxRecords?: number;
}

/**
 * Returns the highest-sequence snapshot for `(streamId, projectionId, projectionVersion)`, or `undefined`.
 * A row that fails {@link SnapshotRecord} validation also gives `undefined` and does not throw.
 * Thus the caller treats it as a missing snapshot.
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
 * Appends a {@link SnapshotRecord} through the backend. When the coordinate holds more than
 * `maxRecords` rows, the backend deletes the oldest rows in one transaction and reports the count.
 * This function then logs one warning through {@link storeLogger}.
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
