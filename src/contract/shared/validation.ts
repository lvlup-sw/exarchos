/**
 * Shared validation for stream IDs. Callers include the event store, the atomic appender and the
 * outbox.
 *
 * A stream ID can hold one `/`, so a subagent stream can be `<feature-id>/<subagent-id>`. Each
 * segment holds letters, digits, hyphens, dots, and underscores. The validator rejects empty
 * segments, a leading or trailing slash, more than one slash, and `.` or `..` segments. As a
 * result, the namespaced form cannot escape the on-disk JSONL layout.
 */

/**
 * Per-segment character class. Each `/`-separated half of a namespaced
 * stream id (and the entire body of a single-segment id) must match this.
 */
const SEGMENT_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * The composite pattern of `validateStreamId`: one segment, or two non-empty segments with one slash
 * between them. It is exported for error messages and schema docs. The validator rejects `.` and
 * `..` segments separately.
 */
export const SAFE_STREAM_ID_PATTERN = /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)?$/;

/**
 * Validates that a stream ID matches the safe pattern, and throws on an invalid ID. The character
 * class accepts `.` and `..`, so the function rejects them as segments. A caller that builds a
 * JSONL file path from the stream ID is then safe from path traversal.
 */
export function validateStreamId(streamId: string): void {
  if (!SAFE_STREAM_ID_PATTERN.test(streamId)) {
    throw new Error(
      `Invalid streamId "${streamId}": must match ${SAFE_STREAM_ID_PATTERN} (single segment, or two segments separated by a single slash; alphanumeric, hyphens, dots, and underscores only)`,
    );
  }

  for (const segment of streamId.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error(
        `Invalid streamId "${streamId}": segments must not be "." or ".." (path traversal)`,
      );
    }
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new Error(
        `Invalid streamId "${streamId}": segment "${segment}" must match ${SEGMENT_PATTERN}`,
      );
    }
  }
}
