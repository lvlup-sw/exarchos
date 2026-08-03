// ─── P07-01 / Transition tasks 027, 051 — The cutover gate ────────────────────
//
// RESERVED(issue: #1590, owner: exarchos, expires: 2027-01-31) — production
// code awaiting live shadow evidence. The gate is deliberately not yet consulted
// by a production caller: it can only be satisfied once P07-02 wires the live
// `shadowObserver` into the built-in workflows and accumulates >=20 live
// attempts across every phase kind with both allow and deny outcomes. Consulting
// it before that evidence exists would be the exact premature cutover it is
// designed to prevent. P07-05 retires it together with the legacy path.
//
// The gate that decides whether enforcement may flip from the legacy HSM guard
// path to the evidence-backed admission engine. Enforcement may flip ONLY when
// every one of four INDEPENDENT conditions holds (dogfood exit criterion 16):
//
//   1. deterministic-corpus-clean — ZERO unexplained disagreements across the
//      P06-01 legacy-guard corpus run in shadow mode. Explained disagreements
//      (known legacy defects) do NOT block; only `unexplained` ones do.
//   2. live-attempt-threshold    — at least {@link MINIMUM_LIVE_ATTEMPTS} live
//      shadow attempts recorded.
//   3. phase-kind-coverage       — every {@link PhaseKind} exercised by the live
//      attempts (no phase kind left unobserved).
//   4. outcome-coverage          — both `allow` AND `deny` outcomes present in
//      the live attempts (a corpus that only ever allowed, or only ever denied,
//      proves nothing about the deny path).
//
// The conditions are modelled independently and the report names exactly which
// are unmet, so a caller (and a test) can drive any single one red.
//
// Enforcement enablement is itself EVENT-SOURCED (plan Wave E — "enforcement
// enablement through an event-sourced decision"): flipping enforcement is not a
// config edit, it is a recorded `admission.rollout-decision` followed, only when
// the gate is satisfied, by an `admission.enforcement-enabled` fact. This module
// refuses to build an enablement fact for an unsatisfied gate, so the gate
// structurally gates the flip.

import {
  AdmissionEnforcementEnabledData,
  AdmissionRolloutDecisionData,
  type AdmissionEnforcementEnabled,
  type AdmissionRolloutDecision,
} from '../../event-store/schemas.js';
import type { PhaseKind } from '../phase-kind.js';
import {
  summarizeShadowDecisions,
  type ShadowDecisionRecord,
  type ShadowProvenance,
} from './shadow-decision.js';
import type {
  ContentDigestV1,
  EvidenceId,
  OperationId,
  PolicyId,
} from './types.js';

// ─── Phase-kind universe ───────────────────────────────────────────────────────

/**
 * Every {@link PhaseKind}, kept exhaustive by the `satisfies Record<PhaseKind,
 * true>` witness: adding a kind to the union without adding it here is a compile
 * error, so `phase-kind-coverage` can never silently drop a kind.
 */
const PHASE_KIND_PRESENCE = {
  IMPLEMENT: true,
  PLAN: true,
  REVIEW: true,
  SYNTHESIZE: true,
  MERGE: true,
  GATHER: true,
} as const satisfies Record<PhaseKind, true>;

export const ALL_PHASE_KINDS: readonly PhaseKind[] = Object.freeze(
  Object.keys(PHASE_KIND_PRESENCE) as PhaseKind[],
);

/** The minimum number of live shadow attempts the gate demands. */
export const MINIMUM_LIVE_ATTEMPTS = 20;

// ─── Inputs ─────────────────────────────────────────────────────────────────

/** The enforcement outcome the legacy path produced for a live attempt. */
export type LiveAttemptOutcome = 'allow' | 'deny';

/** One recorded live shadow attempt (the coverage substrate for the gate). */
export interface LiveShadowAttempt {
  readonly phaseKind: PhaseKind;
  readonly outcome: LiveAttemptOutcome;
}

/** Everything the gate weighs. */
export interface CutoverGateEvidence {
  /** Shadow records from the deterministic P06-01 corpus run. */
  readonly corpusRecords: readonly ShadowDecisionRecord[];
  /** Live shadow attempts observed against real workflows. */
  readonly liveAttempts: readonly LiveShadowAttempt[];
}

// ─── Report ─────────────────────────────────────────────────────────────────

export type GateConditionId =
  | 'deterministic-corpus-clean'
  | 'live-attempt-threshold'
  | 'phase-kind-coverage'
  | 'outcome-coverage';

export interface GateCondition {
  readonly id: GateConditionId;
  readonly met: boolean;
  readonly detail: string;
}

export interface CutoverGateReport {
  /** True iff EVERY condition is met. */
  readonly satisfied: boolean;
  readonly conditions: readonly GateCondition[];
  /** The ids of the conditions that are NOT met (empty iff satisfied). */
  readonly unmet: readonly GateConditionId[];
  // ── Derived facts, surfaced so callers need not recompute ──
  readonly unexplainedDisagreements: number;
  readonly liveAttemptCount: number;
  readonly coveredPhaseKinds: readonly PhaseKind[];
  readonly missingPhaseKinds: readonly PhaseKind[];
  readonly hasAllowOutcome: boolean;
  readonly hasDenyOutcome: boolean;
}

// ─── Gate evaluation (pure) ────────────────────────────────────────────────────

/**
 * Evaluate the four cutover conditions independently and fold them into a
 * report. Pure and total: no I/O, no clock, deterministic ordering.
 */
export function evaluateCutoverGate(
  evidence: CutoverGateEvidence,
): CutoverGateReport {
  const summary = summarizeShadowDecisions(evidence.corpusRecords);
  const unexplainedDisagreements = summary.unexplained;

  const liveAttemptCount = evidence.liveAttempts.length;

  const covered = new Set<PhaseKind>();
  let hasAllowOutcome = false;
  let hasDenyOutcome = false;
  for (const attempt of evidence.liveAttempts) {
    covered.add(attempt.phaseKind);
    if (attempt.outcome === 'allow') hasAllowOutcome = true;
    else hasDenyOutcome = true;
  }
  const coveredPhaseKinds = ALL_PHASE_KINDS.filter((k) => covered.has(k));
  const missingPhaseKinds = ALL_PHASE_KINDS.filter((k) => !covered.has(k));

  const conditions: readonly GateCondition[] = [
    {
      id: 'deterministic-corpus-clean',
      met: unexplainedDisagreements === 0,
      detail:
        unexplainedDisagreements === 0
          ? `0 unexplained disagreements across ${summary.total} corpus fixtures ` +
            `(${summary.explained} explained, ${summary.agreements} agreements)`
          : `${unexplainedDisagreements} unexplained disagreement(s) must be ` +
            `explained or resolved before enforcement can flip`,
    },
    {
      id: 'live-attempt-threshold',
      met: liveAttemptCount >= MINIMUM_LIVE_ATTEMPTS,
      detail: `${liveAttemptCount}/${MINIMUM_LIVE_ATTEMPTS} live attempts recorded`,
    },
    {
      id: 'phase-kind-coverage',
      met: missingPhaseKinds.length === 0,
      detail:
        missingPhaseKinds.length === 0
          ? `all ${ALL_PHASE_KINDS.length} phase kinds covered`
          : `missing phase kind(s): ${missingPhaseKinds.join(', ')}`,
    },
    {
      id: 'outcome-coverage',
      met: hasAllowOutcome && hasDenyOutcome,
      detail:
        hasAllowOutcome && hasDenyOutcome
          ? 'both allow and deny outcomes present'
          : `missing outcome(s): ${[
              hasAllowOutcome ? null : 'allow',
              hasDenyOutcome ? null : 'deny',
            ]
              .filter((v): v is string => v !== null)
              .join(', ')}`,
    },
  ];

  const unmet = conditions.filter((c) => !c.met).map((c) => c.id);

  return {
    satisfied: unmet.length === 0,
    conditions,
    unmet,
    unexplainedDisagreements,
    liveAttemptCount,
    coveredPhaseKinds,
    missingPhaseKinds,
    hasAllowOutcome,
    hasDenyOutcome,
  };
}

// ─── Event-sourced enforcement enablement (plan Wave E) ────────────────────────

/** The rollout outcome — matches the `admission.rollout-decision` event enum. */
export type RolloutOutcome = 'approve-enforcement' | 'continue-shadow';

/** A satisfied gate approves enforcement; otherwise shadow mode continues. */
export function decideRollout(report: CutoverGateReport): RolloutOutcome {
  return report.satisfied ? 'approve-enforcement' : 'continue-shadow';
}

/** Trusted policy identity stamped on the recorded rollout/enablement facts. */
export interface CutoverPolicyRef {
  readonly policyId: PolicyId;
  readonly policyVersion: string;
  readonly policyDigest: ContentDigestV1;
  readonly inputDigest: ContentDigestV1;
}

export interface RolloutDecisionEventInput {
  readonly report: CutoverGateReport;
  readonly rolloutDecisionId: string;
  readonly operationId: OperationId;
  readonly policy: CutoverPolicyRef;
  readonly evidenceIds: readonly EvidenceId[];
  readonly shadowEvidenceDigest: ContentDigestV1;
  readonly decidedAt: string;
  readonly provenance: ShadowProvenance;
}

/**
 * Build a schema-validated `admission.rollout-decision` payload. The recorded
 * outcome is derived from the gate report, so the rollout decision is a
 * FUNCTION of the evidence, never a free-standing assertion.
 */
export function toRolloutDecisionData(
  input: RolloutDecisionEventInput,
): AdmissionRolloutDecision {
  const {
    report,
    rolloutDecisionId,
    operationId,
    policy,
    evidenceIds,
    shadowEvidenceDigest,
    decidedAt,
    provenance,
  } = input;
  return AdmissionRolloutDecisionData.parse({
    eventVersion: '1.0',
    rolloutDecisionId,
    operationId,
    outcome: decideRollout(report),
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    policyDigest: policy.policyDigest,
    inputDigest: policy.inputDigest,
    evidenceIds,
    shadowEvidenceDigest,
    decidedAt,
    caller: provenance.caller,
    authorization: provenance.authorization,
  });
}

export interface EnforcementEnabledEventInput {
  readonly report: CutoverGateReport;
  readonly enablementId: string;
  readonly operationId: OperationId;
  readonly rolloutDecisionId: string;
  readonly policy: CutoverPolicyRef;
  readonly enabledAt: string;
  readonly provenance: ShadowProvenance;
}

/**
 * Raised when an enforcement-enabled fact is requested for an UNSATISFIED gate.
 * This is the structural guarantee that the gate gates the flip: you cannot
 * event-source enablement past an unmet condition.
 */
export class CutoverGateNotSatisfiedError extends Error {
  readonly unmet: readonly GateConditionId[];
  constructor(unmet: readonly GateConditionId[]) {
    super(
      `cutover gate is not satisfied — cannot enable enforcement; unmet: ${unmet.join(
        ', ',
      )}`,
    );
    this.name = 'CutoverGateNotSatisfiedError';
    this.unmet = unmet;
  }
}

/**
 * Build a schema-validated `admission.enforcement-enabled` payload. Refuses
 * (throws {@link CutoverGateNotSatisfiedError}) unless the gate report is
 * satisfied — enforcement enablement is only ever recorded behind a green gate.
 */
export function toEnforcementEnabledData(
  input: EnforcementEnabledEventInput,
): AdmissionEnforcementEnabled {
  const {
    report,
    enablementId,
    operationId,
    rolloutDecisionId,
    policy,
    enabledAt,
    provenance,
  } = input;
  if (!report.satisfied) {
    throw new CutoverGateNotSatisfiedError(report.unmet);
  }
  return AdmissionEnforcementEnabledData.parse({
    eventVersion: '1.0',
    enablementId,
    operationId,
    rolloutDecisionId,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    policyDigest: policy.policyDigest,
    inputDigest: policy.inputDigest,
    enabledAt,
    caller: provenance.caller,
    authorization: provenance.authorization,
  });
}
