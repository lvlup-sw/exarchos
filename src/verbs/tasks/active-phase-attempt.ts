// ─── Active phase-attempt resolution (shared by both evidence adapters) ──────
//
// The phase-attempt stamp is minted only at workflow init and phase transition,
// so every workflow already in flight BEFORE the v2.12 stamp shipped projects no
// `phaseAttemptId` at all. Both durable-evidence adapters need one, and they
// answered that differently: `durable-gate-producer` derived a legacy attempt
// while `gate-runner`'s phase-gate adapter returned EVIDENCE_SCOPE_UNAVAILABLE —
// which wedged pre-v2.12 workflows out of four migrated phase gates, including
// the BLOCKING `prepare_synthesis`, i.e. out of the synthesize phase entirely.
//
// Two adapters resolving the same identity two ways is the divergence itself, so
// the resolution lives here once and both call it.
// ─────────────────────────────────────────────────────────────────────────────

import { allocatePhaseAttemptId } from '../../workflow/phase-attempt-id.js';

/**
 * The active phase-attempt id for a resolved workflow state, backfilling the
 * pre-v2.12 form when the projection carries no stamp.
 *
 * The backfill is the `legacy-version:<version>` predecessor over the
 * projection's CAS version (`state._version ?? 1`, mirroring workflow/cancel.ts
 * and cleanup.ts). No transition edge exists at gate time, so the current phase
 * stands in for both `from` and `to`; a (phase, phase) edge is never minted by a
 * real transition (`fromPhase !== input.phase` guards the mint), so a derived id
 * cannot collide with a genuine attempt. It is also DETERMINISTIC for the same
 * (featureId, version): re-running a gate on the same legacy state binds its
 * evidence to the same attempt.
 */
export function resolveActivePhaseAttemptId(
  featureId: string,
  state: Record<string, unknown>,
): string {
  const stamped = state.phaseAttemptId;
  if (typeof stamped === 'string' && stamped.length > 0) return stamped;

  const phase =
    typeof state.phase === 'string' && state.phase.length > 0 ? state.phase : 'unknown';
  const legacyVersion = typeof state._version === 'number' ? state._version : 1;
  return allocatePhaseAttemptId(featureId, phase, phase, undefined, legacyVersion);
}
