/**
 * Safe, schema-constrained remediation for admission denials.
 *
 * Each denial ends in a safe verb that the caller can perform, or in a stable
 * terminal reason. A remediation is data and never a mutation. It does not mark
 * a requirement satisfied, rewrite evidence, or advance a phase. Each action is
 * validated against the `NextAction` schema at construction. The module is pure.
 */
import { assertNever, type StableErrorCode } from '../../contract/error-families.js';
import { NextAction } from '../../next-action.js';
import type { PolicyDenyReason } from './policy-evaluation.js';
import type { AdmissionRequirementV1, PhaseAttemptId } from './types.js';

/**
 * The closed set of `next_actions` verbs that a remediation can emit. Each verb
 * produces or requests something and causes a fresh evaluation. No verb writes
 * admission state.
 */
export const SAFE_REMEDIATION_VERBS = [
  'run_gate',
  'request_approval',
  'collect_evidence',
  'request_waiver',
  'retry_transition',
] as const;
export type SafeRemediationVerb = (typeof SAFE_REMEDIATION_VERBS)[number];

/**
 * Verbs that change admission state into a passing shape. A remediation must never
 * emit one. The list exists so that a test can prove it is disjoint from the safe verbs.
 */
export const STATE_MUTATION_VERBS = [
  'mark_satisfied',
  'set_requirement_satisfied',
  'advance_phase',
  'force_transition',
  'override_evidence',
  'rewrite_evidence',
  'write_evidence',
  'grant_waiver',
  'approve_requirement',
] as const;

/**
 * Every {@link PolicyDenyReason} as a table. The `satisfies` clause makes a
 * missing or unknown reason a compile error.
 */
const DENY_REASON_TABLE = {
  missing: true,
  failed: true,
  stale: true,
  malformed: true,
  contradictory: true,
  unauthorized: true,
} as const satisfies Record<PolicyDenyReason, true>;

export const POLICY_DENY_REASONS: readonly PolicyDenyReason[] = Object.freeze(
  Object.keys(DENY_REASON_TABLE) as PolicyDenyReason[],
);

/** One "nothing safely actionable" leaf, aligned to a stable contract code. */
export interface TerminalReasonSpec {
  /** A code from the `STABLE_ERROR_REGISTRY`. */
  readonly stableErrorCode: StableErrorCode;
  readonly summary: string;
}

/**
 * The stable terminal reasons. Each maps to an existing
 * {@link import('../../contract/error-families.js').StableErrorCode}.
 */
export const REMEDIATION_TERMINAL_REASONS = {
  UNAUTHORIZED_PRODUCER_UNWAIVABLE: {
    stableErrorCode: 'AUTHORIZATION_DENIED',
    summary:
      'The evidence is issued by a principal the policy authority does not ' +
      'trust, and the requirement is not waivable. An authorized producer must ' +
      're-issue the evidence out of band; the caller cannot self-authorize.',
  },
  CONTRADICTORY_EVIDENCE_UNWAIVABLE: {
    stableErrorCode: 'AUTHORIZATION_DENIED',
    summary:
      'Active evidence for the requirement contradicts itself and the ' +
      'requirement is not waivable. The contradiction must be reconciled out of ' +
      'band; producing more evidence cannot remove the recorded conflict.',
  },
  REQUIREMENT_DEFINITION_UNAVAILABLE: {
    stableErrorCode: 'INTERNAL_ERROR',
    summary:
      'The denied requirement has no frozen definition to remediate against. ' +
      'This is an internal invariant violation, not a caller-actionable state.',
  },
} as const satisfies Record<string, TerminalReasonSpec>;

export type TerminalReasonCode = keyof typeof REMEDIATION_TERMINAL_REASONS;

/** A denial remediated by a safe, schema-valid `next_actions` verb. */
export interface SafeRemediationAction {
  readonly kind: 'action';
  readonly reason: PolicyDenyReason;
  /** Validated against the live `NextAction` schema at construction. */
  readonly action: NextAction;
}

/** A denial with no safe verb — it terminates in a stable, aligned reason. */
export interface TerminalRemediation {
  readonly kind: 'terminal';
  readonly reason: PolicyDenyReason;
  readonly terminalReason: TerminalReasonCode;
  readonly stableErrorCode: StableErrorCode;
  readonly summary: string;
}

export type RemediationOutcome = SafeRemediationAction | TerminalRemediation;

export interface RemediationInput {
  readonly reason: PolicyDenyReason;
  readonly requirement: AdmissionRequirementV1;
  /** Whether the resolved obligation set permits a waiver to discharge a failure. */
  readonly waivable: boolean;
  readonly phaseAttemptId: PhaseAttemptId;
}

/**
 * Map a {@link PolicyDenyReason} to its stable contract code. Each admission
 * denial is an authorization failure, so each reason maps to `AUTHORIZATION_DENIED`.
 * A new reason without a code fails to compile.
 */
export function stableErrorCodeForDenyReason(reason: PolicyDenyReason): StableErrorCode {
  switch (reason) {
    case 'missing':
    case 'failed':
    case 'stale':
    case 'malformed':
    case 'contradictory':
    case 'unauthorized':
      return 'AUTHORIZATION_DENIED';
    default:
      return assertNever(reason, 'PolicyDenyReason');
  }
}

/** Validate a candidate action against the `NextAction` schema. */
function validated(candidate: {
  readonly verb: SafeRemediationVerb;
  readonly reason: string;
  readonly validTargets?: readonly string[];
  readonly hint?: string;
}): NextAction {
  return NextAction.parse(candidate);
}

/**
 * The safe producing verb for a requirement. The requirement kind selects the
 * verb, not the reason. The verb produces fresh evidence and does not mark the
 * requirement satisfied.
 */
function producingAction(
  requirement: AdmissionRequirementV1,
  reason: PolicyDenyReason,
): NextAction {
  switch (requirement.kind) {
    case 'gate-evidence':
      return validated({
        verb: 'run_gate',
        reason:
          `Gate requirement ${requirement.requirementId} is ${reason}; run gate ` +
          `${requirement.gateId} to produce fresh passing evidence, then re-attempt ` +
          `the transition.`,
        validTargets: [requirement.gateId],
        hint:
          'Re-running the gate re-evaluates the subject honestly; it does not ' +
          'mark the requirement satisfied.',
      });
    case 'approval':
      return validated({
        verb: 'request_approval',
        reason:
          `Approval requirement ${requirement.requirementId} is ${reason}; obtain ` +
          `${requirement.minimumApprovals} approval(s) of class ` +
          `${requirement.approvalClass} from authorized approvers, then re-attempt.`,
        validTargets: [requirement.requirementId],
        hint:
          'The approval must be recorded by an authorized approver; requesting ' +
          'it does not grant it.',
      });
    case 'corroboration':
      return validated({
        verb: 'collect_evidence',
        reason:
          `Corroboration requirement ${requirement.requirementId} is ${reason}; ` +
          `collect at least ${requirement.minimumIndependentSources} independent ` +
          `evidence sources for ${requirement.sourceRequirementId}, then re-attempt.`,
        validTargets: [requirement.sourceRequirementId],
        hint:
          'Independent sources must each produce their own evidence; collecting ' +
          'it does not fabricate corroboration.',
      });
    default:
      return assertNever(requirement, 'AdmissionRequirementV1');
  }
}

/**
 * The safe requesting verb for a waivable `unauthorized` or `contradictory` failure.
 * It asks an authorized actor for a scoped, expiring waiver. The request records
 * no waiver and does not rewrite the failed evidence.
 */
function waiverAction(
  requirement: AdmissionRequirementV1,
  phaseAttemptId: PhaseAttemptId,
  reason: PolicyDenyReason,
): NextAction {
  return validated({
    verb: 'request_waiver',
    reason:
      `Requirement ${requirement.requirementId} is ${reason} and cannot be ` +
      `satisfied by producing fresh evidence; request a scoped, expiring waiver ` +
      `from an authorized actor for phase attempt ${phaseAttemptId}.`,
    validTargets: [requirement.requirementId],
    hint:
      'A waiver is a separate authorized artifact; requesting one records no ' +
      'waiver and never rewrites the failed evidence.',
  });
}

function terminal(
  reason: PolicyDenyReason,
  code: TerminalReasonCode,
): TerminalRemediation {
  const spec = REMEDIATION_TERMINAL_REASONS[code];
  return {
    kind: 'terminal',
    reason,
    terminalReason: code,
    stableErrorCode: spec.stableErrorCode,
    summary: spec.summary,
  };
}

/**
 * Map one denied requirement to a safe verb or a stable terminal reason.
 *
 * For `missing`, `failed`, `stale`, and `malformed`, the verb produces fresh
 * evidence for the same requirement. More evidence cannot fix `unauthorized` or
 * `contradictory`, so the only safe verb requests a waiver. If the requirement is
 * not waivable, the result is a terminal reason.
 */
export function remediateDenial(input: RemediationInput): RemediationOutcome {
  const { reason, requirement, waivable, phaseAttemptId } = input;
  switch (reason) {
    case 'missing':
    case 'failed':
    case 'stale':
    case 'malformed':
      return { kind: 'action', reason, action: producingAction(requirement, reason) };
    case 'unauthorized':
      return waivable
        ? { kind: 'action', reason, action: waiverAction(requirement, phaseAttemptId, reason) }
        : terminal(reason, 'UNAUTHORIZED_PRODUCER_UNWAIVABLE');
    case 'contradictory':
      return waivable
        ? { kind: 'action', reason, action: waiverAction(requirement, phaseAttemptId, reason) }
        : terminal(reason, 'CONTRADICTORY_EVIDENCE_UNWAIVABLE');
    default:
      return assertNever(reason, 'PolicyDenyReason');
  }
}

/**
 * Remediation for an indeterminate requirement. The safe verb retries the
 * transition, which evaluates again. `target` is the phase attempt, or the
 * requirement id when no definition is available.
 */
export function remediateIndeterminate(target: string): NextAction {
  return validated({
    verb: 'retry_transition',
    reason:
      `The requirement could not be decided; re-attempt the transition for ` +
      `${target} once the evaluator inputs are available.`,
    validTargets: [target],
    hint:
      'Retrying re-runs admission and re-evaluates honestly; it does not coerce ' +
      'an undecided requirement to satisfied.',
  });
}

/** The terminal remediation used when a denied requirement has no definition. */
export function terminalForMissingDefinition(
  reason: PolicyDenyReason,
): TerminalRemediation {
  return terminal(reason, 'REQUIREMENT_DEFINITION_UNAVAILABLE');
}
