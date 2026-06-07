// Reserved stream identifiers for non-feature event streams.
//
// Centralized here so view/listing handlers can distinguish feature workflows
// from infrastructure streams without duplicating string literals across
// modules (DIM-1 — single source of truth).
//
// The owning modules (`orchestrate/init`, `orchestrate/doctor`,
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

export const INFRA_STREAM_IDS: ReadonlySet<string> = new Set([
  INIT_STREAM_ID,
  DOCTOR_STREAM_ID,
  TELEMETRY_STREAM,
  ONBOARD_STREAM_ID,
]);

export function isFeatureStream(streamId: string): boolean {
  return !INFRA_STREAM_IDS.has(streamId);
}
