// ─── Stream ID Validation ────────────────────────────────────────────────────
//
// Shared validation for stream IDs used across EventStore, Outbox, and SyncState.
//
// DR-3 (cross-stream propagation, design 2026-05-08-durable-event-store-substrate)
// admits a single optional `/` separator so subagent streams can be addressed
// as `<feature-id>/<subagent-id>`. Each segment uses the legacy character class
// (alphanumeric + hyphens + dots + underscores). Pathological inputs — empty
// segments, leading/trailing slashes, more than one slash, and `.` / `..`
// path-traversal segments — are rejected explicitly so the namespaced form
// can't be abused to escape the on-disk JSONL layout.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-segment character class. Each `/`-separated half of a namespaced
 * stream id (and the entire body of a single-segment id) must match this.
 */
const SEGMENT_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Composite pattern accepted by `validateStreamId`. Retained as a public
 * export so callers can reflect on the canonical accepted shape (for error
 * messages, schema docs, etc.). Single segment OR exactly one slash with a
 * non-empty segment on each side; explicit `.`/`..` rejection happens in
 * the validator below.
 */
export const SAFE_STREAM_ID_PATTERN = /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)?$/;

/** Validates that a stream ID matches the safe pattern. Throws on invalid IDs. */
export function validateStreamId(streamId: string): void {
  if (!SAFE_STREAM_ID_PATTERN.test(streamId)) {
    throw new Error(
      `Invalid streamId "${streamId}": must match ${SAFE_STREAM_ID_PATTERN} (single segment, or two segments separated by a single slash; alphanumeric, hyphens, dots, and underscores only)`,
    );
  }

  // Reject `.` / `..` segments outright. The character class above admits
  // them (dots are legal); rejecting them here keeps the namespaced form
  // safe against on-disk path traversal in callers that derive a JSONL
  // file path from the stream id (e.g. `<stateDir>/<streamId>.events.jsonl`).
  for (const segment of streamId.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error(
        `Invalid streamId "${streamId}": segments must not be "." or ".." (path traversal)`,
      );
    }
    // Defensive: every segment must independently match the segment regex.
    // The composite SAFE_STREAM_ID_PATTERN already enforces this, but
    // re-checking keeps the per-segment invariant local to the loop.
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new Error(
        `Invalid streamId "${streamId}": segment "${segment}" must match ${SEGMENT_PATTERN}`,
      );
    }
  }
}
