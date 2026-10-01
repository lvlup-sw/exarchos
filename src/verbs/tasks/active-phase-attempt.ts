/**
 * Resolves the active phase-attempt id for both durable-evidence adapters.
 * Only workflow init and phase transition mint the stamp, so an older workflow projects no `phaseAttemptId`.
 * Both adapters call this one resolver, so they cannot resolve the same identity in two ways.
 */

import { allocatePhaseAttemptId } from '../../workflow/phase-attempt-id.js';

/**
 * Returns the stamped phase-attempt id, or derives a legacy id when the projection has no stamp.
 * The legacy id uses the `legacy-version:<version>` predecessor over `state._version`, with a default of 1.
 * The current phase is both `from` and `to`. A real transition mints only when the phase changes, so a derived id cannot collide with a real attempt.
 * The same feature and version always give the same id.
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
