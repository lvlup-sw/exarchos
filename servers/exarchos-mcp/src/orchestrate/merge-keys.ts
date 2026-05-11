// ─── #1303 α-06 — shared merge_orchestrate idempotency-key builder ─────────
//
// The three append sites in the `merge_orchestrate` orchestrator surface
// (`merge.preflight` in merge-orchestrate.ts, `merge.executed` and
// `merge.rollback` in execute-merge.ts) each need a deterministic
// idempotency key keyed on the (streamId, taskId, eventType) tuple so that
//   • a crash-replay (same caller, same task, same event) dedups via the
//     SQLite UNIQUE INDEX on idempotency_key (#1259 / #1323), and
//   • the three sites within one merge attempt do NOT collide with one
//     another (the trailing `:${eventType}` segment is what disambiguates).
//
// The shape `${streamId}:merge_orchestrate:${taskId}:${eventType}` extends
// the prefix produced by `next-actions-computer.ts:118` for the
// `merge_orchestrate` verb. Keeping the construction in one place prevents
// the three call sites from drifting (different separators, missing
// segments, etc.).
// ───────────────────────────────────────────────────────────────────────────

export function buildMergeOrchestrateIdempotencyKey(
  streamId: string,
  taskId: string,
  eventType: string,
): string {
  return `${streamId}:merge_orchestrate:${taskId}:${eventType}`;
}
