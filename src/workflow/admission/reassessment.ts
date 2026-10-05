// Reassesses the obligations of a phase attempt under a newer, explicit policy version. History does not change.
// RESERVED(issue: #1590, owner: exarchos, expires: 2027-01-31): this module waits for the legacy HSM cutover.
//
// When the frozen set changes, a new generation with its own digest becomes active.
// The prior generation stays in `requirementSetHistory`.
//
// A new set that is at least as strong (`atLeastAsStrong`) is free.
// A weaker or incomparable set needs an authorized waiver for each dropped requirement.
// Without that waiver, the reassessment fails closed and appends nothing.
// The prior obligations must match the persisted active digest, so a caller cannot fabricate a strong prior.
// The strength and waiver decisions are pure. One `decideOnce` transaction, keyed on `operationId`, then appends the events.

import type { EventInput } from '../../events/atomic-appender.js';
import { freezeRequirements } from './freeze-requirements.js';
import type { FrozenRequirementSetProjection } from './freeze-requirements.js';
import { atLeastAsStrong } from './requirement-strength.js';
import type { ResolvedRequirements } from './requirement-strength.js';
import { selectApplicableWaiver } from './waiver.js';
import type { PolicyAuthority } from './policy-authority.js';
import type { AdmissionDecider } from './transition-command.js';
import { selectPhaseAttempt } from './phase-attempt-state.js';
import type { PhaseAttemptAdmissionFold } from './phase-attempt-state.js';
import {
  buildRequirementResolvedEvents,
  digestKey,
  foldAdmissionStream,
  generationInputDigest,
  type GenerationProvenance,
} from './bootstrap-generation.js';
import { AdmissionReassessmentRequestedData } from '../../events/schemas.js';
import { createHash } from 'node:crypto';
import {
  ADMISSION_EVENT_TYPES,
  type AdmissionRequirementV1,
  type ApprovalClass,
  type AttributedPrincipalV1,
  type AuthorizationSnapshotV1,
  type ContentDigestV1,
  type DecisionId,
  type EvidenceId,
  type EvidenceSubjectV1,
  type OperationId,
  type PhaseAttemptId,
  type PolicyId,
  type RequirementId,
  type WaiverId,
  type WaiverProvenanceV1,
} from './types.js';

export interface ReassessmentInput {
  readonly appender: AdmissionDecider;
  readonly streamId: string;
  readonly operationId: OperationId;
  /** The stream version the caller observed before issuing this command (OCC). */
  readonly expectedVersion: number;
  readonly phaseAttemptId: PhaseAttemptId;
  readonly subject: EvidenceSubjectV1;
  /** The prior admission decision this reassessment reconsiders (provenance). */
  readonly priorDecisionId: DecisionId;
  /** The obligations of the original freeze. A mismatch with the persisted active `requirementSetDigest` fails closed. */
  readonly priorObligations: ResolvedRequirements;
  /** The obligations resolved under the NEW policy version. */
  readonly newObligations: ResolvedRequirements;
  readonly approvalClass?: ApprovalClass;
  readonly policyId: PolicyId;
  /** The EXPLICIT policy version the reassessment evaluates under. */
  readonly policyVersion: string;
  readonly policyDigest: ContentDigestV1;
  /** Waiver lifecycle facts available to authorize a weakening. */
  readonly waivers?: readonly WaiverProvenanceV1[];
  /** The out-of-band trust oracle. A self-asserted role cannot authorize. */
  readonly authority: PolicyAuthority;
  /** Trusted RFC3339 evaluation instant — never `Date.now()`. */
  readonly evaluatedAt: string;
  /** Evidence ids carried on the reassessment record (provenance). Optional. */
  readonly evidenceIds?: readonly EvidenceId[];
  readonly caller: AttributedPrincipalV1;
  readonly authorization: AuthorizationSnapshotV1;
}

/** A reassessment that adopted a new frozen generation (or confirmed no drift). */
export interface ReassessmentApplied {
  readonly outcome: 'reassessed';
  readonly reassessmentId: string;
  /** True iff the new frozen set differs from the prior one. */
  readonly drift: boolean;
  /** True iff the new obligations are NOT at least as strong as the prior. */
  readonly weakened: boolean;
  readonly priorRequirementSetDigest: ContentDigestV1;
  readonly newRequirementSetDigest: ContentDigestV1;
  /** Prior requirement ids dropped/weakened away by the new set. */
  readonly weakenedRequirementIds: readonly RequirementId[];
  /** Waivers that authorized the weakening (empty unless `weakened`). */
  readonly appliedWaiverIds: readonly WaiverId[];
  readonly appendedEventTypes: readonly string[];
  readonly foldIntegrity: PhaseAttemptAdmissionFold['integrity'];
}

/**
 * Why a reassessment failed closed.
 * - `attempt-not-found`: the stream has no such phase attempt.
 * - `no-frozen-set`: the attempt has no frozen requirement set.
 * - `prior-obligations-mismatch`: the prior obligations do not match the persisted digest.
 * - `not-waivable`: no waiver can authorize a weakening of the prior obligations.
 * - `waiver-required`: a weakening has no applicable, unexpired, authorized waiver.
 */
export type ReassessmentRejectionReason =
  | 'attempt-not-found'
  | 'no-frozen-set'
  | 'prior-obligations-mismatch'
  | 'not-waivable'
  | 'waiver-required';

/** A reassessment that failed closed — NOTHING was appended, the frozen set stands. */
export interface ReassessmentRejected {
  readonly outcome: 'weakening-blocked' | 'not-reassessable';
  readonly reason: ReassessmentRejectionReason;
  readonly priorRequirementSetDigest?: ContentDigestV1;
  readonly newRequirementSetDigest: ContentDigestV1;
  readonly weakenedRequirementIds: readonly RequirementId[];
}

export type ReassessmentResult = ReassessmentApplied | ReassessmentRejected;

/**
 * Fails a reassessment closed from inside the `decideOnce` closure.
 * `decideOnce` cannot commit zero events. Thus the throw aborts the transaction, and the command returns a {@link ReassessmentRejected}.
 */
class ReassessmentRejectedSignal extends Error {
  constructor(
    readonly outcome: ReassessmentRejected['outcome'],
    readonly reason: ReassessmentRejectionReason,
    readonly priorRequirementSetDigest: ContentDigestV1 | undefined,
  ) {
    super(`reassessment failed closed: ${reason}`);
    this.name = 'ReassessmentRejectedSignal';
  }
}

/**
 * Re-evaluates a phase attempt under an explicit new policy version.
 * The transaction checks the prior obligations against the persisted frozen set.
 * Then it appends the reassessment record, and the new generation when the set changed.
 * Without drift, the new generation is not appended, because a duplicate generation under another policy version contests the fold.
 */
export async function runReassessment(
  input: ReassessmentInput,
): Promise<ReassessmentResult> {
  const approvalClassOpt =
    input.approvalClass !== undefined ? { approvalClass: input.approvalClass } : {};

  const priorFrozen: FrozenRequirementSetProjection = freezeRequirements({
    resolved: input.priorObligations,
    phaseAttemptId: input.phaseAttemptId,
    subject: input.subject,
    ...approvalClassOpt,
  });
  const newFrozen: FrozenRequirementSetProjection = freezeRequirements({
    resolved: input.newObligations,
    phaseAttemptId: input.phaseAttemptId,
    subject: input.subject,
    ...approvalClassOpt,
  });

  const priorDigest = priorFrozen.requirementSetDigest;
  const newDigest = newFrozen.requirementSetDigest;
  const drift = digestKey(newDigest) !== digestKey(priorDigest);

  const weakened = !atLeastAsStrong(input.newObligations, input.priorObligations);
  const newIds = new Set<string>(
    newFrozen.requirements.map((requirement) => requirement.requirementId),
  );
  const weakenedRequirementIds: readonly RequirementId[] = priorFrozen.requirements
    .filter((requirement) => !newIds.has(requirement.requirementId))
    .map((requirement) => requirement.requirementId);

  const waivers = input.waivers ?? [];
  const appliedWaiverIds = new Set<WaiverId>();
  let waiverBlock: ReassessmentRejectionReason | null = null;
  if (weakened) {
    if (!input.priorObligations.waivable) {
      waiverBlock = 'not-waivable';
    } else {
      for (const requirementId of weakenedRequirementIds) {
        const waiver = selectApplicableWaiver(
          waivers,
          { requirementId, subject: input.subject, phaseAttemptId: input.phaseAttemptId },
          { evaluatedAt: input.evaluatedAt, waivable: true, authority: input.authority },
        );
        if (waiver === undefined) {
          waiverBlock = 'waiver-required';
          break;
        }
        appliedWaiverIds.add(waiver.waiverId);
      }
    }
  }

  const provenance: GenerationProvenance = {
    operationId: input.operationId,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    policyDigest: input.policyDigest,
    resolvedAt: input.evaluatedAt,
  };
  const inputDigest = generationInputDigest(
    newFrozen,
    input.phaseAttemptId,
    input.subject,
    provenance,
  );
  const reassessmentId = `reassessment.${sha256Hex(
    `${String(input.operationId)}\u0000${String(input.priorDecisionId)}\u0000${newDigest.value}`,
  ).slice(0, 40)}`;

  const successEvents = (): readonly EventInput[] => {
    const events: EventInput[] = [];
    if (drift) {
      events.push(
        ...buildRequirementResolvedEvents(
          newFrozen,
          input.phaseAttemptId,
          input.subject,
          provenance,
        ),
      );
    }
    events.push(
      reassessmentRequestedEvent(input, {
        reassessmentId,
        inputDigest,
        waiverIds: [...appliedWaiverIds],
      }),
    );
    return events;
  };

  try {
    return await input.appender.decideOnce<ReassessmentApplied>(
      input.operationId,
      requestDigest(input, newDigest),
      (ctx) => {
        const snapshot = ctx.readStream(input.streamId);
        const fold = foldAdmissionStream(snapshot.events);
        const attempt = selectPhaseAttempt(fold, input.phaseAttemptId);
        if (attempt === null) {
          throw new ReassessmentRejectedSignal(
            'not-reassessable',
            'attempt-not-found',
            undefined,
          );
        }
        const active = attempt.frozenRequirementSet;
        if (active === null) {
          throw new ReassessmentRejectedSignal(
            'not-reassessable',
            'no-frozen-set',
            undefined,
          );
        }
        if (digestKey(active.requirementSetDigest) !== digestKey(priorDigest)) {
          throw new ReassessmentRejectedSignal(
            'not-reassessable',
            'prior-obligations-mismatch',
            active.requirementSetDigest,
          );
        }
        if (waiverBlock !== null) {
          throw new ReassessmentRejectedSignal(
            'weakening-blocked',
            waiverBlock,
            priorDigest,
          );
        }
        const events = successEvents();
        return {
          streamId: input.streamId,
          expectedSequence: input.expectedVersion,
          events: [...events],
          result: {
            outcome: 'reassessed',
            reassessmentId,
            drift,
            weakened,
            priorRequirementSetDigest: priorDigest,
            newRequirementSetDigest: newDigest,
            weakenedRequirementIds,
            appliedWaiverIds: [...appliedWaiverIds],
            appendedEventTypes: events.map((event) => event.type),
            foldIntegrity: fold.integrity,
          },
        };
      },
    );
  } catch (error) {
    if (error instanceof ReassessmentRejectedSignal) {
      return {
        outcome: error.outcome,
        reason: error.reason,
        ...(error.priorRequirementSetDigest !== undefined
          ? { priorRequirementSetDigest: error.priorRequirementSetDigest }
          : {}),
        newRequirementSetDigest: newDigest,
        weakenedRequirementIds,
      };
    }
    throw error;
  }
}

function reassessmentRequestedEvent(
  input: ReassessmentInput,
  parts: {
    readonly reassessmentId: string;
    readonly inputDigest: ContentDigestV1;
    readonly waiverIds: readonly WaiverId[];
  },
): EventInput {
  const data = AdmissionReassessmentRequestedData.parse({
    eventVersion: '1.0',
    reassessmentId: parts.reassessmentId,
    operationId: input.operationId,
    phaseAttemptId: input.phaseAttemptId,
    priorDecisionId: input.priorDecisionId,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    policyDigest: input.policyDigest,
    inputDigest: parts.inputDigest,
    subject: input.subject,
    evidenceIds: [...(input.evidenceIds ?? [])],
    waiverIds: [...parts.waiverIds],
    requestedAt: input.evaluatedAt,
    caller: input.caller,
    authorization: input.authorization,
  });
  return {
    type: ADMISSION_EVENT_TYPES.REASSESSMENT_REQUESTED,
    data: data as unknown as Record<string, unknown>,
    operationId: input.operationId,
  };
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function requestDigest(input: ReassessmentInput, newDigest: ContentDigestV1): string {
  return `sha256:${newDigest.value}:${input.streamId}:${String(
    input.phaseAttemptId,
  )}:${String(input.priorDecisionId)}:${String(input.operationId)}:${input.expectedVersion}`;
}
