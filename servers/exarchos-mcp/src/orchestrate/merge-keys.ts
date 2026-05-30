// ─── #1303 α-06 — shared merge_orchestrate idempotency-key builder ─────────
//
// The four append sites in the `merge_orchestrate` orchestrator surface
// (`merge.preflight` in merge-orchestrate.ts; `merge.executed`,
// `merge.completed`, and `merge.rollback` in execute-merge.ts) each need a
// deterministic idempotency key keyed on the (streamId, taskId, eventType)
// tuple — or (streamId, eventType) when no taskId is in scope — so that
//   • a crash-replay (same caller, same op, same event) dedups via the
//     SQLite UNIQUE INDEX on idempotency_key (#1259 / #1323),
//   • the sites within one merge attempt do NOT collide with one another
//     (the trailing `:${eventType}` segment is what disambiguates), and
//   • concurrent invocations of `handleExecuteMerge` for the same feature
//     stream — even without a `taskId` (e.g., CLI direct-invocation paths)
//     — collide on the SAME idempotency_claims row and dedup at the
//     substrate layer, rather than racing to append and one side surfacing
//     a false `STATE_CONFLICT` from the SequenceConflict catch.
//
// The shape `${streamId}:merge_orchestrate:${taskId}:${eventType}` (or
// `${streamId}:merge_orchestrate:${eventType}` when taskId is absent)
// extends the prefix produced by `next-actions-computer.ts:118` for the
// `merge_orchestrate` verb. Keeping the construction in one place prevents
// the call sites from drifting (different separators, missing segments,
// inconsistent taskId-fallback behavior).
// ───────────────────────────────────────────────────────────────────────────

export function buildMergeOrchestrateIdempotencyKey(
  streamId: string,
  taskId: string | undefined,
  eventType: string,
): string {
  return taskId !== undefined
    ? `${streamId}:merge_orchestrate:${taskId}:${eventType}`
    : `${streamId}:merge_orchestrate:${eventType}`;
}
