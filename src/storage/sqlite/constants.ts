// ─── SqliteBackend ──────────────────────────────────────────────────────────

export const MAX_OUTBOX_RETRIES = 5;

/**
 * `workflowType` for a summary row: the registry's column when the `streams`
 * row exists, else the workflow_state row's own copy, else `''`. Used by BOTH
 * the SELECT projection and the WHERE pushdown in
 * {@link SqliteBackend.listWorkflowSummaries} so the filtered and projected
 * values can never disagree. The `''` tail mirrors the in-memory backend's
 * `typeof state.workflowType === 'string' ? state.workflowType : ''`, keeping
 * the two backends row-for-row equivalent (INV-2).
 */
export const WORKFLOW_TYPE_EXPR = `COALESCE(s.workflow_type, json_extract(ws.state, '$.workflowType'), '')`;

/**
 * Bounded retry policy for SQLITE_BUSY surfaced by the substrate
 * `atomicAppend` write path (#1259, T09, DR-12, refined by audit §F2.2).
 *
 * Two-tier BUSY recovery — see `applyConnectionPragmas` for the full
 * model. The C-level `busy_timeout = 5000` pragma is the silent
 * absorption tier; this constant configures the JS-level observability
 * tier. The two layers are NOT redundant: the C layer catches
 * microsecond-scale contention without surfacing errors; the JS layer
 * counts the cases where the C-layer's 5-second window expires, making
 * the retry observable to the appender for structured failure
 * reporting (`storage_busy`).
 *
 * Originally DR-12 set busy_timeout=0 and made this layer the sole
 * BUSY handler. The audit (§F2.2) flagged that approach as exposing
 * every microsecond-level contention as a JS-layer retry, exhausting
 * the budget on noise. The C layer is now the absorption tier; this
 * layer is the escalation tier.
 *
 * Backoff: `min(baseDelayMs * 2^(attempt-1), maxDelayMs)`. With
 * `baseDelayMs=5, maxDelayMs=100`, the budget across 4 inter-attempt
 * sleeps tops out near 5+10+20+40 = 75 ms — well below the per-call
 * latency budgets of upstream consumers (event_batch_append SLO).
 */
export const SQLITE_BUSY_RETRY_POLICY = {
  maxAttempts: 5,
  baseDelayMs: 5,
  maxDelayMs: 100,
} as const;

export const DECIDE_ONCE_CLAIM_STREAM = '__decide_once_operations__';

/**
 * Thrown by `atomicAppend` when SQLITE_BUSY persists past the retry
 * budget. Carries the most-recent driver error as `cause` so the
 * caller (AtomicAppender) can surface a structured `storage_busy`
 * reason without re-inspecting the SQLite error code itself.
 *
 * Distinct error class (rather than re-using SqliteError) because the
 * boundary contract is: SqliteBackend throws either a generic
 * SqliteError (caller treats as io-error) or this typed exhausted
 * marker (caller maps to storage_busy). Keeping the distinction in
 * the type system means the translation is unambiguous.
 */
