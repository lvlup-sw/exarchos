// ─── P06-07 / Transition task 050 — bootstrap existing workflows ─────────────
//
// RESERVED(issue: #1590, owner: exarchos, expires: 2027-01-31) — production
// code awaiting the legacy HSM cutover. Bootstrapping an existing workflow into
// attempts/requirements is only meaningful once admission is the authoritative
// decider (P07-02 migrates, P07-05 deletes the legacy path); running it earlier
// would append attempt state nothing consults.
//
// A workflow that predates the admission system carries no phase-attempt
// requirement state: its stream has no `admission.requirement-resolved` facts,
// so the P01-04 fold reconstructs NO frozen requirement set for the attempt.
// `runBootstrapAttempt` gives such an attempt a frozen requirement set the ONLY
// legitimate way — by APPENDING new events. It never rewrites a past event and
// never retro-stamps a `.state.json` into the desired shape.
//
// The two properties this buys, and why they hold:
//
//   1. HISTORICAL REPLAY IS UNCHANGED. Bootstrap is append-only, so any prefix
//      of the stream ending at or before the pre-bootstrap tail is byte-for-byte
//      what it was. Folding that prefix yields the identical pre-bootstrap
//      result — bootstrap adds a suffix, it never edits history.
//
//   2. NO MUTABLE BACKFILL. The frozen requirement set is derived by the SAME
//      pure pipeline the chokepoint uses (`resolveRequirements` → P06-05
//      `freezeRequirements`) and persisted as `admission.requirement-resolved`
//      facts. There is no in-place edit of any prior fact or projection.
//
// Idempotency (requirement #5): the whole append is one `decideOnce`
// transaction keyed on `operationId`, so a same-key retry returns the identical
// recorded result without re-appending. A DIFFERENT key that targets an attempt
// already carrying a frozen set is detected inside the transaction and becomes a
// no-op (`already-bootstrapped`) — bootstrapping twice can never fork one
// attempt into two.

import type { EventInput } from '../../event-store/atomic-appender.js';
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

// ─── Public command shape ─────────────────────────────────────────────────────

export interface BootstrapAttemptInput {
  readonly appender: AdmissionDecider;
  readonly streamId: string;
  readonly operationId: OperationId;
  /** The stream version the caller observed before issuing this command (OCC). */
  readonly expectedVersion: number;
  readonly phaseAttemptId: PhaseAttemptId;
  readonly subject: EvidenceSubjectV1;
  /** Normalized resolution context; resolved and frozen inside the command. */
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

// ─── No-op signal ──────────────────────────────────────────────────────────────

/**
 * Thrown from inside the `decideOnce` closure when the target attempt already
 * carries a frozen requirement set. `decideOnce` requires at least one appended
 * event, so an already-bootstrapped attempt cannot express its no-op by
 * committing zero events; instead the closure throws this sentinel, which aborts
 * the transaction (appending NOTHING) and is translated to
 * `already-bootstrapped` by the command.
 */
class AttemptAlreadyBootstrappedSignal extends Error {
  constructor(readonly requirementSetDigest: ContentDigestV1) {
    super('phase attempt already carries a frozen requirement set');
    this.name = 'AttemptAlreadyBootstrappedSignal';
  }
}

// ─── The command ────────────────────────────────────────────────────────────────

/**
 * Bootstrap a pre-existing phase attempt with a frozen requirement set, purely
 * by appending `admission.requirement-resolved` facts.
 *
 * The frozen set is resolved and frozen BEFORE the transaction (the pipeline is
 * pure and deterministic); the append happens inside one `decideOnce`. If the
 * folded prior state already carries a frozen set for the attempt, the command
 * is an idempotent no-op.
 */
export async function runBootstrapAttempt(
  input: BootstrapAttemptInput,
): Promise<BootstrapAttemptResult> {
  // ─── Pure: resolve → freeze the requirement generation (no persistence) ────
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
          // Already bootstrapped: abort the transaction, append nothing.
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

// ─── Content-addressed request digest ─────────────────────────────────────────

function requestDigest(
  input: BootstrapAttemptInput,
  requirementSetDigest: ContentDigestV1,
): string {
  return `sha256:${requirementSetDigest.value}:${input.streamId}:${String(
    input.phaseAttemptId,
  )}:${String(input.operationId)}:${input.expectedVersion}:${ADMISSION_EVENT_TYPES.REQUIREMENT_RESOLVED}`;
}
