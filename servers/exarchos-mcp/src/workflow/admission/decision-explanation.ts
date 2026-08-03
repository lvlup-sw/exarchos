// ─── P06-06 / Transition tasks 025, 026 — Explainable admission decisions ─────
//
// `explainDecision` turns a persisted {@link TransitionDecided} into a TOTAL,
// caller-facing explanation:
//
//   • per-requirement RESULTS (satisfied / waived / denied / indeterminate);
//   • EVIDENCE references (ids) and the decision DIGESTS — references, not copies;
//   • POLICY identity (policyId / policyVersion / policyDigest + set/input digests);
//   • a STABLE reason code per unsatisfied requirement (aligned to the P03-02
//     `STABLE_ERROR_REGISTRY`, not a parallel vocabulary);
//   • a REMEDIATION per denial — a safe verb or a stable terminal reason — so
//     there is NEVER an unexplained denial;
//   • WAIVED-but-recorded fidelity: a waiver-driven `allow` still surfaces which
//     failures were waived and by which waiver (P06-04's durable guarantee).
//
// Totality is enforced by two `never` checks the compiler gates:
//   1. over the {@link RequirementEvaluation} status union, and
//   2. over the {@link PolicyVerdict} union.
// Adding a status or a verdict without an explanation arm is a COMPILE error.
//
// This module is pure DATA — it never mutates state and, by construction, cannot:
// `remediation-purity.ts`'s structural census asserts its import surface reaches
// no event store / filesystem / process / transition mutator. It consumes
// `transition-command.ts` READ-ONLY, and only as a TYPE (erased at compile).

import { assertNever, type StableErrorCode } from '../../contract/error-families.js';
import type { NextAction } from '../../next-action.js';
import type {
  PolicyDenyReason,
  PolicyVerdict,
  RequirementEvaluation,
} from './policy-evaluation.js';
import {
  remediateDenial,
  remediateIndeterminate,
  stableErrorCodeForDenyReason,
  terminalForMissingDefinition,
  type RemediationOutcome,
  type TerminalRemediation,
} from './remediation.js';
import type { TransitionDecided } from './transition-command.js';
import type {
  AdmissionDecisionRecordV1,
  AdmissionIndeterminateCode,
  AdmissionRequirementV1,
  ContentDigestV1,
  DecisionId,
  EvidenceId,
  PolicyId,
  RequirementId,
  WaiverId,
} from './types.js';

// ─── Explanation shapes ──────────────────────────────────────────────────────

/** The policy identity + the content-addressed digests behind the decision. */
export interface PolicyIdentity {
  readonly policyId: PolicyId;
  readonly policyVersion: string;
  readonly policyDigest: ContentDigestV1;
  readonly requirementSetDigest: ContentDigestV1;
  readonly inputDigest: ContentDigestV1;
}

/** The per-requirement result. Evidence is referenced by id, never copied. */
export type RequirementResult =
  | {
      readonly requirementId: RequirementId;
      readonly status: 'satisfied';
      readonly evidenceIds: readonly EvidenceId[];
    }
  | {
      readonly requirementId: RequirementId;
      readonly status: 'waived';
      readonly reason: PolicyDenyReason;
      readonly stableReason: StableErrorCode;
      readonly waiverId: WaiverId;
      readonly evidenceIds: readonly EvidenceId[];
    }
  | {
      readonly requirementId: RequirementId;
      readonly status: 'denied';
      readonly reason: PolicyDenyReason;
      readonly stableReason: StableErrorCode;
      readonly evidenceIds: readonly EvidenceId[];
      readonly remediation: RemediationOutcome;
    }
  | {
      readonly requirementId: RequirementId;
      readonly status: 'indeterminate';
      readonly code: AdmissionIndeterminateCode;
      readonly evidenceIds: readonly EvidenceId[];
      readonly remediation: NextAction;
    };

/** A denied requirement paired with its (always-present) remediation. */
export interface UnsatisfiedRequirementExplanation {
  readonly requirementId: RequirementId;
  readonly reason: PolicyDenyReason;
  readonly stableReason: StableErrorCode;
  readonly evidenceIds: readonly EvidenceId[];
  readonly remediation: RemediationOutcome;
}

/**
 * A failure a waiver permitted admission DESPITE — surfaced under an `allow`
 * verdict so admission-success never hides which failures were waived, by whom.
 */
export interface WaivedFailureExplanation {
  readonly requirementId: RequirementId;
  readonly reason: PolicyDenyReason;
  readonly stableReason: StableErrorCode;
  readonly waiverId: WaiverId;
  readonly evidenceIds: readonly EvidenceId[];
}

export interface DecisionExplanation {
  readonly verdict: PolicyVerdict;
  readonly outcome: TransitionDecided['outcome'];
  readonly phaseChanged: boolean;
  readonly decisionId: DecisionId;
  readonly policyIdentity: PolicyIdentity;
  readonly requirementResults: readonly RequirementResult[];
  /** Denied requirements, each with a safe verb OR a stable terminal reason. */
  readonly unsatisfied: readonly UnsatisfiedRequirementExplanation[];
  /** Failures waived under an `allow` — the P06-04 durable audit surface. */
  readonly waivedFailures: readonly WaivedFailureExplanation[];
  /** Every safe, schema-valid `next_actions` verb this explanation emits. */
  readonly nextActions: readonly NextAction[];
  /** Every stable terminal reason (denials with no safe verb). */
  readonly terminalReasons: readonly TerminalRemediation[];
  readonly waiverIds: readonly WaiverId[];
}

// ─── Waivability derivation ──────────────────────────────────────────────────

/**
 * Whether the obligation set was WAIVABLE, derived faithfully from the persisted
 * decision (never re-guessed). The chokepoint appends a `request_waiver`
 * remediation to a `deny` record iff the set is waivable; an `allow` that waived
 * any requirement is waivable by construction. Waivability only steers the
 * remediation of a `deny`, so this derivation is exact where it matters.
 */
export function deriveWaivable(decision: AdmissionDecisionRecordV1): boolean {
  switch (decision.outcome) {
    case 'deny':
      return decision.remediation.some((action) => action.action === 'request_waiver');
    case 'allow':
      return decision.waivedRequirementIds.length > 0;
    case 'indeterminate':
      return false;
    default:
      return assertNever(decision, 'AdmissionDecisionRecordV1');
  }
}

// ─── Per-requirement explanation (total over the status union) ───────────────

function explainRequirement(
  evaluation: RequirementEvaluation,
  requirement: AdmissionRequirementV1 | undefined,
  waivable: boolean,
): RequirementResult {
  switch (evaluation.status) {
    case 'satisfied':
      return {
        requirementId: evaluation.requirementId,
        status: 'satisfied',
        evidenceIds: evaluation.evidenceIds,
      };
    case 'waived':
      return {
        requirementId: evaluation.requirementId,
        status: 'waived',
        reason: evaluation.waivedReason,
        stableReason: stableErrorCodeForDenyReason(evaluation.waivedReason),
        waiverId: evaluation.waiverId,
        evidenceIds: evaluation.evidenceIds,
      };
    case 'denied': {
      const remediation: RemediationOutcome =
        requirement === undefined
          ? terminalForMissingDefinition(evaluation.reason)
          : remediateDenial({
              reason: evaluation.reason,
              requirement,
              waivable,
              phaseAttemptId: requirement.phaseAttemptId,
            });
      return {
        requirementId: evaluation.requirementId,
        status: 'denied',
        reason: evaluation.reason,
        stableReason: stableErrorCodeForDenyReason(evaluation.reason),
        evidenceIds: evaluation.evidenceIds,
        remediation,
      };
    }
    case 'indeterminate':
      return {
        requirementId: evaluation.requirementId,
        status: 'indeterminate',
        code: evaluation.code,
        evidenceIds: evaluation.evidenceIds,
        remediation: remediateIndeterminate(
          requirement?.phaseAttemptId ?? evaluation.requirementId,
        ),
      };
    default:
      return assertNever(evaluation, 'RequirementEvaluation');
  }
}

// ─── The total explanation function ──────────────────────────────────────────

/**
 * Explain a persisted admission decision. Total, pure, deterministic: the same
 * decided transition always yields the same explanation, and every unsatisfied
 * requirement carries a remediation that is a safe verb or a stable terminal
 * reason — there is no third "unexplained denial" case.
 */
export function explainDecision(decided: TransitionDecided): DecisionExplanation {
  const { evaluation, decision, frozenRequirements } = decided;

  const byId = new Map<string, AdmissionRequirementV1>(
    frozenRequirements.map((requirement) => [requirement.requirementId, requirement]),
  );
  const waivable = deriveWaivable(decision);

  const policyIdentity: PolicyIdentity = {
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    policyDigest: decision.policyDigest,
    requirementSetDigest: decision.requirementSetDigest,
    inputDigest: decision.inputDigest,
  };

  const requirementResults: RequirementResult[] = [];
  const unsatisfied: UnsatisfiedRequirementExplanation[] = [];
  const nextActions: NextAction[] = [];
  const terminalReasons: TerminalRemediation[] = [];

  for (const requirementEvaluation of evaluation.requirementEvaluations) {
    const result = explainRequirement(
      requirementEvaluation,
      byId.get(requirementEvaluation.requirementId),
      waivable,
    );
    requirementResults.push(result);

    if (result.status === 'denied') {
      unsatisfied.push({
        requirementId: result.requirementId,
        reason: result.reason,
        stableReason: result.stableReason,
        evidenceIds: result.evidenceIds,
        remediation: result.remediation,
      });
      if (result.remediation.kind === 'action') {
        nextActions.push(result.remediation.action);
      } else {
        terminalReasons.push(result.remediation);
      }
    } else if (result.status === 'indeterminate') {
      nextActions.push(result.remediation);
    }
  }

  // Waived failures come from the durable `recordedFailures` (waived: true) — the
  // P06-04 proof that admission-despite-failure never rewrites the evidence.
  const waivedFailures: WaivedFailureExplanation[] = evaluation.recordedFailures
    .filter((failure) => failure.waived && failure.waiverId !== undefined)
    .map((failure) => ({
      requirementId: failure.requirementId,
      reason: failure.reason,
      stableReason: stableErrorCodeForDenyReason(failure.reason),
      waiverId: failure.waiverId as WaiverId,
      evidenceIds: failure.evidenceIds,
    }));

  // Totality over the verdict union — adding a verdict without an arm is a
  // compile error. Each arm asserts the shape invariant it must uphold.
  switch (evaluation.verdict) {
    case 'allow':
    case 'deny':
    case 'indeterminate':
      break;
    default:
      return assertNever(evaluation.verdict, 'PolicyVerdict');
  }

  return Object.freeze({
    verdict: evaluation.verdict,
    outcome: decided.outcome,
    phaseChanged: decided.phaseChanged,
    decisionId: decision.decisionId,
    policyIdentity,
    requirementResults: Object.freeze(requirementResults),
    unsatisfied: Object.freeze(unsatisfied),
    waivedFailures: Object.freeze(waivedFailures),
    nextActions: Object.freeze(nextActions),
    terminalReasons: Object.freeze(terminalReasons),
    waiverIds: evaluation.appliedWaiverIds,
  });
}
