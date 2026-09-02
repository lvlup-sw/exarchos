// ─── P06-07 / Transition task 050 — reassessment under an explicit policy ────
//
// RESERVED(issue: #1590, owner: exarchos, expires: 2027-01-31) — production
// code awaiting the legacy HSM cutover, same staging as `bootstrap-attempts.ts`.
// Reassessing an attempt's obligations presupposes admission owns them, which
// happens at P07-02 migration; P07-05 removes the legacy path.
//
// Reassessment re-evaluates an existing phase attempt's obligations under a
// NEWER, explicitly-named policy version, WITHOUT touching history. The attempt
// keeps its originally-frozen requirement generation (referenced, never
// mutated); reassessment produces a NEW frozen generation with its own
// `requirementSetDigest`, and the DRIFT between the two is explicit — the prior
// generation stays in `requirementSetHistory`, the new one becomes active.
//
// The monotonicity guarantee (P06-03), extended across policy versions
// (requirement #4): re-evaluating is free ONLY when the new obligations are AT
// LEAST AS STRONG as the frozen ones. Strength is judged by the P06-03 partial
// order `atLeastAsStrong` — never a second, ad-hoc comparison. When the new set
// is NOT at least as strong (weaker or incomparable), adopting it WEAKENS the
// attempt's obligations, and that weakening is not free: it requires an
// applicable, unexpired, AUTHORIZED waiver (the P06-04 waiver model). Without
// one, reassessment FAILS CLOSED — nothing is appended, the frozen set stands.
//
// Authenticity is load-bearing. The caller supplies the obligations the attempt
// was originally frozen under; reassessment re-freezes them and refuses to
// proceed unless their digest equals the attempt's PERSISTED active
// `requirementSetDigest`. A caller therefore cannot fabricate a strong "prior"
// to sneak a weakening past the monotonicity gate.
//
// Idempotency (requirement #5): the append is one `decideOnce` transaction keyed
// on `operationId`, so a same-key retry returns the identical recorded result.
//
// Pure decisions, then one atomic append: strength, drift, and waiver
// applicability are decided from pure inputs BEFORE the transaction; the
// transaction only reads the stream to enforce authenticity and appends.

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

// ─── Public command shape ─────────────────────────────────────────────────────

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
  /**
   * The obligations the attempt was ORIGINALLY frozen under. Re-frozen and
   * checked against the persisted active `requirementSetDigest`; a mismatch
   * fails closed. (This is P06-03's `ResolvedRequirements`, the pure lattice.)
   */
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
  /** Out-of-band trust oracle (P01-07); self-asserted roles cannot authorize. */
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

export type ReassessmentRejectionReason =
  /** No such phase attempt on the stream. */
  | 'attempt-not-found'
  /** The attempt carries no frozen requirement set to reassess. */
  | 'no-frozen-set'
  /** The supplied prior obligations do not match the persisted frozen digest. */
  | 'prior-obligations-mismatch'
  /** The prior obligations are not waivable — a weakening can never be authorized. */
  | 'not-waivable'
  /** A weakening lacked an applicable, unexpired, authorized waiver. */
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

// ─── Fail-closed signal ─────────────────────────────────────────────────────────

/**
 * Thrown from inside the `decideOnce` closure to fail a reassessment closed.
 * `decideOnce` requires at least one appended event, so a rejection cannot
 * commit zero events; the sentinel aborts the transaction (appending NOTHING)
 * and is translated into a {@link ReassessmentRejected} by the command.
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

// ─── The command ────────────────────────────────────────────────────────────────

/**
 * Re-evaluate a phase attempt under an explicit new policy version.
 *
 * Strength and waiver applicability are decided from pure inputs; the single
 * `decideOnce` transaction reads the stream to enforce that the supplied prior
 * obligations match the attempt's persisted frozen set, then appends the new
 * generation (when drift occurs) and the reassessment record. A weakening
 * without an authorized waiver, or against a not-waivable prior obligation set,
 * fails closed with nothing appended.
 */
export async function runReassessment(
  input: ReassessmentInput,
): Promise<ReassessmentResult> {
  const approvalClassOpt =
    input.approvalClass !== undefined ? { approvalClass: input.approvalClass } : {};

  // ─── Pure: freeze both generations ────────────────────────────────────────
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

  // ─── Pure: strength + weakened-away requirement ids ───────────────────────
  const weakened = !atLeastAsStrong(input.newObligations, input.priorObligations);
  const newIds = new Set<string>(
    newFrozen.requirements.map((requirement) => requirement.requirementId),
  );
  const weakenedRequirementIds: readonly RequirementId[] = priorFrozen.requirements
    .filter((requirement) => !newIds.has(requirement.requirementId))
    .map((requirement) => requirement.requirementId);

  // ─── Pure: waiver decision for a weakening ────────────────────────────────
  const waivers = input.waivers ?? [];
  const appliedWaiverIds = new Set<WaiverId>();
  let waiverBlock: ReassessmentRejectionReason | null = null;
  if (weakened) {
    if (!input.priorObligations.waivable) {
      // The strongest obligation lattice element cannot be weakened at all.
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

  // ─── Pure: the events a successful reassessment would append ──────────────
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
    // A drift adopts a NEW generation; no drift means the obligations are
    // identical, so re-freezing them would only duplicate the active generation
    // under a different policy version (which the fold would contest). Record
    // only the reassessment fact in that case.
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
        // Authenticity: the supplied prior obligations MUST match the persisted
        // frozen set, or a weakening could be judged against a fabricated prior.
        if (digestKey(active.requirementSetDigest) !== digestKey(priorDigest)) {
          throw new ReassessmentRejectedSignal(
            'not-reassessable',
            'prior-obligations-mismatch',
            active.requirementSetDigest,
          );
        }
        // Monotonicity gate: a weakening needs an authorized waiver.
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

// ─── Event construction ───────────────────────────────────────────────────────

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
