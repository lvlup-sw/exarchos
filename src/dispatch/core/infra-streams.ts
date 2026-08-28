// Reserved stream identifiers for non-feature event streams.
//
// Centralized here so view/listing handlers can distinguish feature workflows
// from infrastructure streams without duplicating string literals across
// modules (DIM-1 — single source of truth).
//
// The owning modules (`verbs/init`, `verbs/doctor`,
// `telemetry/constants`) re-export from this file to preserve existing
// import paths.

export const INIT_STREAM_ID = 'exarchos-init';
export const DOCTOR_STREAM_ID = 'exarchos-doctor';
export const TELEMETRY_STREAM = 'telemetry';

// DR-2 / DR-7 (task 010) — the `onboard` verb's two-event split
// (`onboard.requested` → `onboard.executed`) lands on this dedicated
// infrastructure stream. Onboard is phase-independent and not tied to any
// feature workflow, so a reserved stream keeps the reconcile audit trail
// (and its crash-recovery precheck via `readStreamTail`) separate from
// feature streams — and from `init`/`doctor` diagnostics.
export const ONBOARD_STREAM_ID = 'exarchos-onboard';

// #1739 (cutover promotion path) — store-scoped admission governance facts:
// `admission.rollout-decision` / `admission.enforcement-enabled` (the
// `cutover_decide` verb) and `admission.cutover-ready` (the observer's
// auto-export hook). These facts describe the WHOLE store's cutover posture,
// not one feature workflow, so they land on a reserved infrastructure stream
// rather than any feature stream or `<featureId>/admission-shadow` sidecar.
export const ADMISSION_STREAM_ID = 'exarchos-admission';

// The mutating VCS handlers journal the INTENT before the remote call and the
// RESULT after it, and both records land here rather than on any feature
// stream: a pull request is a fact about the repository, and the same handler
// serves callers that carry no featureId at all. Reserving the id is what lets
// post-dispatch observation resolve the stream those records land on from the
// action's own declaration instead of failing to find it in the arguments.
export const VCS_STREAM_ID = 'vcs';

export const INFRA_STREAM_IDS: ReadonlySet<string> = new Set([
  INIT_STREAM_ID,
  DOCTOR_STREAM_ID,
  TELEMETRY_STREAM,
  ONBOARD_STREAM_ID,
  ADMISSION_STREAM_ID,
  VCS_STREAM_ID,
  // workflow/feedback.ts owns this selector; listed so observation can
  // resolve the unscoped stream the feedback contract names.
  'meta/feedback',
]);

export function isFeatureStream(streamId: string): boolean {
  return !INFRA_STREAM_IDS.has(streamId);
}
