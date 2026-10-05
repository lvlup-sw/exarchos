// RESERVED(issue: #1590, owner: exarchos, expires: 2027-01-31) — production
// code that waits for the legacy HSM cutover. Bootstrap is useful only after
// admission is the authoritative decider. Before that, nothing reads the
// attempt state that it appends.
//
// A workflow older than the admission system has no
// `admission.requirement-resolved` facts, so the fold builds no frozen
// requirement set for its attempt. This module gives the attempt a frozen set
// only by appending events. It never rewrites a past event or a `.state.json`.
// Thus a replay of any prefix before the bootstrap gives the same result.

import type { EventInput } from '../../events/atomic-appender.js';
import { resolveRequirements } from './requirement-resolution.js';
import type { RequirementContext } from './requirement-context.js';
import { freezeRequirements } from './freeze-requirements.js';
import type { FrozenRequirementSetProjection } from './freeze-requirements.js';
import type { AdmissionDecider } from './transition-command.js';
import { selectPhaseAttempt } from './phase-attempt-state.js';
import type { PhaseAttemptAdmissionFold } from './phase-attempt-state.js';
import {
  buildRequirementResolvedEvents,
  foldAdmissionStream,
  type GenerationProvenance,
} from './bootstrap-generation.js';
import {
  ADMISSION_EVENT_TYPES,
  type AdmissionRequirementV1,
  type ApprovalClass,
  type AttributedPrincipalV1,
  type AuthorizationSnapshotV1,
  type ContentDigestV1,
  type EvidenceSubjectV1,
  type OperationId,
  type PhaseAttemptId,
  type PolicyId,
} from './types.js';

export interface BootstrapAttemptInput {
  readonly appender: AdmissionDecider;
  readonly streamId: string;
  readonly operationId: OperationId;
  /** The stream version the caller observed before issuing this command (OCC). */
  readonly expectedVersion: number;
  readonly phaseAttemptId: PhaseAttemptId;
  readonly subject: EvidenceSubjectV1;
  /** Normalized resolution context. The command resolves and freezes it. */
  readonly requirementContext: RequirementContext;
  readonly approvalClass?: ApprovalClass;
  readonly policyId: PolicyId;
  /** The explicit policy version the bootstrapped generation is frozen under. */
  readonly policyVersion: string;
  readonly policyDigest: ContentDigestV1;
  /** Trusted RFC3339 resolution instant — never `Date.now()`. */
  readonly resolvedAt: string;
  readonly caller: AttributedPrincipalV1;
  readonly authorization: AuthorizationSnapshotV1;
}

/** A pre-existing attempt that gained a frozen requirement set by appended events. */
export interface AttemptBootstrapped {
  readonly outcome: 'bootstrapped';
  readonly phaseAttemptId: PhaseAttemptId;
  readonly requirementSetDigest: ContentDigestV1;
  readonly frozenRequirements: readonly AdmissionRequirementV1[];
  /** The append-only event types committed in the single atomic decision. */
  readonly appendedEventTypes: readonly string[];
  readonly foldIntegrity: PhaseAttemptAdmissionFold['integrity'];
}

/** An attempt already carrying a frozen requirement set — bootstrap is a no-op. */
export interface AttemptAlreadyBootstrapped {
  readonly outcome: 'already-bootstrapped';
  readonly phaseAttemptId: PhaseAttemptId;
  readonly requirementSetDigest: ContentDigestV1;
}

export type BootstrapAttemptResult =
  | AttemptBootstrapped
  | AttemptAlreadyBootstrapped;

/**
 * Aborts the `decideOnce` transaction when the attempt already has a frozen
 * requirement set. `decideOnce` needs at least one event, so the closure throws
 * this signal to append nothing. The command maps it to `already-bootstrapped`.
 */
class AttemptAlreadyBootstrappedSignal extends Error {
  constructor(readonly requirementSetDigest: ContentDigestV1) {
    super('phase attempt already carries a frozen requirement set');
    this.name = 'AttemptAlreadyBootstrappedSignal';
  }
}

/**
 * Bootstrap a pre-existing phase attempt with a frozen requirement set, only by
 * appending `admission.requirement-resolved` facts.
 *
 * The pure pipeline resolves and freezes the set before the transaction. The
 * append runs in one `decideOnce` keyed on `operationId`, so a retry with the
 * same key returns the recorded result. If the attempt already has a frozen set,
 * the command appends nothing and returns `already-bootstrapped`.
 */
export async function runBootstrapAttempt(
  input: BootstrapAttemptInput,
): Promise<BootstrapAttemptResult> {
  const resolved = resolveRequirements(input.requirementContext);
  const frozen: FrozenRequirementSetProjection = freezeRequirements({
    resolved,
    phaseAttemptId: input.phaseAttemptId,
    subject: input.subject,
    ...(input.approvalClass !== undefined
      ? { approvalClass: input.approvalClass }
      : {}),
  });

  const provenance: GenerationProvenance = {
    operationId: input.operationId,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    policyDigest: input.policyDigest,
    resolvedAt: input.resolvedAt,
  };
  const events: readonly EventInput[] = buildRequirementResolvedEvents(
    frozen,
    input.phaseAttemptId,
    input.subject,
    provenance,
  );

  try {
    return await input.appender.decideOnce<AttemptBootstrapped>(
      input.operationId,
      requestDigest(input, frozen.requirementSetDigest),
      (ctx) => {
        const snapshot = ctx.readStream(input.streamId);
        const fold = foldAdmissionStream(snapshot.events);
        const existing = selectPhaseAttempt(fold, input.phaseAttemptId);
        if (existing?.frozenRequirementSet != null) {
          throw new AttemptAlreadyBootstrappedSignal(
            existing.frozenRequirementSet.requirementSetDigest,
          );
        }
        return {
          streamId: input.streamId,
          expectedSequence: input.expectedVersion,
          events: [...events],
          result: {
            outcome: 'bootstrapped',
            phaseAttemptId: input.phaseAttemptId,
            requirementSetDigest: frozen.requirementSetDigest,
            frozenRequirements: frozen.requirements,
            appendedEventTypes: events.map((event) => event.type),
            foldIntegrity: fold.integrity,
          },
        };
      },
    );
  } catch (error) {
    if (error instanceof AttemptAlreadyBootstrappedSignal) {
      return {
        outcome: 'already-bootstrapped',
        phaseAttemptId: input.phaseAttemptId,
        requirementSetDigest: error.requirementSetDigest,
      };
    }
    throw error;
  }
}

function requestDigest(
  input: BootstrapAttemptInput,
  requirementSetDigest: ContentDigestV1,
): string {
  return `sha256:${requirementSetDigest.value}:${input.streamId}:${String(
    input.phaseAttemptId,
  )}:${String(input.operationId)}:${input.expectedVersion}:${ADMISSION_EVENT_TYPES.REQUIREMENT_RESOLVED}`;
}
