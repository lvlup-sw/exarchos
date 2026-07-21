import { createHash, randomUUID } from 'node:crypto';

import {
  PhaseAttemptIdSchema,
  type PhaseAttemptId,
} from './admission/types.js';

/** Allocate the opaque identity persisted with a workflow's initial entry. */
export function allocateInitialPhaseAttemptId(): PhaseAttemptId {
  return PhaseAttemptIdSchema.parse(randomUUID());
}

/**
 * Allocate a retry-stable identity for one phase-entry decision.
 *
 * The persisted active attempt is the predecessor in the attempt chain.
 * Concurrent callers deciding the same edge converge on one ID, while every
 * legal re-entry has a different predecessor. The legacy version fallback is
 * used only for pre-v2.12 states that do not yet carry an active attempt.
 */
export function allocatePhaseAttemptId(
  featureId: string,
  from: string,
  to: string,
  predecessorPhaseAttemptId: unknown,
  legacyVersion: number,
): PhaseAttemptId {
  const predecessor =
    typeof predecessorPhaseAttemptId === 'string'
      ? `attempt:${predecessorPhaseAttemptId}`
      : `legacy-version:${legacyVersion}`;
  const digest = createHash('sha256')
    .update(`${featureId}\0${predecessor}\0${from}\0${to}`)
    .digest('hex');
  return PhaseAttemptIdSchema.parse(`phase-attempt:${digest}`);
}
