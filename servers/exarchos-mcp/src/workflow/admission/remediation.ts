// ─── P06-06 / Transition tasks 025, 026 — Safe, schema-constrained remediation ─
//
// Every admission DENIAL must terminate in exactly one of two things — there is
// no third "unexplained denial" case:
//
//   (a) a SAFE actionable verb the caller can LEGITIMATELY perform, or
//   (b) a STABLE terminal reason explaining why nothing safe can be done.
//
// The load-bearing constraint (the P06-06 exit proof, reinforcing P07-05): a
// remediation is DATA, never a mutation. It tells the caller which legitimate
// action to take — run the gate, obtain the approval, request a scoped waiver —
// and NEVER itself flips a requirement to satisfied, rewrites failed evidence,
// or advances a phase. The safe verbs are deliberately the *producing* /
// *requesting* verbs (`run_gate`, `request_approval`, `collect_evidence`,
// `request_waiver`, `retry_transition`): each yields a fresh HONEST evaluation
// on the next attempt; none can shortcut state into a passing shape.
//
// `remediateDenial` is TOTAL over {@link PolicyDenyReason}: the `switch` ends in
// `assertNever(reason)`, so adding a deny reason without mapping it to a verb or
// a terminal reason is a COMPILE error, not a runtime surprise.
//
// Emitted actions are validated against the LIVE `next_actions` schema
// ({@link NextAction}) at construction, so a shape that does not conform throws
// here rather than escaping into an envelope.
//
// Pure: no I/O, no clock, no state access. The module's import surface is
// asserted mutation-free by {@link module:remediation-purity} (structural census).

import { assertNever, type StableErrorCode } from '../../contract/error-families.js';
import { NextAction } from '../../next-action.js';
import type { PolicyDenyReason } from './policy-evaluation.js';
import type { AdmissionRequirementV1, PhaseAttemptId } from './types.js';

// ─── The safe verb vocabulary ────────────────────────────────────────────────

/**
 * The closed set of `next_actions` verbs a remediation may emit. Every one is a
 * *producing* or *requesting* verb whose effect is a fresh honest re-evaluation
 * — none writes admission state. The disjoint {@link STATE_MUTATION_VERBS}
 * deny-list names the shapes a remediation must NEVER take (a direct pass-state
 * fix), and the two sets are asserted disjoint in the remediation suite.
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
 * Verbs that would MUTATE admission state into a passing shape. A remediation
 * that ever emitted one of these would be a "direct pass-state fix" — exactly
 * what PROGRAM-06/07 deletes. Named here so the disjointness is testable, not
 * merely asserted in prose.
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

// ─── Runtime-iterable deny-reason census (compile-time exhaustive) ───────────

/**
 * Every {@link PolicyDenyReason}, as a runtime-iterable list. The `satisfies
 * Record<PolicyDenyReason, true>` makes the table EXHAUSTIVE at compile time:
 * omitting a reason is a missing-property error, and an unknown key is an
 * excess-property error. The exit-proof suite iterates this to prove every
 * reason yields a safe verb or a terminal reason with no gaps.
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

// ─── Stable terminal reasons (aligned to the P03-02 error registry) ──────────

/** One "nothing safely actionable" leaf, aligned to a stable contract code. */
export interface TerminalReasonSpec {
  /** A code from the P03-02 `STABLE_ERROR_REGISTRY`; NOT a parallel vocabulary. */
  readonly stableErrorCode: StableErrorCode;
  readonly summary: string;
}

/**
 * The stable terminal reasons. Each aligns to an existing
 * {@link import('../../contract/error-families.js').StableErrorCode} — admission
 * denials are authorization failures, so they map to `AUTHORIZATION_DENIED`
 * rather than inventing a parallel code vocabulary.
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

// ─── The remediation outcome algebra ─────────────────────────────────────────

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

// ─── Stable reason alignment ─────────────────────────────────────────────────

/**
 * Map a fine-grained {@link PolicyDenyReason} to its aligned stable contract
 * code. Every admission denial is an authorization failure at the contract
 * layer, so all reasons project onto `AUTHORIZATION_DENIED` — the explanation
 * keeps the refined `PolicyDenyReason` too, but never invents a top-level code.
 *
 * Total over `PolicyDenyReason` (ends in `assertNever`): adding a reason without
 * an aligned code fails to compile.
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

// ─── Action constructors (schema-validated) ──────────────────────────────────

/** Validate a candidate action against the LIVE `next_actions` schema. */
function validated(candidate: {
  readonly verb: SafeRemediationVerb;
  readonly reason: string;
  readonly validTargets?: readonly string[];
  readonly hint?: string;
}): NextAction {
  return NextAction.parse(candidate);
}

/**
 * The safe *producing* verb for a requirement, chosen by its kind — never by
 * the reason. Producing fresh, honest evidence is what actually re-opens the
 * requirement; it does not mark it satisfied. Total over the requirement kind.
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
 * The safe *requesting* verb for a structural failure a caller cannot honestly
 * out-produce (`unauthorized` / `contradictory`) but that IS waivable: ask an
 * authorized actor for a scoped, expiring waiver. Requesting a waiver records
 * no waiver and never rewrites the failed evidence.
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

// ─── The total remediation map ───────────────────────────────────────────────

/**
 * Map one denied requirement to its remediation: a safe verb or a stable
 * terminal reason — never nothing, never a state mutation.
 *
 * Producible reasons (`missing` / `failed` / `stale` / `malformed`) are closed
 * by producing fresh, honest evidence of the SAME requirement. Structural
 * reasons (`unauthorized` / `contradictory`) cannot be honestly out-produced in
 * band, so the only caller-safe verb is to REQUEST a waiver — and when the
 * requirement is not waivable there is genuinely nothing safe to do, which is a
 * stable terminal reason (aligned to `AUTHORIZATION_DENIED`).
 *
 * TOTAL over {@link PolicyDenyReason}: the `switch` ends in `assertNever`.
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
 * Remediation for an INDETERMINATE requirement: the evaluator could not decide,
 * so the safe verb is to re-attempt the transition (which re-evaluates
 * honestly). Never a state mutation; validated against the live schema. `target`
 * is the identifier the caller re-attempts against (the phase attempt, or the
 * requirement id if no definition is at hand).
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
