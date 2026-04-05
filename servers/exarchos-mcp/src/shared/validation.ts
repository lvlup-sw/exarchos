// ─── Stream ID Validation ────────────────────────────────────────────────────
//
// Shared validation for stream IDs used across EventStore, Outbox, and SyncState.
// Superset pattern that accepts lowercase/uppercase alphanumeric, hyphens, dots,
// and underscores — covering all previously divergent patterns.
// ─────────────────────────────────────────────────────────────────────────────

/** Pattern for safe stream IDs: alphanumeric, hyphens, dots, and underscores. */
export const SAFE_STREAM_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** Validates that a stream ID matches the safe pattern. Throws on invalid IDs. */
export function validateStreamId(streamId: string): void {
  if (!SAFE_STREAM_ID_PATTERN.test(streamId)) {
    throw new Error(
      `Invalid streamId "${streamId}": must match ${SAFE_STREAM_ID_PATTERN} (alphanumeric, hyphens, dots, and underscores only)`,
    );
  }
}
