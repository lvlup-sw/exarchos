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
// every one of six INDEPENDENT conditions holds (dogfood exit criterion 16;
// conditions 5 and 6 are DR-23 / T-32):
//
//   1. deterministic-corpus-clean — ZERO unexplained disagreements across the
//      P06-01 legacy-guard corpus run in shadow mode. Explained disagreements
//      (known legacy defects) do NOT block; only `unexplained` ones do.
//   2. live-attempt-threshold    — at least {@link MINIMUM_LIVE_ATTEMPTS}
//      COMPARABLE live shadow attempts recorded.
//   3. phase-kind-coverage       — every {@link PhaseKind} exercised by the
//      comparable live attempts (no phase kind left unobserved).
//   4. outcome-coverage          — both `allow` AND `deny` outcomes present in
//      the comparable live attempts (a corpus that only ever allowed, or only
//      ever denied, proves nothing about the deny path).
//   5. live-disagreement-class   — durable shadow evidence EXISTS and every
//      recorded attempt, in the durable substrate and in memory, carries a
//      comparable admission verdict. An attempt whose adjudication threw or came
//      back `indeterminate` is not a comparison and cannot count as one.
//   6. live-observer-health      — the observer that produced the evidence is
//      HEALTHY, not dead or lossy. A dead observer's empty evidence stream must
//      never be read as a clean one.
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

// ─── DR-23 / T-32: the gate reads the DURABLE evidence and the observer's health
//
// Two of DR-23's three acceptance bullets land here:
//   * "a gate condition reads live disagreement class" — the live conditions no
//     longer read only the LEGACY verdict. Every {@link LiveShadowAttempt} now
//     carries the {@link DisagreementClass} the shadow runner assigned, and
//     `evaluateCutoverGate` counts only COMPARABLE attempts (ones where the
//     admission engine actually produced a verdict to compare). The audited
//     defect — "20 attempts that all threw would satisfy three of four
//     conditions" — is exactly what that closes: an attempt whose adjudication
//     threw is `shadow-error`, contributes nothing to the threshold or to either
//     coverage condition, and independently fails `live-disagreement-class`.
//   * "a dead observer is DETECTED, not silently zero" — `live-observer-health`
//     reads the observer's health counter. A process that observed transitions
//     and landed no durable evidence reads as `dead`, and a dead observer can
//     never present as a clean gate.
//
// The disagreement evidence the gate weighs is read back from the DURABLE
// sidecar stream (`<featureId>/admission-shadow`), not from the process-scoped
// in-memory ring buffer: a buffer that is empty after a restart cannot tell "no
// disagreements" from "the observer never ran", which is the INV-1 violation
// DR-23 exists to close.

import {
  AdmissionEnforcementEnabledData,
  AdmissionRolloutDecisionData,
  AdmissionShadowAttemptData,
  type AdmissionEnforcementEnabled,
  type AdmissionRolloutDecision,
} from '../../events/schemas.js';
import type { PhaseKind } from '../phase-kind.js';
import {
  liveShadowEvidenceStreamId,
  liveShadowObserverStatus,
  type LiveShadowHealth,
  type LiveShadowObserverStatus,
} from './live-shadow-observer.js';
import {
  classifyShadowOutcome,
  summarizeShadowDecisions,
  type DisagreementClass,
  type ShadowDispositionView,
  type ShadowProvenance,
} from './shadow-decision.js';
import {
  ADMISSION_EVENT_TYPES,
  type ContentDigestV1,
  type EvidenceId,
  type OperationId,
  type PolicyId,
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

/**
 * The disagreement classes that represent a REAL comparison — the admission
 * engine produced a verdict that could be held against the legacy one.
 *
 * `shadow-error` (the adjudication threw) and `admission-indeterminate` (the
 * engine could not decide) are deliberately NOT here: neither is evidence that
 * admission agrees with, or defensibly differs from, the legacy path, so
 * neither may be spent as coverage towards a cutover.
 */
const COMPARABLE_CLASSES: ReadonlySet<DisagreementClass> = new Set([
  'agree',
  'legacy-allow-admission-deny',
  'legacy-deny-admission-allow',
]);

/** True iff the class records an admission verdict comparable to the legacy one. */
export function isComparableShadowClass(cls: DisagreementClass): boolean {
  return COMPARABLE_CLASSES.has(cls);
}

/** One recorded live shadow attempt (the coverage substrate for the gate). */
export interface LiveShadowAttempt {
  readonly phaseKind: PhaseKind;
  /** The LEGACY verdict. Alone it says nothing about the admission engine. */
  readonly outcome: LiveAttemptOutcome;
  /**
   * DR-23 / T-32 — how the admission engine's verdict related to the legacy one.
   * Required: an attempt recorded without a class cannot be distinguished from
   * one whose adjudication threw, and that ambiguity is the audited defect.
   */
  readonly disagreementClass: DisagreementClass;
}

/**
 * One `admission.shadow-attempt` fact read back OUT of the durable sidecar
 * stream. The registered event carries the legacy outcome and the persisted
 * admission decision; the class is DERIVED from that pair by the same
 * {@link classifyShadowOutcome} the live path uses, so the durable reading and
 * the in-memory one cannot drift into two different classifiers.
 *
 * `phaseKind` is absent because the registered `admission.shadow-attempt` schema
 * does not carry it — see `readDurableShadowAttempts`.
 */
export interface DurableShadowAttemptFact {
  readonly legacyOutcome: LiveAttemptOutcome;
  readonly disagreementClass: DisagreementClass;
}

/** The `EventStore` slice the gate needs to read the durable shadow substrate. */
export interface DurableShadowEvidenceReader {
  query(
    streamId: string,
    filters?: { type?: string | undefined } | undefined,
  ): Promise<readonly { readonly type: string; readonly data?: unknown }[]>;
}

/**
 * Read the durable shadow-attempt facts for the given features out of their
 * SIDECAR evidence streams and derive each attempt's disagreement class.
 *
 * This — not the process-scoped ring buffer — is the substrate the gate's
 * disagreement-class condition is meant to weigh: a buffer that is empty after a
 * restart cannot distinguish "no disagreements" from "the observer never ran".
 *
 * A persisted event that fails schema validation is DROPPED rather than
 * defaulted: unreadable evidence is not evidence, and silently coercing it to
 * `agree` would be the same vacuity in a new place.
 */
export async function readDurableShadowAttempts(
  reader: DurableShadowEvidenceReader,
  featureIds: readonly string[],
): Promise<readonly DurableShadowAttemptFact[]> {
  const facts: DurableShadowAttemptFact[] = [];
  for (const featureId of featureIds) {
    const events = await reader.query(liveShadowEvidenceStreamId(featureId), {
      type: ADMISSION_EVENT_TYPES.SHADOW_ATTEMPT,
    });
    for (const event of events) {
      if (event.type !== ADMISSION_EVENT_TYPES.SHADOW_ATTEMPT) continue;
      const parsed = AdmissionShadowAttemptData.safeParse(event.data);
      if (!parsed.success) continue;
      facts.push({
        legacyOutcome: parsed.data.legacyOutcome,
        disagreementClass: classifyShadowOutcome(parsed.data.legacyOutcome, {
          status: 'evaluated',
          verdict: parsed.data.decision.outcome,
        }),
      });
    }
  }
  return facts;
}

/** Everything the gate weighs. */
export interface CutoverGateEvidence {
  /**
   * Disposition-bearing shadow records. In tests this is the deterministic
   * P06-01 corpus run; in the production assembly (#1739,
   * `evidence-reader.ts`) it is the DURABLE attempt+disposition fold, so an
   * undisposed live disagreement blocks `deterministic-corpus-clean` until a
   * human records an explained `admission.disagreement-disposition`.
   */
  readonly corpusRecords: readonly ShadowDispositionView[];
  /** Live shadow attempts observed against real workflows. */
  readonly liveAttempts: readonly LiveShadowAttempt[];
  /**
   * DR-23 — the same attempts as read back from the DURABLE sidecar streams.
   * Required, so a caller cannot justify a cutover on process-scoped memory.
   */
  readonly durableAttempts: readonly DurableShadowAttemptFact[];
  /**
   * DR-23 — the observer's health reading. Required, so "no evidence" always
   * arrives with the answer to "was anyone watching?".
   */
  readonly observerHealth: LiveShadowHealth;
}

// ─── Report ─────────────────────────────────────────────────────────────────

export type GateConditionId =
  | 'deterministic-corpus-clean'
  | 'live-attempt-threshold'
  | 'phase-kind-coverage'
  | 'outcome-coverage'
  | 'live-disagreement-class'
  | 'live-observer-health';

export interface GateCondition {
  readonly id: GateConditionId;
  readonly met: boolean;
  readonly detail: string;
}

/** A count per {@link DisagreementClass}; every class is always present. */
export type DisagreementClassTally = Readonly<Record<DisagreementClass, number>>;

export interface CutoverGateReport {
  /** True iff EVERY condition is met. */
  readonly satisfied: boolean;
  readonly conditions: readonly GateCondition[];
  /** The ids of the conditions that are NOT met (empty iff satisfied). */
  readonly unmet: readonly GateConditionId[];
  // ── Derived facts, surfaced so callers need not recompute ──
  readonly unexplainedDisagreements: number;
  /** ALL live attempts, comparable or not. */
  readonly liveAttemptCount: number;
  /** Live attempts carrying a comparable admission verdict (the coverage base). */
  readonly comparableLiveAttemptCount: number;
  /** Live attempts whose admission verdict is missing (`shadow-error`) or undecided. */
  readonly nonComparableLiveAttemptCount: number;
  readonly liveDisagreementClasses: DisagreementClassTally;
  /** Attempts read back out of the durable sidecar streams. */
  readonly durableAttemptCount: number;
  readonly nonComparableDurableAttemptCount: number;
  readonly durableDisagreementClasses: DisagreementClassTally;
  readonly observerStatus: LiveShadowObserverStatus;
  readonly coveredPhaseKinds: readonly PhaseKind[];
  readonly missingPhaseKinds: readonly PhaseKind[];
  readonly hasAllowOutcome: boolean;
  readonly hasDenyOutcome: boolean;
}

// ─── Gate evaluation (pure) ────────────────────────────────────────────────────

function emptyTally(): Record<DisagreementClass, number> {
  return {
    'agree': 0,
    'legacy-allow-admission-deny': 0,
    'legacy-deny-admission-allow': 0,
    'admission-indeterminate': 0,
    'shadow-error': 0,
  };
}

function tally(
  classes: readonly DisagreementClass[],
): Record<DisagreementClass, number> {
  const counts = emptyTally();
  for (const cls of classes) counts[cls] += 1;
  return counts;
}

/**
 * Evaluate the six cutover conditions independently and fold them into a
 * report. Pure and total: no I/O, no clock, deterministic ordering.
 */
export function evaluateCutoverGate(
  evidence: CutoverGateEvidence,
): CutoverGateReport {
  const summary = summarizeShadowDecisions(evidence.corpusRecords);
  const unexplainedDisagreements = summary.unexplained;

  const liveAttemptCount = evidence.liveAttempts.length;
  // DR-23 / T-32: only attempts the admission engine actually decided count as
  // coverage. Twenty attempts that all threw are twenty non-comparisons.
  const comparableAttempts = evidence.liveAttempts.filter((a) =>
    isComparableShadowClass(a.disagreementClass),
  );
  const nonComparableLiveAttemptCount =
    liveAttemptCount - comparableAttempts.length;
  const liveDisagreementClasses = tally(
    evidence.liveAttempts.map((a) => a.disagreementClass),
  );
  const durableDisagreementClasses = tally(
    evidence.durableAttempts.map((a) => a.disagreementClass),
  );
  const nonComparableDurableAttemptCount = evidence.durableAttempts.filter(
    (a) => !isComparableShadowClass(a.disagreementClass),
  ).length;
  const observerStatus = liveShadowObserverStatus(evidence.observerHealth);

  const covered = new Set<PhaseKind>();
  let hasAllowOutcome = false;
  let hasDenyOutcome = false;
  for (const attempt of comparableAttempts) {
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
      met: comparableAttempts.length >= MINIMUM_LIVE_ATTEMPTS,
      detail:
        `${comparableAttempts.length}/${MINIMUM_LIVE_ATTEMPTS} comparable live ` +
        `attempts recorded (${liveAttemptCount} observed, ` +
        `${nonComparableLiveAttemptCount} without a comparable admission verdict)`,
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
    {
      id: 'live-disagreement-class',
      met:
        evidence.durableAttempts.length > 0 &&
        nonComparableDurableAttemptCount === 0 &&
        nonComparableLiveAttemptCount === 0,
      detail:
        evidence.durableAttempts.length === 0
          ? 'no durable shadow-attempt evidence — an empty in-memory buffer ' +
            'cannot distinguish "no disagreements" from "the observer never ran"'
          : nonComparableDurableAttemptCount > 0 || nonComparableLiveAttemptCount > 0
            ? `${nonComparableDurableAttemptCount} durable and ` +
              `${nonComparableLiveAttemptCount} live attempt(s) carry no ` +
              `comparable admission verdict (durable classes: ` +
              `${formatTally(durableDisagreementClasses)})`
            : `${evidence.durableAttempts.length} durable attempt(s), all ` +
              `comparable (${formatTally(durableDisagreementClasses)})`,
    },
    {
      id: 'live-observer-health',
      met: observerStatus === 'healthy',
      detail:
        observerStatus === 'healthy'
          ? `observer healthy: ${evidence.observerHealth.attemptsObserved} ` +
            `attempt(s) observed, ${evidence.observerHealth.appendsSucceeded} ` +
            `durable append(s) landed`
          : `observer is ${observerStatus} — ` +
            `${evidence.observerHealth.attemptsObserved} observed, ` +
            `${evidence.observerHealth.appendsSucceeded} landed, ` +
            `${evidence.observerHealth.appendsFailed} failed, ` +
            `${evidence.observerHealth.streamUnresolved} unresolved, ` +
            `${evidence.observerHealth.observationsThrew} threw`,
    },
  ];

  const unmet = conditions.filter((c) => !c.met).map((c) => c.id);

  return {
    satisfied: unmet.length === 0,
    conditions,
    unmet,
    unexplainedDisagreements,
    liveAttemptCount,
    comparableLiveAttemptCount: comparableAttempts.length,
    nonComparableLiveAttemptCount,
    liveDisagreementClasses,
    durableAttemptCount: evidence.durableAttempts.length,
    nonComparableDurableAttemptCount,
    durableDisagreementClasses,
    observerStatus,
    coveredPhaseKinds,
    missingPhaseKinds,
    hasAllowOutcome,
    hasDenyOutcome,
  };
}

function formatTally(counts: DisagreementClassTally): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([cls, n]) => `${cls}=${n}`)
    .join(', ');
}

/**
 * Assemble the gate's evidence from the DURABLE substrate and evaluate it.
 *
 * The composition seam a production caller would use: it reads the sidecar
 * shadow streams through the ordinary `EventStore` contract, folds in the
 * observer's health reading, and evaluates the six conditions.
 *
 * #1739 (cutover promotion path) supersedes the former RESERVED note: the
 * production callers are `orchestrate/cutover-readiness.ts` (the
 * `cutover_readiness` / `cutover_decide` verbs) and the observer's
 * durable-append auto-export hook (`cutover-auto-export.ts`), both assembling
 * evidence through `evidence-reader.ts`. What T-32 closed remains: the gate
 * cannot be satisfied by evidence that proves nothing.
 */
export async function assessCutoverReadiness(input: {
  readonly reader: DurableShadowEvidenceReader;
  readonly featureIds: readonly string[];
  readonly corpusRecords: readonly ShadowDispositionView[];
  readonly liveAttempts: readonly LiveShadowAttempt[];
  readonly observerHealth: LiveShadowHealth;
}): Promise<CutoverGateReport> {
  const durableAttempts = await readDurableShadowAttempts(
    input.reader,
    input.featureIds,
  );
  return evaluateCutoverGate({
    corpusRecords: input.corpusRecords,
    liveAttempts: input.liveAttempts,
    durableAttempts,
    observerHealth: input.observerHealth,
  });
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
