// Explains a persisted `TransitionDecided` to the caller.
// RESERVED(issue: #1590, owner: exarchos, expires: 2027-01-31): this module waits for the legacy HSM cutover.
// Until then, nothing in production produces a `TransitionDecided`.
//
// The explanation holds the requirement results, evidence ids, decision digests and policy identity.
// Each denial gets a stable reason code and a remediation: a safe verb or a stable terminal reason.
// An `allow` still shows the failures that a waiver permitted.
// Two `never` checks make a new status or verdict without an explanation a compile error.
// The module is pure data. The remediation purity census asserts that its imports reach no state mutator.

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

/** The policy identity and the content digests behind the decision. */
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

/** A failure that a waiver permitted. An `allow` lists it, so a success never hides a waived failure or its waiver. */
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
  /** The failures that a waiver permitted under an `allow`. */
  readonly waivedFailures: readonly WaivedFailureExplanation[];
  /** Every safe, schema-valid `next_actions` verb this explanation emits. */
  readonly nextActions: readonly NextAction[];
  /** Every stable terminal reason (denials with no safe verb). */
  readonly terminalReasons: readonly TerminalRemediation[];
  readonly waiverIds: readonly WaiverId[];
}

/**
 * Returns whether the obligation set was waivable, from the persisted decision only.
 * A `deny` is waivable when it carries a `request_waiver` remediation. An `allow` that waived a requirement is waivable.
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

/**
 * Explains a persisted admission decision. The function is pure and deterministic.
 * Each unsatisfied requirement gets a safe verb or a stable terminal reason.
 * Waived failures come from the durable `recordedFailures`.
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

  const waivedFailures: WaivedFailureExplanation[] = evaluation.recordedFailures
    .filter((failure) => failure.waived && failure.waiverId !== undefined)
    .map((failure) => ({
      requirementId: failure.requirementId,
      reason: failure.reason,
      stableReason: stableErrorCodeForDenyReason(failure.reason),
      waiverId: failure.waiverId as WaiverId,
      evidenceIds: failure.evidenceIds,
    }));

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
