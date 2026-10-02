export const MAX_OUTBOX_RETRIES = 5;

/**
 * `workflowType` for a summary row: the `streams` registry column, else the copy
 * in the workflow_state row, else `''`. The SELECT and the WHERE pushdown in
 * {@link SqliteBackend.listWorkflowSummaries} both use it, so the filtered and
 * projected values agree. The `''` tail matches the in-memory backend row for row.
 */
export const WORKFLOW_TYPE_EXPR = `COALESCE(s.workflow_type, json_extract(ws.state, '$.workflowType'), '')`;

/**
 * Bounded retry policy for SQLITE_BUSY on the substrate `atomicAppend` write path.
 *
 * The C-level `busy_timeout = 5000` pragma absorbs short contention silently.
 * This JS-level policy counts the cases where that 5-second window expires, so
 * the appender can report `storage_busy`. See `applyConnectionPragmas`.
 *
 * Backoff is `min(baseDelayMs * 2^(attempt-1), maxDelayMs)`. The 4 sleeps
 * between attempts total about 75 ms (5 + 10 + 20 + 40).
 */
export const SQLITE_BUSY_RETRY_POLICY = {
  maxAttempts: 5,
  baseDelayMs: 5,
  maxDelayMs: 100,
} as const;

export const DECIDE_ONCE_CLAIM_STREAM = '__decide_once_operations__';
